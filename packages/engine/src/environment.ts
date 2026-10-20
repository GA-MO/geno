import { execFile } from 'node:child_process';
import { access, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { GIT_COMMITS, GIT_STATUS_LINES, KEY_PACKAGES, KEY_SCRIPTS, LANE_ROOT, type Environment, type GitSnapshot, type LanePlace, type ProjectFacts, type TurnEvent } from '@g-code/core';
import { laneAt } from './lanes.js';

const exec = promisify(execFile);

/** A slow repository costs the session's start at most this long per git command. */
const GIT_TIMEOUT_MS = 5000;

/** Inside a scratchpad, the full id of the session that made it, so a session whose id starts the same makes its own. */
const OWNER_FILE = '.gcode-session';

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/**
 * Whether `root` is a folder only `uid` can write: made now with mode 0700, or found as a real directory (not a symlink)
 * that `uid` owns and that its group and others cannot write. Anything else at that shared path may be another user's.
 */
async function privateRoot(root: string, uid: number): Promise<boolean> {
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if (errnoOf(error) !== 'EEXIST') return false;
  }
  const stat = await lstat(root);
  return stat.isDirectory() && stat.uid === uid && (stat.mode & 0o022) === 0;
}

/** Makes `dir` this session's, or says it is another's: one made by a session whose id starts the same. */
async function claimed(dir: string, sessionId: string): Promise<boolean> {
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if (errnoOf(error) !== 'EEXIST') throw error;
    return (await readFile(path.join(dir, OWNER_FILE), 'utf8').catch(() => undefined)) === sessionId;
  }
  await writeFile(path.join(dir, OWNER_FILE), sessionId);
  return true;
}

export type ScratchRoots = {
  /** The shared temp dir the short root sits in. */
  readonly tmp?: string;
  /** The user the short root must belong to; absent where the platform has no uids, such as Windows. */
  readonly uid?: number | undefined;
  readonly warn?: (line: string) => void;
};

/**
 * A new session's scratchpad, made now: `/tmp/gcode-<uid>/<first 8 hex of the id>`, more of the id when a live session
 * already has that folder. It is every command's $TMPDIR, and macOS caps a unix socket's path at 104 bytes, so the
 * per-user temp dir (/private/var/folders/…/T, about 50) leaves a project too little room for the sockets it makes there.
 * Where the short root cannot be trusted or written, as in a sandbox that may write only its own scratchpad, or there
 * are no uids, it is the old `<temp dir>/gcode-sessions/<id>`.
 */
export async function scratchpadOf(sessionId: string, { tmp = '/tmp', uid = process.getuid?.(), warn = () => {} }: ScratchRoots = {}): Promise<string> {
  if (uid !== undefined) {
    const root = path.join(await realpath(tmp), `gcode-${uid}`);
    const compact = sessionId.replaceAll('-', '');
    const names = [...[8, 16, 24].filter((length) => length < compact.length).map((length) => compact.slice(0, length)), sessionId];
    try {
      if (!(await privateRoot(root, uid))) throw new Error(`${root} is not a private folder of this user`);
      for (const name of names) if (await claimed(path.join(root, name), sessionId)) return path.join(root, name);
    } catch (error) {
      warn(`scratchpad: ${(error as Error).message}; this session's scratchpad is under the temp dir`);
    }
  }
  return path.join(await realpath(os.tmpdir()), 'gcode-sessions', sessionId);
}

/** The scratchpad a session's environment names; undefined in a log from before sessions had one. */
export function recordedScratchpad(events: readonly TurnEvent[]): string | undefined {
  const head = events[0];
  return head?.kind === 'session-start' ? head.environment?.scratchpad : undefined;
}

/**
 * Makes a session's recorded scratchpad again for a run, as a reboot empties /tmp. False when it sits in a short root
 * that is no longer this user's private folder, so the run does not write where another user could.
 */
export async function reopenScratchpad(scratchpad: string, uid = process.getuid?.()): Promise<boolean> {
  const root = path.dirname(scratchpad);
  if (uid !== undefined && path.basename(root) === `gcode-${uid}` && !(await privateRoot(root, uid))) return false;
  await mkdir(scratchpad, { recursive: true, mode: 0o700 });
  return true;
}

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
export async function captureEnvironment({ workspace, scratchpad, env, now = new Date() }: EnvironmentInput): Promise<Environment & { readonly git?: GitSnapshot | undefined }> {
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
