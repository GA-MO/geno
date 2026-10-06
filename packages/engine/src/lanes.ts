import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { appendFile, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  asSessionId,
  changeOf,
  hashText,
  isLaneBase,
  isDisposable,
  LANE_CAP,
  LANE_EXCLUDE,
  LANE_ROOT,
  laneBranch,
  mergeStepOf,
  parseLaneName,
  type Lane,
  type LaneApplyResult,
  type LaneBase,
  type LaneBounds,
  type LaneChange,
  type LaneConflict,
  type LaneName,
  type LaneRecord,
  type LaneStatus,
  type DiffStat,
  type SessionId,
  type SetupApproval,
} from '@g-code/core';
import { childEnv, type Env } from './child-env.js';
import { EngineError } from './errors.js';
import { DISK_FILES, type Files } from './files.js';
import { runShell } from './process.js';
import { isMissing, StoreError } from './store.js';

type GitResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

// The engine may itself run under a git hook, whose GIT_DIR would point every lane command at the wrong repository.
const gitEnv = (extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  ...extra,
});

function gitRun(dir: string, args: readonly string[], extra: Readonly<Record<string, string>> = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotePath=false', '-C', dir, ...args], { env: gitEnv(extra), maxBuffer: 512 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
      resolve({ code, stdout, stderr });
    });
  });
}

async function git(dir: string, args: readonly string[], extra: Readonly<Record<string, string>> = {}): Promise<string> {
  const result = await gitRun(dir, args, extra);
  if (result.code !== 0) throw new EngineError(`git ${args[0]} in ${dir} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
  return result.stdout;
}

const nulList = (out: string): string[] => out.split('\0').filter((entry) => entry !== '');

/** The main checkout and its git folder, which every lane of it shares. */
export type LaneRepo = { readonly main: string; readonly common: string };

export async function laneRepoOf(dir: string): Promise<LaneRepo> {
  const common = await realpath((await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
  if (path.basename(common) !== '.git') throw new EngineError(`lanes need a checkout with a .git folder, and ${dir} uses ${common}`);
  return { main: path.dirname(common), common };
}

const recordsDir = (repo: LaneRepo) => path.join(repo.common, 'geno', 'lanes');
const recordFile = (repo: LaneRepo, name: LaneName) => path.join(recordsDir(repo), `${name}.json`);

const recordSchema = z.object({
  name: z.string().transform((raw, ctx) => parseLaneName(raw) ?? (ctx.addIssue('not a lane name'), z.NEVER)),
  path: z.string().min(1),
  branch: z.string().min(1),
  base: z.object({ from: z.string().refine(isLaneBase), commit: z.string().min(1) }),
  session: z.string().min(1).transform(asSessionId).nullable(),
  createdAt: z.string(),
});

async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new StoreError(file, (error as Error).message);
  }
}

async function readRecord(repo: LaneRepo, name: LaneName): Promise<LaneRecord | undefined> {
  const file = recordFile(repo, name);
  const raw = await readJson(file);
  if (raw === undefined) return undefined;
  const parsed = recordSchema.safeParse(raw);
  if (!parsed.success) throw new StoreError(file, z.prettifyError(parsed.error));
  return { ...parsed.data, base: { from: parsed.data.base.from as LaneBase, commit: parsed.data.base.commit } };
}

async function writeRecord(repo: LaneRepo, record: LaneRecord): Promise<void> {
  await mkdir(recordsDir(repo), { recursive: true });
  const file = recordFile(repo, record.name);
  await writeFile(`${file}.tmp`, `${JSON.stringify(record, null, 2)}\n`);
  await rename(`${file}.tmp`, file);
}

export async function requireLane(repo: LaneRepo, raw: string): Promise<LaneRecord> {
  const name = parseLaneName(raw);
  const record = name === undefined ? undefined : await readRecord(repo, name);
  if (record === undefined) throw new EngineError(`no lane ${raw} in ${repo.main}`);
  return record;
}

async function laneRecords(repo: LaneRepo): Promise<LaneRecord[]> {
  let names: string[];
  try {
    names = (await readdir(recordsDir(repo))).filter((file) => file.endsWith('.json'));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const lanes = names.flatMap((file) => parseLaneName(file.slice(0, -'.json'.length)) ?? []);
  const records = await Promise.all(lanes.map((name) => readRecord(repo, name)));
  return records.filter((record): record is LaneRecord => record !== undefined).sort((a, b) => a.name.localeCompare(b.name));
}

export async function laneStatus(record: LaneRecord): Promise<LaneStatus> {
  if (!existsSync(record.path)) return 'missing';
  if ((await git(record.path, ['status', '--porcelain', '--untracked-files=all'])).trim() !== '') return 'changed';
  const ahead = Number((await git(record.path, ['rev-list', '--count', `${record.base.commit}..HEAD`])).trim());
  return ahead > 0 ? 'changed' : 'clean';
}

export async function listLanes(repo: LaneRepo): Promise<Lane[]> {
  return Promise.all((await laneRecords(repo)).map(async (record) => ({ ...record, status: await laneStatus(record) })));
}

/** Keeps `.geno/` out of `git status` through the repository's own exclude file, which is never committed. */
async function ensureExcluded(repo: LaneRepo): Promise<void> {
  const file = path.join(repo.common, 'info', 'exclude');
  let text = '';
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (text.split('\n').some((line) => line.trim() === LANE_EXCLUDE)) return;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${LANE_EXCLUDE}\n`);
}

async function baseCommit(repo: LaneRepo, from: LaneBase): Promise<string> {
  if (from === 'head') return (await git(repo.main, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  for (const branch of ['main', 'master']) {
    const found = await gitRun(repo.main, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    if (found.code === 0) return found.stdout.trim();
  }
  throw new EngineError(`${repo.main} has no main or master branch; start the lane with --from head`);
}

export async function createLane(repo: LaneRepo, raw: string, from: LaneBase, now = new Date()): Promise<LaneRecord> {
  const name = parseLaneName(raw);
  if (name === undefined) throw new EngineError(`${raw} is not a lane name: use letters, digits, dot, dash and underscore, 48 at most`);
  if ((await readRecord(repo, name)) !== undefined) throw new EngineError(`lane ${name} already exists`);
  const records = await laneRecords(repo);
  if (records.length >= LANE_CAP) throw new EngineError(`${records.length} lanes exist, the cap is ${LANE_CAP}; run gcode lane sweep to remove the clean ones`);
  const commit = await baseCommit(repo, from);
  await ensureExcluded(repo);
  const dir = path.join(repo.main, LANE_ROOT, name);
  await mkdir(path.dirname(dir), { recursive: true });
  await git(repo.main, ['worktree', 'add', '--quiet', '-b', laneBranch(name), dir, commit]);
  const record: LaneRecord = { name, path: await realpath(dir), branch: laneBranch(name), base: { from, commit }, session: null, createdAt: now.toISOString() };
  await writeRecord(repo, record);
  return record;
}

/**
 * Copies the gitignored files that `.worktreeinclude` names, such as `.env`, from the main checkout into the lane.
 * Files git tracks are already there, so only a file both listed and ignored is copied, as in Claude Code.
 */
export async function copyIncluded(repo: LaneRepo, lane: LaneRecord): Promise<string[]> {
  const list = path.join(repo.main, '.worktreeinclude');
  if (!existsSync(list)) return [];
  const listed = nulList(await git(repo.main, ['ls-files', '-z', '--others', '--ignored', `--exclude-from=${list}`]));
  const candidates = listed.filter((file) => !file.startsWith(`${LANE_ROOT.split(path.sep)[0]}/`));
  if (candidates.length === 0) return [];
  const ignored = new Set(nulList((await gitCheckIgnore(repo.main, candidates)).stdout));
  const copied: string[] = [];
  for (const file of candidates.filter((candidate) => ignored.has(candidate))) {
    const target = path.join(lane.path, file);
    if (existsSync(target)) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(repo.main, file), target, constants.COPYFILE_FICLONE);
    copied.push(file);
  }
  return copied;
}

function gitCheckIgnore(dir: string, files: readonly string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile('git', ['-C', dir, 'check-ignore', '-z', '--stdin'], { env: gitEnv({}), encoding: 'utf8' }, (error, stdout, stderr) =>
      resolve({ code: error === null ? 0 : Number(error.code ?? -1), stdout, stderr }),
    );
    child.stdin?.end(files.join('\0'));
  });
}

/** How the lane got its installed dependencies. */
export type DepsReport =
  | { readonly kind: 'cloned'; readonly folders: readonly string[]; readonly ms: number }
  | { readonly kind: 'none' }
  | { readonly kind: 'unsupported'; readonly platform: string }
  | { readonly kind: 'failed'; readonly folder: string; readonly detail: string };

const cpClone = (from: string, to: string): Promise<GitResult> =>
  new Promise((resolve) => {
    execFile('cp', ['-c', '-R', from, to], { encoding: 'utf8' }, (error, stdout, stderr) => resolve({ code: error === null ? 0 : Number(error.code ?? -1), stdout, stderr }));
  });

/**
 * Clones each `node_modules` of the main checkout into the lane with APFS copy-on-write (`cp -c`), so the lane has its
 * dependencies without the network the sandbox denies, and with almost no disk. pnpm's links are relative, so they
 * resolve inside the clone. A clone that fails is reported, not replaced by a full copy.
 */
export async function cloneDeps(repo: LaneRepo, lane: LaneRecord, platform: string = process.platform): Promise<DepsReport> {
  const manifests = nulList(await git(repo.main, ['ls-files', '-z'])).filter((file) => path.posix.basename(file) === 'package.json');
  const folders: string[] = [];
  for (const manifest of manifests) {
    const folder = path.posix.dirname(manifest);
    const source = path.join(repo.main, folder, 'node_modules');
    if (existsSync(source) && (await stat(source)).isDirectory() && !existsSync(path.join(lane.path, folder, 'node_modules'))) folders.push(folder);
  }
  if (folders.length === 0) return { kind: 'none' };
  if (platform !== 'darwin') return { kind: 'unsupported', platform };
  const started = performance.now();
  for (const folder of folders) {
    const result = await cpClone(path.join(repo.main, folder, 'node_modules'), path.join(lane.path, folder, 'node_modules'));
    if (result.code !== 0) {
      await rm(path.join(lane.path, folder, 'node_modules'), { recursive: true, force: true });
      return { kind: 'failed', folder, detail: result.stderr.trim() || `exit ${result.code}` };
    }
  }
  return { kind: 'cloned', folders, ms: Math.round(performance.now() - started) };
}

/** Where a repository's lane setup is configured. Geno's own `.gcode.json` wins over Cursor's file. */
export type SetupSource = { readonly file: string; readonly commands: readonly string[] };

const commandList = z.union([z.string().min(1).transform((one) => [one]), z.array(z.string().min(1))]);
const gcodeSetup = z.looseObject({ laneSetup: commandList.optional() });
const cursorSetup = z.looseObject({ 'setup-worktree-unix': commandList.optional(), 'setup-worktree': commandList.optional() });

export async function setupSource(main: string): Promise<SetupSource | undefined> {
  const sources: readonly [string, (raw: unknown) => readonly string[] | undefined][] = [
    ['.gcode.json', (raw) => gcodeSetup.parse(raw).laneSetup],
    [path.join('.cursor', 'worktrees.json'), (raw) => {
      const parsed = cursorSetup.parse(raw);
      return parsed['setup-worktree-unix'] ?? parsed['setup-worktree'];
    }],
  ];
  for (const [file, pick] of sources) {
    const raw = await readJson(path.join(main, file));
    if (raw === undefined) continue;
    let commands: readonly string[] | undefined;
    try {
      commands = pick(raw);
    } catch (error) {
      throw new StoreError(path.join(main, file), error instanceof z.ZodError ? z.prettifyError(error) : String(error));
    }
    if (commands !== undefined && commands.length > 0) return { file, commands };
  }
  return undefined;
}

const approvalsFile = (appHome: string) => path.join(appHome, 'lane-setup-approvals.json');
const approvalsSchema = z.object({
  approvals: z.array(z.object({ repo: z.string(), commandsHash: z.string(), commands: z.array(z.string()), approvedAt: z.string() })),
});
const commandsHash = (commands: readonly string[]) => createHash('sha256').update(JSON.stringify(commands)).digest('hex');

async function readApprovals(appHome: string): Promise<SetupApproval[]> {
  const file = approvalsFile(appHome);
  const raw = await readJson(file);
  if (raw === undefined) return [];
  const parsed = approvalsSchema.safeParse(raw);
  if (!parsed.success) throw new StoreError(file, z.prettifyError(parsed.error));
  return parsed.data.approvals;
}

export async function isSetupApproved(appHome: string, main: string, commands: readonly string[]): Promise<boolean> {
  const hash = commandsHash(commands);
  return (await readApprovals(appHome)).some((approval) => approval.repo === main && approval.commandsHash === hash);
}

/** Records the user's yes for this repository's current setup commands, replacing any approval of an older list. */
export async function approveSetup(appHome: string, main: string, commands: readonly string[], now = new Date()): Promise<void> {
  const approvals = (await readApprovals(appHome)).filter((approval) => approval.repo !== main);
  approvals.push({ repo: main, commandsHash: commandsHash(commands), commands: [...commands], approvedAt: now.toISOString() });
  await mkdir(appHome, { recursive: true });
  await writeFile(approvalsFile(appHome), `${JSON.stringify({ approvals }, null, 2)}\n`);
}

export const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

export type SetupRun = { readonly kind: 'ran'; readonly count: number } | { readonly kind: 'failed'; readonly command: string; readonly output: string };

/**
 * Runs the approved setup commands in the lane, outside the sandbox, because installing needs the network the
 * sandbox denies. `ROOT_WORKTREE_PATH` names the main checkout, as Cursor sets it.
 */
export async function runSetup(repo: LaneRepo, lane: LaneRecord, commands: readonly string[], env: Env, signal?: AbortSignal): Promise<SetupRun> {
  for (const command of commands) {
    const result = await runShell(command, {
      cwd: lane.path,
      env: childEnv(env, { ROOT_WORKTREE_PATH: repo.main }),
      timeoutMs: SETUP_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
    if (result.code !== 0) return { kind: 'failed', command, output: result.output };
  }
  return { kind: 'ran', count: commands.length };
}

export async function removeLane(repo: LaneRepo, record: LaneRecord): Promise<void> {
  // Forced, because the caller has checked the lane for changes, and ignored files such as node_modules stay behind otherwise.
  if (existsSync(record.path)) await git(repo.main, ['worktree', 'remove', '--force', record.path]);
  await git(repo.main, ['worktree', 'prune']);
  await gitRun(repo.main, ['branch', '-D', record.branch]);
  await rm(recordFile(repo, record.name), { force: true });
}

export class LaneHasChanges extends EngineError {}

/** Removes a lane. One with changes needs `discardChanges`, the user's explicit yes. */
export async function discardLane(repo: LaneRepo, record: LaneRecord, discardChanges: boolean): Promise<void> {
  if (!isDisposable(await laneStatus(record)) && !discardChanges) {
    throw new LaneHasChanges(`lane ${record.name} has changes; apply them first, or pass --discard-changes to lose them`);
  }
  await removeLane(repo, record);
}

/** Removes every lane with nothing to lose, and never one with changes. */
export async function sweepLanes(repo: LaneRepo): Promise<{ readonly removed: readonly LaneName[]; readonly kept: readonly LaneName[] }> {
  const removed: LaneName[] = [];
  const kept: LaneName[] = [];
  for (const lane of await listLanes(repo)) {
    if (isDisposable(lane.status)) {
      await removeLane(repo, lane);
      removed.push(lane.name);
    } else {
      kept.push(lane.name);
    }
  }
  return { removed, kept };
}

const SPECIAL_MODES = new Set(['120000', '160000']);

async function blobAt(dir: string, tree: string, file: string): Promise<string | null> {
  const result = await gitRun(dir, ['cat-file', 'blob', `${tree}:${file}`]);
  return result.code === 0 ? result.stdout : null;
}

/** The lane's working tree as a tree object, uncommitted and untracked files included, built in a scratch index. */
async function workingTree(lane: LaneRecord, scratch: string): Promise<string> {
  const index = path.join(scratch, 'index');
  const own = (await git(lane.path, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
  if (existsSync(own)) await copyFile(own, index);
  await git(lane.path, ['add', '-A'], { GIT_INDEX_FILE: index });
  return (await git(lane.path, ['write-tree'], { GIT_INDEX_FILE: index })).trim();
}

async function mergeFile(scratch: string, ours: string, base: string, theirs: string): Promise<string | undefined> {
  const [o, b, t] = ['ours', 'base', 'theirs'].map((name) => path.join(scratch, name)) as [string, string, string];
  await Promise.all([writeFile(o, ours), writeFile(b, base), writeFile(t, theirs)]);
  const result = await gitRun(scratch, ['merge-file', '-p', '-L', 'main', '-L', 'base', '-L', 'lane', o, b, t]);
  if (result.code === 0) return result.stdout;
  if (result.code > 0 && result.code < 128) return undefined;
  throw new EngineError(`git merge-file failed: ${result.stderr.trim() || `exit ${result.code}`}`);
}

/**
 * Merges the lane's changes since its base into the main checkout's current files, 3-way per file, and returns them
 * as review changes, or every conflict. It writes nothing; `writeLaneChanges` does, so the caller decides.
 */
export async function applyLane(repo: LaneRepo, lane: LaneRecord, files: Files = DISK_FILES): Promise<LaneApplyResult> {
  if (!existsSync(lane.path)) throw new EngineError(`lane ${lane.name} has no worktree at ${lane.path}`);
  const scratch = await mkdtemp(path.join(tmpdir(), 'gcode-lane-'));
  try {
    const tree = await workingTree(lane, scratch);
    const raw = nulList(await git(lane.path, ['diff-tree', '-r', '-z', '--no-renames', '--raw', lane.base.commit, tree]));
    const changes: LaneChange[] = [];
    const conflicts: LaneConflict[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const [oldMode = '', newMode = ''] = raw[i]!.slice(1).split(' ');
      const file = raw[i + 1]!;
      const target = path.join(repo.main, file);
      if (SPECIAL_MODES.has(oldMode) || SPECIAL_MODES.has(newMode)) {
        conflicts.push({ path: file, reason: 'special' });
        continue;
      }
      const [base, theirs, ours] = await Promise.all([blobAt(lane.path, lane.base.commit, file), blobAt(lane.path, tree, file), files.read(target)]);
      const step = mergeStepOf({ base, ours, theirs });
      if (step.kind === 'same') continue;
      if (step.kind === 'conflict') {
        conflicts.push({ path: file, reason: step.reason });
        continue;
      }
      const after = step.kind === 'take' ? step.after : await mergeFile(scratch, ours!, base!, theirs!);
      if (after === undefined) {
        conflicts.push({ path: file, reason: 'both-changed' });
        continue;
      }
      changes.push({ change: changeOf(file, ours ?? '', after ?? ''), after, baseHash: hashText(ours) });
    }
    return conflicts.length > 0 ? { kind: 'conflicts', conflicts } : { kind: 'clean', changes };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Lines the lane added and removed since its base, uncommitted and untracked files included. A binary file counts as a file only. */
export async function laneDiffStat(lane: LaneRecord): Promise<DiffStat> {
  if (!existsSync(lane.path)) return { files: 0, added: 0, removed: 0 };
  const scratch = await mkdtemp(path.join(tmpdir(), 'gcode-lane-'));
  try {
    const tree = await workingTree(lane, scratch);
    // With -z, numstat ends each row's counts with a tab and its path with a NUL.
    const rows = nulList(await git(lane.path, ['diff-tree', '-r', '-z', '--no-renames', '--numstat', lane.base.commit, tree]));
    let added = 0;
    let removed = 0;
    for (const row of rows) {
      const [plus = '', minus = ''] = row.split('\t');
      added += Number(plus) || 0;
      removed += Number(minus) || 0;
    }
    return { files: rows.length, added, removed };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Writes a clean apply into the main checkout. Nothing is written if any file changed since the merge read it. */
export async function writeLaneChanges(repo: LaneRepo, changes: readonly LaneChange[], files: Files = DISK_FILES): Promise<void> {
  const target = (change: LaneChange) => path.join(repo.main, change.change.path);
  for (const change of changes) {
    if (hashText(await files.read(target(change))) !== change.baseHash) {
      throw new EngineError(`${change.change.path} changed in the main checkout during the apply; apply the lane again`);
    }
  }
  for (const change of changes) {
    if (change.after === null) await rm(target(change), { force: true });
    else if ((await files.write(target(change), change.after, change.baseHash)) === 'stale-base') {
      throw new EngineError(`${change.change.path} changed in the main checkout during the apply; apply the lane again`);
    }
  }
}

/** A session running in a lane: the lane, and what keeps it inside. */
export type LaneSession = {
  readonly repo: LaneRepo;
  readonly record: LaneRecord;
  readonly bounds: LaneBounds;
  /** Folders of the shared git folder a lane's own git commands write: its worktree folder, objects and its branch. */
  readonly gitWritable: readonly string[];
};

/** Every spelling of a real path a command may use: macOS's `/var`, `/tmp` and `/etc` are links into `/private`. */
const spellings = (real: string): string[] => [...new Set([real, real.replace(/^\/private(?=\/(var|tmp|etc)(\/|$))/, '')])];

/** The lane `workspace` is in, or undefined when it is in none, such as the main checkout or a folder outside git. */
export async function laneAt(workspace: string, home: string | undefined): Promise<LaneSession | undefined> {
  const top = await gitRun(workspace, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return undefined;
  let repo: LaneRepo;
  try {
    repo = await laneRepoOf(workspace);
  } catch (error) {
    if (error instanceof EngineError) return undefined;
    throw error;
  }
  const root = await realpath(top.stdout.trim());
  if (root === repo.main) return undefined;
  const name = parseLaneName(path.basename(root));
  const record = name === undefined ? undefined : await readRecord(repo, name);
  if (record === undefined || record.path !== root) return undefined;
  const gitDir = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
  return {
    repo,
    record,
    bounds: { lane: spellings(root), main: spellings(repo.main), home },
    gitWritable: [gitDir, path.join(repo.common, 'objects'), path.join(repo.common, 'refs', 'heads', 'geno'), path.join(repo.common, 'logs', 'refs', 'heads', 'geno')],
  };
}

export async function bindSession(lane: LaneSession, session: SessionId): Promise<void> {
  if (lane.record.session !== session) await writeRecord(lane.repo, { ...lane.record, session });
}
