import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { nextSeq, type Checkpoint, type SessionId, type TurnEvent } from '@g-code/core';
import { childEnv } from './child-env.js';
import { EngineError } from './errors.js';
import type { Store } from './store.js';

const exec = promisify(execFile);

/**
 * A git directory outside the workspace whose work tree is the workspace. Git skips the workspace's own
 * `.git` and honours its `.gitignore`, so snapshots never touch the user's repository.
 */
export type ShadowRepo = { readonly gitDir: string; readonly workTree: string };

export const shadowRepoFor = (store: Store, workspace: string): ShadowRepo => ({
  gitDir: path.join(store.checkpointsDir, createHash('sha256').update(workspace).digest('hex').slice(0, 32)),
  workTree: workspace,
});

const IDENTITY = ['-c', 'user.name=g-code', '-c', 'user.email=g-code@localhost', '-c', 'commit.gpgsign=false'];

async function git(repo: ShadowRepo, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await exec(
      'git',
      ['--git-dir', repo.gitDir, '--work-tree', repo.workTree, '-c', 'core.quotePath=false', '-c', 'core.autocrlf=false', ...IDENTITY, ...args],
      { cwd: repo.workTree, env: childEnv(process.env), maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' },
    );
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new EngineError(`checkpoint git ${args[0]} failed: ${stderr || String(error)}`);
  }
}

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

export async function snapshot(repo: ShadowRepo, label: string): Promise<string> {
  if (!(await exists(repo.gitDir))) {
    await exec('git', ['init', '--quiet', '--bare', repo.gitDir], { env: childEnv(process.env) });
  }
  await git(repo, ['add', '--all', '--', '.']);
  await git(repo, ['commit', '--quiet', '--allow-empty', '--no-verify', '-m', label]);
  return (await git(repo, ['rev-parse', 'HEAD'])).trim();
}

const lines = (out: string) => out.split('\n').filter((line) => line !== '');

export async function changedBetween(repo: ShadowRepo, from: string, to: string): Promise<string[]> {
  return lines(await git(repo, ['diff', '--name-only', '--no-renames', from, to, '--']));
}

async function pruneEmpty(dir: string, root: string): Promise<void> {
  for (let current = dir; current !== root && current.startsWith(root + path.sep); current = path.dirname(current)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
  }
}

/**
 * Makes the work tree match commit `sha`: files changed since are checked out from it and files made since
 * are deleted. Running it again changes nothing. Returns the paths it touched.
 */
export async function restore(repo: ShadowRepo, sha: string): Promise<string[]> {
  const now = await snapshot(repo, `before restoring ${sha}`);
  const changes = lines(await git(repo, ['diff', '--name-status', '--no-renames', sha, now, '--'])).map((line) => {
    const [status = '', file = ''] = line.split('\t');
    return { status, file };
  });
  const added = changes.filter((c) => c.status === 'A').map((c) => c.file);
  const reverted = changes.filter((c) => c.status !== 'A').map((c) => c.file);
  if (reverted.length > 0) await git(repo, ['checkout', sha, '--', ...reverted]);
  for (const file of added) {
    const target = path.join(repo.workTree, file);
    await rm(target, { force: true });
    await pruneEmpty(path.dirname(target), repo.workTree);
  }
  return changes.map((c) => c.file).sort();
}

const lastCheckpoint = (events: readonly TurnEvent[]) =>
  events.findLast((e): e is Extract<TurnEvent, { kind: 'checkpoint' }> => e.kind === 'checkpoint');

export async function takeCheckpoint(
  repo: ShadowRepo,
  sessionId: SessionId,
  events: readonly TurnEvent[],
): Promise<Extract<TurnEvent, { kind: 'checkpoint' }>> {
  const seq = nextSeq(events);
  const turnSeq = seq + 1;
  const label = `before turn ${turnSeq}`;
  const sha = await snapshot(repo, `${sessionId} ${label}`);
  const previous = lastCheckpoint(events);
  const files = previous === undefined ? [] : await changedBetween(repo, previous.sha, sha);
  const checkpoint: Checkpoint = { sessionId, turnSeq, sha, files, label };
  return { kind: 'checkpoint', seq, at: new Date().toISOString(), ...checkpoint };
}
