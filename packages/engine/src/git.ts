import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import type { ChangedFile, CommitFacts, FileStatus } from '@g-code/core';
import { EngineError } from './errors.js';

const exec = promisify(execFile);

async function git(repo: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', ['-c', 'core.quotePath=false', '-C', repo, ...args], {
      maxBuffer: 512 * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new EngineError(`git ${args[0]} in ${repo} failed: ${stderr || String(error)}`);
  }
}

/** The working tree's changes against HEAD, staged or not. */
export const workingDiff = (repo: string): Promise<string> => git(repo, ['diff', 'HEAD']);

export const repoRoot = async (dir: string): Promise<string> =>
  (await git(dir, ['rev-parse', '--show-toplevel'])).trim();

export type CommitHeader = Omit<CommitFacts, 'files'>;

const FIELD = '\x00';
const RECORD = '\x1e';

export async function listCommits(repo: string): Promise<CommitHeader[]> {
  const out = await git(repo, [
    'log',
    '--no-merges',
    '--format=%H%x00%P%x00%s%x00%b%x1e',
    'HEAD',
  ]);
  return out
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record !== '')
    .map((record) => {
      const [sha = '', parents = '', subject = '', body = ''] = record.split(FIELD);
      return { sha, parent: parents.split(' ').find(Boolean), subject, body };
    });
}

const SPECIAL_MODES = new Set(['120000', '160000']);

function statusOf(code: string, oldMode: string, newMode: string): FileStatus {
  if (SPECIAL_MODES.has(oldMode) || SPECIAL_MODES.has(newMode)) return 'other';
  if (code === 'M') return 'modified';
  if (code === 'A') return 'added';
  if (code === 'D') return 'deleted';
  return 'other';
}

export async function changedFiles(repo: string, sha: string): Promise<ChangedFile[]> {
  const out = await git(repo, [
    'diff-tree',
    '-r',
    '--root',
    '--no-renames',
    '--no-commit-id',
    '--raw',
    '--numstat',
    sha,
  ]);
  const statuses = new Map<string, FileStatus>();
  const files: ChangedFile[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith(':')) {
      const [meta = '', path = ''] = line.slice(1).split('\t');
      const [oldMode = '', newMode = '', , , code = ''] = meta.split(' ');
      statuses.set(path, statusOf(code, oldMode, newMode));
    } else if (line !== '') {
      const [added = '', deleted = '', path = ''] = line.split('\t');
      files.push({
        path,
        status: statuses.get(path) ?? 'other',
        changedLines: added === '-' ? 'binary' : Number(added) + Number(deleted),
      });
    }
  }
  return files;
}

export const fileAt = (repo: string, rev: string, path: string): Promise<string> =>
  git(repo, ['cat-file', 'blob', `${rev}:${path}`]);

// A full clone would hand the agent the commits after `commit`, which for a history replay
// include the answer. Fetching only `commit` keeps its ancestry and leaves no remote to pull from.
export async function cloneAt(repo: string, dest: string, commit: string): Promise<void> {
  await git(dirname(dest), ['init', '--quiet', dest]);
  await git(dest, ['fetch', '--quiet', '--no-tags', repo, commit]);
  await git(dest, ['checkout', '--quiet', '--detach', 'FETCH_HEAD']);
}

export async function resetWorktree(dir: string): Promise<void> {
  await git(dir, ['checkout', '--', '.']);
  await git(dir, ['clean', '-fdq']);
}

export async function applyPatch(dir: string, patch: string): Promise<void> {
  await git(dir, ['apply', patch]);
}
