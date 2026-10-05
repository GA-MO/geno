import type { ToolBlock, ToolKind, Turn } from './messages.js';
import { isWaiting } from './rail.js';
import { playhead, POSES, type PoseName } from './sprite.js';

/**
 * The working dino: Noodle at 2× beside the running turn's current step, in the pose of the work under way, then one
 * move as the turn ends. Pure: the view ticks it and draws its frame.
 */

/** What the running turn is doing, as the dino shows it. */
export type WorkKind = 'thinking' | 'read' | 'code' | 'write' | 'run' | 'plan' | 'ask' | 'failed';

/** The pose for each kind of work: a new kind is a new row. */
export const WORK_POSES = {
  thinking: 'thinking',
  read: 'reading',
  code: 'coding',
  write: 'writing',
  run: 'running',
  plan: 'planning',
  ask: 'asking',
  failed: 'sweat',
} as const satisfies Readonly<Record<WorkKind, PoseName>>;

/** Calls by name, then by the ACP kind for a tool not named here; an edit's kind depends on its file. */
const BY_NAME: Readonly<Record<string, WorkKind | 'edit'>> = {
  read: 'read',
  grep: 'read',
  glob: 'read',
  list: 'read',
  skill: 'read',
  edit: 'edit',
  bash: 'run',
  check: 'run',
};
const BY_KIND: Readonly<Record<ToolKind, WorkKind | 'edit'>> = { read: 'read', search: 'read', edit: 'edit', execute: 'run', other: 'thinking' };

/** Files that hold code; an edit of anything else, such as Markdown, JSON or a config, is writing. */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set(
  'ts tsx mts cts js jsx mjs cjs py rb go rs java kt kts swift c h cc cpp hpp cs php sh bash zsh fish ps1 lua dart scala clj ex exs erl hs ml fs r jl zig nim vue svelte astro css scss sass less html sql graphql'.split(' '),
);

const extensionOf = (file: string): string => {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
};

function kindOfCall(tool: ToolBlock): WorkKind {
  const kind = tool.name.startsWith('mcp__') ? 'run' : (BY_NAME[tool.name] ?? BY_KIND[tool.toolKind]);
  if (kind !== 'edit') return kind;
  return CODE_EXTENSIONS.has(extensionOf(tool.diff?.path ?? tool.target)) ? 'code' : 'write';
}

/** A card waiting on the user comes first, then a failed step, then Plan mode, then the call under way. */
export function workOf(turn: Turn): WorkKind {
  if (isWaiting(turn)) return 'ask';
  const calls = turn.blocks.filter((block): block is ToolBlock => block.kind === 'tool');
  const running = calls.findLast((tool) => tool.status === 'running');
  if (running === undefined && calls.at(-1)?.status === 'failed') return 'failed';
  if (turn.mode === 'plan') return 'plan';
  return running === undefined ? 'thinking' : kindOfCall(running);
}

/** How a check's result reads, from `check` and from the check an edit runs after itself. */
const CHECK_VERDICTS: readonly { readonly says: RegExp; readonly passed: boolean }[] = [
  { says: /^check `.*` passed$/gm, passed: true },
  { says: /^check `.*` (?:failed \(exit [^)]+\)|timed out)$/gm, passed: false },
  { says: /^The editor reports no problems/gm, passed: true },
  { says: /^The editor reports these problems/gm, passed: false },
];
const CHECKED_BY: ReadonlySet<string> = new Set(['check', 'edit']);

/** Whether the turn's last check passed; undefined when it ran none. */
export function checksPassed(turn: Turn): boolean | undefined {
  const verdicts = turn.blocks.flatMap((block) => {
    if (block.kind !== 'tool' || !CHECKED_BY.has(block.name) || block.status !== 'completed' || block.output === undefined) return [];
    const output = block.output;
    return CHECK_VERDICTS.flatMap(({ says, passed }) => [...output.matchAll(says)].map((match) => ({ at: match.index, passed }))).sort((a, b) => a.at - b.at);
  });
  return verdicts.at(-1)?.passed;
}

/** The move as a done turn ends: a flex when its checks passed, else a hop or a somersault. A stopped or failed turn plays none. */
export function endingOf(turn: Turn, random: () => number): 'flex' | 'hop' | 'somersault' | undefined {
  if (turn.status !== 'done') return undefined;
  if (checksPassed(turn) === true) return 'flex';
  return random() < 0.5 ? 'hop' : 'somersault';
}

/**
 * The dino of one turn. `t` is ticks into `pose`; `intro` says this pose plays its intro, which coding's laptop does
 * once a turn (`coded`); `ending` says the pose is the turn-end move.
 */
export type Working = {
  readonly turn: string;
  readonly pose: PoseName;
  readonly t: number;
  readonly intro: boolean;
  readonly coded: boolean;
  readonly ending: boolean;
};

/** A pose shows at least this many ticks, about 1.4 s, before thinking takes over, however short its frames. */
export const HOLD_TICKS = 20;

function switchTo(was: Working | undefined, turn: string, pose: PoseName, ending: boolean): Working {
  const coded = was?.turn === turn && was.coded;
  return { turn, pose, t: 0, intro: !(pose === 'coding' && coded), coded: coded || pose === 'coding', ending };
}

/**
 * The dino after the turn changed or a tick passed. A new kind of work shows at once; going back to thinking waits
 * until the pose has played through and HOLD_TICKS passed, so a quick read or command still shows. `still` means frames do not play
 * (reduced motion, high contrast), so nothing waits on them and no turn-end move plays. Undefined: no dino.
 */
export function steer(was: Working | undefined, turn: Turn | undefined, still: boolean, random: () => number): Working | undefined {
  if (turn === undefined) return undefined;
  const ours = was?.turn === turn.id ? was : undefined;
  if (turn.status !== 'streaming') {
    if (ours === undefined || still) return undefined;
    if (!ours.ending) {
      const ending = endingOf(turn, random);
      return ending === undefined ? undefined : switchTo(ours, turn.id, ending, true);
    }
    return playhead(POSES[ours.pose], ours.t, ours.intro).ended ? undefined : ours;
  }
  const pose = WORK_POSES[workOf(turn)];
  if (ours === undefined) return switchTo(undefined, turn.id, pose, false);
  if (pose === ours.pose) return ours;
  if (pose === 'thinking' && !still && (ours.t < HOLD_TICKS || !playhead(POSES[ours.pose], ours.t, ours.intro).cycled)) return ours;
  return switchTo(ours, turn.id, pose, false);
}

/** What the dino shows now; when frames do not play, each pose's first loop frame. */
export const frameOf = (working: Working, still: boolean) => (still ? POSES[working.pose].loop[0]! : playhead(POSES[working.pose], working.t, working.intro).frame);
