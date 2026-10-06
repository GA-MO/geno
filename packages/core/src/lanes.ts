import path from 'node:path';
import type { FileChange } from './review.js';
import type { SessionId } from './session.js';
import type { Brand } from './types.js';

export type LaneName = Brand<string, 'LaneName'>;

const LANE_NAME = /^[a-z0-9][a-z0-9._-]{0,47}$/i;

/** A lane name is a folder name and a branch name, so it keeps to what both allow everywhere. */
export function parseLaneName(raw: string): LaneName | undefined {
  if (!LANE_NAME.test(raw) || raw.includes('..') || raw.endsWith('.lock') || raw.endsWith('.')) return undefined;
  return raw as LaneName;
}

/** Where lanes live, relative to the main checkout. */
export const LANE_ROOT = path.join('.geno', 'worktrees');
/** The line the repository's `.git/info/exclude` gets, so lanes never show as untracked files. */
export const LANE_EXCLUDE = '/.geno/';
export const laneBranch = (name: LaneName): string => `geno/${name}`;
/** Cursor's default worktree cap. */
export const LANE_CAP = 25;

export const LANE_BASES = ['head', 'main'] as const;
export type LaneBase = (typeof LANE_BASES)[number];
export const isLaneBase = (raw: string): raw is LaneBase => (LANE_BASES as readonly string[]).includes(raw);

/** What Geno stores about a lane. Git owns the worktree and the branch; this adds what git cannot say. */
export type LaneRecord = {
  readonly name: LaneName;
  /** Real path of the worktree. */
  readonly path: string;
  readonly branch: string;
  /** The commit the lane started from, the merge base when it is applied. */
  readonly base: { readonly from: LaneBase; readonly commit: string };
  /** The last session that ran in the lane. */
  readonly session: SessionId | null;
  readonly createdAt: string;
};

export const LANE_STATUSES = ['clean', 'changed', 'missing'] as const;
/** `changed`: edits or commits since the base. `missing`: the worktree folder is gone. */
export type LaneStatus = (typeof LANE_STATUSES)[number];
export type Lane = LaneRecord & { readonly status: LaneStatus };

/** Only a lane with nothing to lose may be swept or discarded without the user saying so. */
export const isDisposable = (status: LaneStatus): boolean => status !== 'changed';

export const LANE_CONFLICT_REASONS = {
  'both-changed': 'the lane and the main checkout changed the same lines',
  'added-in-both': 'the lane and the main checkout both added this file',
  'deleted-in-lane': 'the lane deleted a file the main checkout changed',
  'deleted-in-main': 'the main checkout deleted a file the lane changed',
  binary: 'a binary file changed on both sides',
} as const;
export type LaneConflictReason = keyof typeof LANE_CONFLICT_REASONS;
export type LaneConflict = { readonly path: string; readonly reason: LaneConflictReason };

/**
 * One file a lane changes in the main checkout. `change` holds the hunks the review flow shows, counted in the main
 * file's current text; `after` null deletes the file; `baseHash` is the main text it applies over.
 */
export type LaneChange = { readonly change: FileChange; readonly after: string | null; readonly baseHash: string | null };

/** All or nothing: one conflict and no file is written. */
export type LaneApplyResult =
  | { readonly kind: 'clean'; readonly changes: readonly LaneChange[] }
  | { readonly kind: 'conflicts'; readonly conflicts: readonly LaneConflict[] };

/** The user's approval to run a repository's lane setup commands outside the sandbox. A changed list asks again. */
export type SetupApproval = {
  /** Real path of the main checkout. */
  readonly repo: string;
  readonly commandsHash: string;
  readonly commands: readonly string[];
  readonly approvedAt: string;
};

/** One file's three versions; null is absent. `base` is the lane's start, `ours` the main checkout now, `theirs` the lane now. */
export type MergeInput = { readonly base: string | null; readonly ours: string | null; readonly theirs: string | null };

/** What a 3-way merge of one file needs: nothing, a side taken whole, a line merge, or the user. */
export type MergeStep =
  | { readonly kind: 'same' }
  | { readonly kind: 'take'; readonly after: string | null }
  | { readonly kind: 'merge' }
  | { readonly kind: 'conflict'; readonly reason: LaneConflictReason };

const isBinary = (text: string | null): boolean => text !== null && text.includes('\0');

export function mergeStepOf({ base, ours, theirs }: MergeInput): MergeStep {
  if (ours === theirs) return { kind: 'same' };
  if (ours === base) return { kind: 'take', after: theirs };
  if (theirs === base) return { kind: 'same' };
  if (isBinary(base) || isBinary(ours) || isBinary(theirs)) return { kind: 'conflict', reason: 'binary' };
  if (base === null) return { kind: 'conflict', reason: 'added-in-both' };
  if (theirs === null) return { kind: 'conflict', reason: 'deleted-in-lane' };
  if (ours === null) return { kind: 'conflict', reason: 'deleted-in-main' };
  return { kind: 'merge' };
}

/** Why a lane session's command was refused before it ran. */
export const LANE_DENIALS = {
  'cwd-outside-lane': 'runs in a folder outside the lane',
  'cd-outside-lane': 'changes to a folder outside the lane, or one that cannot be known before it runs',
  'git-c-outside-lane': 'points git -C outside the lane',
  'git-dir-flag': 'points git at another checkout with --git-dir, --work-tree or core.worktree',
  'git-env-redirect': 'redirects git with GIT_DIR, GIT_WORK_TREE or a variable like them',
  'path-in-main': 'names a path in the main checkout',
} as const;
export type LaneDenialId = keyof typeof LANE_DENIALS;
export type LaneDenial = { readonly id: LaneDenialId; readonly word: string };

/**
 * The folders a lane session must stay inside and out of. Each lists every spelling of one folder, such as macOS's
 * `/private/var` and `/var`, because a command names a path as the model wrote it.
 */
export type LaneBounds = { readonly lane: readonly string[]; readonly main: readonly string[]; readonly home: string | undefined };

const GIT_REDIRECT = /^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES|NAMESPACE)=/;
const UNKNOWABLE = /[$`*?[{]/;
const WRAPPERS = new Set(['command', 'builtin', 'env', 'exec', 'nohup', 'time', 'sudo', 'xargs']);
const SEPARATORS = new Set([';', '&', '|', '(', ')', '\n', '`']);

/** One simple command. `scoped`: run in a subshell, a pipeline or the background, so a `cd` in it does not last. */
type Segment = { readonly words: readonly string[]; readonly scoped: boolean };

/**
 * Splits a command into simple commands, the way sh would in the cases that matter here: quotes and backslashes join
 * words; `; && || | & ( ) newline` and backquotes separate commands. Redirections stay as their own words.
 */
function segmentsOf(command: string): Segment[] {
  const segments: { words: string[]; scoped: boolean }[] = [];
  let words: string[] = [];
  let word: string | undefined;
  let depth = 0;
  let backquoted = false;
  let pipedIn = false;
  const endWord = () => {
    if (word !== undefined) words.push(word);
    word = undefined;
  };
  const endSegment = (pipedOut: boolean) => {
    endWord();
    if (words.length > 0) segments.push({ words, scoped: depth > 0 || backquoted || pipedIn || pipedOut });
    words = [];
    pipedIn = pipedOut;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1);
      const end = close === -1 ? command.length : close;
      word = (word ?? '') + command.slice(i + 1, end);
      i = end;
    } else if (c === '\\') {
      word = (word ?? '') + (command[i + 1] ?? '');
      i++;
    } else if (SEPARATORS.has(c)) {
      const doubled = (c === '&' || c === '|') && command[i + 1] === c;
      endSegment((c === '&' || c === '|') && !doubled);
      if (doubled) i++;
      if (c === '(') depth++;
      if (c === ')') depth = Math.max(0, depth - 1);
      if (c === '`') backquoted = !backquoted;
    } else if (c === '<' || c === '>') {
      endWord();
      while (command[i + 1] === '>' || command[i + 1] === '&') i++;
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word = (word ?? '') + c;
    }
  }
  endSegment(false);
  return segments;
}

export const shellSegments = (command: string): string[][] => segmentsOf(command).map((segment) => [...segment.words]);

const within = (root: string, target: string): boolean => {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const inside = (roots: readonly string[], target: string): boolean => roots.some((root) => within(root, target));

const isPathLike = (word: string): boolean =>
  word === '.' || word === '..' || word.startsWith('/') || word.startsWith('~') || word.includes('/');

function resolveWord(word: string, cwd: string, home: string | undefined): string | undefined {
  if (word === '~' || word.startsWith('~/')) return home === undefined ? undefined : path.join(home, word.slice(1));
  if (word.startsWith('~')) return undefined;
  return path.resolve(cwd, word);
}

/**
 * Refuses a lane session's command that would reach the main checkout: by its folder, a `cd`, `git -C`, git's own
 * redirects, or a path. It reads the command's text, so it is the clear early refusal; the sandbox, which lets the
 * session write only to the lane, is what holds when a path is built at run time.
 */
export function laneCommandDenial(command: string, cwd: string, bounds: LaneBounds): LaneDenial | undefined {
  if (!inside(bounds.lane, cwd)) return { id: 'cwd-outside-lane', word: cwd };
  // Every folder the command may be in by now: a scoped cd adds one, since what follows may run in either.
  let cwds = [cwd];
  const outsideLane = (target: string) => !inside(bounds.lane, target);
  const targets = (word: string) => (UNKNOWABLE.test(word) ? [undefined] : cwds.map((from) => resolveWord(word, from, bounds.home)));
  const leaves = (word: string) => targets(word).some((target) => target === undefined || outsideLane(target));
  for (const { words, scoped } of segmentsOf(command)) {
    for (const word of words) if (GIT_REDIRECT.test(word)) return { id: 'git-env-redirect', word };
    let at = 0;
    while (at < words.length && (/^\w+=/.test(words[at]!) || WRAPPERS.has(words[at]!))) at++;
    const name = words[at];
    const args = words.slice(at + 1);
    if (name === 'cd' || name === 'pushd') {
      const target = args.find((arg) => !arg.startsWith('-')) ?? '~';
      if (leaves(target)) return { id: 'cd-outside-lane', word: target };
      const moved = targets(target) as string[];
      cwds = [...new Set(scoped ? [...cwds, ...moved] : moved)];
    }
    if (name === 'git') {
      for (const [i, arg] of args.entries()) {
        if (/^--(git-dir|work-tree)(=|$)/.test(arg) || arg.startsWith('core.worktree')) return { id: 'git-dir-flag', word: arg };
        if (arg === '-C') {
          const dir = args[i + 1] ?? '';
          if (leaves(dir)) return { id: 'git-c-outside-lane', word: dir };
        }
      }
    }
    for (const raw of words) {
      const word = raw.startsWith('-') && raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : raw;
      if (!isPathLike(word) || UNKNOWABLE.test(word)) continue;
      if (targets(word).some((target) => target !== undefined && inside(bounds.main, target) && outsideLane(target))) return { id: 'path-in-main', word: raw };
    }
  }
  return undefined;
}

export const laneDenialText = (denial: LaneDenial): string =>
  `denied: this session runs in a lane, and the command ${LANE_DENIALS[denial.id]} (${denial.word}). Work only inside the lane; do not retry it.`;
