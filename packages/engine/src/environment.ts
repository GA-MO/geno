import { execFile } from 'node:child_process';
import { access, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { GIT_COMMITS, GIT_STATUS_LINES, KEY_PACKAGES, KEY_SCRIPTS, LANE_ROOT, type Environment, type GitSnapshot, type LanePlace, type ProjectFacts } from '@g-code/core';
import { laneAt } from './lanes.js';

const exec = promisify(execFile);

/** A slow repository costs the session's start at most this long per git command. */
const GIT_TIMEOUT_MS = 5000;

/** The session's scratchpad: its own folder under the real temp dir, the same path every time the session runs. */
export const scratchpadOf = async (sessionId: string): Promise<string> => path.join(await realpath(os.tmpdir()), 'gcode-sessions', sessionId);

const git = async (workspace: string, args: readonly string[]): Promise<string | undefined> => {
  try {
    const { stdout } = await exec('git', ['--no-optional-locks', '-c', 'core.quotePath=false', '-C', workspace, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch {
    return undefined;
  }
};

const linesOf = (text: string | undefined): string[] => (text ?? '').split('\n').filter((line) => line !== '');

async function gitSnapshot(workspace: string): Promise<GitSnapshot | undefined> {
  if ((await git(workspace, ['rev-parse', '--is-inside-work-tree']))?.trim() !== 'true') return undefined;
  const [branch, status, commits] = await Promise.all([
    git(workspace, ['branch', '--show-current']),
    git(workspace, ['status', '--short']),
    // A repository with no commits yet fails here, and has none to list.
    git(workspace, ['log', '--oneline', '--no-decorate', '-n', String(GIT_COMMITS)]),
  ]);
  const all = linesOf(status);
  const name = branch?.trim() ?? '';
  return { ...(name === '' ? {} : { branch: name }), status: all.slice(0, GIT_STATUS_LINES), moreStatus: Math.max(0, all.length - GIT_STATUS_LINES), commits: linesOf(commits) };
}

const packageJsonSchema = z.looseObject({
  packageManager: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
] as const;

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

async function lockfileManager(workspace: string): Promise<string | undefined> {
  for (const [file, manager] of LOCKFILES) if (await exists(path.join(workspace, file))) return manager;
  return undefined;
}

async function installedVersion(workspace: string, name: string): Promise<string | undefined> {
  try {
    const parsed = z.looseObject({ version: z.string() }).safeParse(JSON.parse(await readFile(path.join(workspace, 'node_modules', name, 'package.json'), 'utf8')));
    return parsed.success ? parsed.data.version : undefined;
  } catch {
    return undefined;
  }
}

async function projectFacts(workspace: string): Promise<ProjectFacts | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(workspace, 'package.json'), 'utf8'));
  } catch {
    // Missing or unreadable, it says nothing the model could use.
    return undefined;
  }
  const parsed = packageJsonSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { packageManager, scripts = {}, dependencies = {}, devDependencies = {} } = parsed.data;
  const declared: Readonly<Record<string, string>> = { ...devDependencies, ...dependencies };
  const keys = new Set<string>(KEY_SCRIPTS);
  const versions = await Promise.all(
    KEY_PACKAGES.filter((name) => Object.hasOwn(declared, name)).map(async (name) => [name, (await installedVersion(workspace, name)) ?? declared[name]!] as const),
  );
  // `pnpm@11.3.0+sha512.…` names the manager and its version; the hash after `+` tells the model nothing.
  const manager = packageManager?.split('+')[0]!.replace('@', ' ') ?? (await lockfileManager(workspace));
  return {
    ...(manager === undefined ? {} : { packageManager: manager }),
    scripts: KEY_SCRIPTS.filter((name) => Object.hasOwn(scripts, name)).map((name) => [name, scripts[name]!] as const),
    otherScripts: Object.keys(scripts).filter((name) => !keys.has(name)),
    versions,
  };
}

/** The lane the workspace is, asked of git only for a path that could be one. */
async function lanePlace(workspace: string): Promise<LanePlace | undefined> {
  if (!workspace.includes(`${path.sep}${LANE_ROOT}${path.sep}`)) return undefined;
  const lane = await laneAt(workspace, undefined).catch(() => undefined);
  return lane === undefined ? undefined : { name: lane.record.name, branch: lane.record.branch, main: lane.repo.main };
}

const localDate = (now: Date): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

export type EnvironmentInput = {
  readonly workspace: string;
  readonly scratchpad: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now?: Date | undefined;
};

/** The session's environment as it is now, for its session-start event. Nothing here can stop a session from starting. */
export async function captureEnvironment({ workspace, scratchpad, env, now = new Date() }: EnvironmentInput): Promise<Environment> {
  const [git, project, lane] = await Promise.all([gitSnapshot(workspace), projectFacts(workspace), lanePlace(workspace)]);
  const shell = env['SHELL'];
  return {
    date: localDate(now),
    platform: process.platform,
    osVersion: `${os.type()} ${os.release()}`,
    ...(shell === undefined || shell === '' ? {} : { loginShell: path.basename(shell) }),
    scratchpad,
    ...(git === undefined ? {} : { git }),
    ...(project === undefined ? {} : { project }),
    ...(lane === undefined ? {} : { lane }),
  };
}
