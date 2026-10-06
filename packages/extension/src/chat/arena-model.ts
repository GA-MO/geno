import type { ArenaLane, ArenaLaneStatus, ArenaRun, ArenaSize, ArenaStatus, CostPreview, VariantSpec, Variety } from '@g-code/core';
import { variantLabel } from '@g-code/core/arena';
import { formatCost } from './format.js';
import type { Badge } from './lanes-model.js';
import type { ToolBlock, Turn, TurnStatus } from './messages.js';

/**
 * The Arena pane's view model: pure functions from what the engine reports about a best-of-n run to what the preview,
 * the race, the ranking and the compare show. The webview bundles this file, so it imports only types and other pure
 * modules.
 */

/** What the user asked for. An undefined variety leaves it to the workspace's `.gcode.json`, else seeds. */
export type ArenaAsk = { readonly task: string; readonly n: ArenaSize; readonly variety: Variety | undefined };

/** The card before anything starts. Nothing spends until Start, which moves it to `starting`. */
export type ArenaPreview =
  | { readonly kind: 'invalid'; readonly error: string }
  | { readonly kind: 'loading'; readonly ask: ArenaAsk }
  | { readonly kind: 'ready' | 'starting'; readonly ask: ArenaAsk; readonly preview: CostPreview; readonly variants: readonly VariantSpec[] }
  | { readonly kind: 'failed'; readonly ask: ArenaAsk; readonly message: string };

/** One hunk of a lane's changes since its base, with the id a graft names it by (core's `hunkIdOf`). */
export type LaneHunk = { readonly id: string; readonly startLine: number; readonly lineCount: number; readonly oldText: string; readonly newText: string };
export type LaneFile = { readonly path: string; readonly hunks: readonly LaneHunk[] };
/** One lane's changes as the host hands them over: the engine's compare, with hunk ids filled in. */
export type LaneDiff = { readonly lane: string; readonly files: readonly LaneFile[] };

export type ArenaNotice = { readonly tone: 'busy' | 'ok' | 'failed'; readonly text: string };

/** What the host keeps for the pane, posted whole on each change so a new webview starts where the last one was. */
export type ArenaState = {
  readonly preview: ArenaPreview | undefined;
  /** Every run this window knows, newest first. */
  readonly runs: readonly ArenaRun[];
  /** The run the pane shows while no preview is open. */
  readonly shown: string | undefined;
  /** Each settled run's lane diffs, by run id. */
  readonly diffs: Readonly<Record<string, readonly LaneDiff[]>>;
  /** What the last pick, apply or graft on a run did, by run id. */
  readonly notices: Readonly<Record<string, ArenaNotice>>;
};

export const EMPTY_ARENA: ArenaState = { preview: undefined, runs: [], shown: undefined, diffs: {}, notices: {} };

export type ArenaToView = { readonly type: 'arena'; readonly state: ArenaState } | { readonly type: 'show-arena' };

export type ArenaFromView =
  /** Asks the cost and the variants again, as for another variety. */
  | { readonly type: 'arena-preview'; readonly ask: ArenaAsk }
  | { readonly type: 'arena-start'; readonly ask: ArenaAsk }
  | { readonly type: 'arena-cancel' }
  /** Cancels each running lane's session. */
  | { readonly type: 'arena-stop'; readonly id: string }
  /** Records the winner, then applies it in the shown chat, for review. */
  | { readonly type: 'arena-pick'; readonly id: string; readonly lane: string }
  | { readonly type: 'arena-graft'; readonly id: string; readonly lane: string; readonly hunks: readonly string[] };

export const VARIETY_LABELS: { readonly [V in Variety]: string } = { seeds: 'Seeds', effort: 'Effort', models: 'Models' };

/** The variety the variants show, for a preview the workspace's config decided. */
export function varietyOf(ask: ArenaAsk, variants: readonly VariantSpec[]): Variety {
  if (ask.variety !== undefined) return ask.variety;
  if (variants.some((v) => v.model !== null)) return 'models';
  return variants.some((v) => v.effort !== null) ? 'effort' : 'seeds';
}

/** Small per-lane amounts keep their third decimal, as "$0.032"; a total reads as cents. */
function preciseCost(usd: number): string {
  if (usd < 0.01) return formatCost(usd);
  return `$${usd.toFixed(3).replace(/(\.\d\d)0$/, '$1')}`;
}

/** The preview in words, such as "About $0.15: 3 lanes at $0.032, Geno's median task, plus up to $0.05 for the review." */
export function costSentence({ n, perLaneUsd, reviewMaxUsd, totalUsd, basis }: CostPreview): string {
  const each = basis.kind === 'history' ? `${preciseCost(perLaneUsd)}, Geno’s median task` : `a default of ${preciseCost(perLaneUsd)} a task`;
  return `About ${formatCost(totalUsd)}: ${n} lanes at ${each}, plus up to ${preciseCost(reviewMaxUsd)} for the review.`;
}

/** Where the costs come from, for the tooltip. */
export const costBasis = ({ basis }: CostPreview): string =>
  basis.kind === 'history'
    ? `The median cost of Geno’s last ${basis.samples} finished sessions here. The review is capped, so it costs at most this.`
    : 'Geno has too few finished sessions to take a median, so this uses a typical task’s cost on qwen3.8-flash. The review is capped, so it costs at most this.';

export type ArenaStage = 'race' | 'results';

export const ARENA_STAGES: { readonly [S in ArenaStatus]: ArenaStage } = { running: 'race', ranking: 'race', ranked: 'results', 'no-winner': 'results', stopped: 'results' };

export const RUN_BADGES: { readonly [S in ArenaStatus]: Badge } = {
  running: { label: 'Racing', tone: 'busy' },
  ranking: { label: 'Ranking…', tone: 'busy' },
  ranked: { label: 'Ranked', tone: 'ok' },
  'no-winner': { label: 'No lane passed', tone: 'failed' },
  stopped: { label: 'Stopped', tone: 'quiet' },
};

export const LANE_BADGES: { readonly [S in ArenaLaneStatus]: Badge } = {
  running: { label: 'Running', tone: 'busy' },
  checking: { label: 'Checking', tone: 'busy' },
  passed: { label: 'Passed', tone: 'ok' },
  failed: { label: 'Failed', tone: 'failed' },
  stopped: { label: 'Stopped', tone: 'quiet' },
};

const WINNER_BADGE: Badge = { label: 'Winner', tone: 'ok' };

const CHECK_BADGES = {
  passed: { label: 'Check passed', tone: 'ok' },
  failed: { label: 'Check failed', tone: 'failed' },
  none: { label: 'No check', tone: 'quiet' },
} as const satisfies Readonly<Record<string, Badge>>;

/** How long a running lane's dino takes to cover most of its share of the track; it never reaches the check by time alone. */
const RUN_PACE_MS = 45_000;

/** How far along the track a lane is: a running lane creeps toward the check, then the check, then the finish. */
const PROGRESS: { readonly [S in ArenaLaneStatus]: (elapsed: number) => number } = {
  running: (elapsed) => 0.08 + 0.55 * (1 - Math.exp(-Math.max(0, elapsed) / RUN_PACE_MS)),
  checking: () => 0.8,
  passed: () => 1,
  failed: () => 1,
  stopped: () => 1,
};

export type RaceRow = {
  readonly lane: string;
  readonly letter: string;
  readonly label: string;
  readonly sessionId: string;
  readonly state: Badge;
  /** 0 to 1 along the track. */
  readonly progress: number;
  readonly settled: boolean;
  readonly check: Badge | undefined;
  readonly cost: string | undefined;
  readonly turns: string | undefined;
};

const settledLane = (status: ArenaLaneStatus): boolean => status !== 'running' && status !== 'checking';

const turnsText = (turns: number): string | undefined => (turns === 0 ? undefined : `${turns} ${turns === 1 ? 'model call' : 'model calls'}`);

export function raceRowOf(lane: ArenaLane, startedAt: number, now: number): RaceRow {
  return {
    lane: lane.lane,
    letter: lane.letter,
    label: variantLabel(lane.variant),
    sessionId: lane.sessionId,
    state: LANE_BADGES[lane.status],
    progress: PROGRESS[lane.status](now - startedAt),
    settled: settledLane(lane.status),
    check: lane.check === null ? undefined : CHECK_BADGES[lane.check.outcome],
    cost: lane.costUsd === null || lane.costUsd === 0 ? undefined : formatCost(lane.costUsd),
    turns: turnsText(lane.turns),
  };
}

export const raceRows = (run: ArenaRun, now: number): RaceRow[] => run.lanes.map((lane) => raceRowOf(lane, Date.parse(run.createdAt), now));

/**
 * The turn a lane's helper dino is steered by, as U18b's dino is by a real turn: a running lane runs, a checking one
 * runs its check, a passing lane ends on a passed check, so it flexes once, and a failed or stopped lane plays no move.
 */
const RACE_TURNS: { readonly [S in ArenaLaneStatus]: { readonly status: TurnStatus; readonly call?: Pick<ToolBlock, 'name' | 'status' | 'output'> } } = {
  running: { status: 'streaming', call: { name: 'bash', status: 'running', output: undefined } },
  checking: { status: 'streaming', call: { name: 'check', status: 'running', output: undefined } },
  passed: { status: 'done', call: { name: 'check', status: 'completed', output: 'check `project` passed' } },
  failed: { status: 'failed' },
  stopped: { status: 'stopped' },
};

export function raceTurnOf(lane: Pick<ArenaLane, 'sessionId' | 'status'>, startedAt: number): Turn {
  const { status, call } = RACE_TURNS[lane.status];
  const tool: ToolBlock | undefined =
    call === undefined
      ? undefined
      : { kind: 'tool', id: `${lane.sessionId}:${lane.status}`, target: '', toolKind: 'execute', startedAt, endedAt: undefined, diff: undefined, ...call };
  return { id: `race:${lane.sessionId}`, prompt: '', blocks: tool === undefined ? [] : [tool], status, startedAt, endedAt: undefined, usage: undefined };
}

/** A lane as the ranking lists it. `pick` says the user may choose it as the winner now. */
export type RankRow = {
  readonly lane: string;
  readonly letter: string;
  readonly label: string;
  readonly rank: number | null;
  readonly state: Badge;
  readonly reason: string | null;
  readonly cost: string | undefined;
  readonly winner: boolean;
  readonly pick: boolean;
  /** The end of a failed check's output, which the row can show. */
  readonly checkTail: string | undefined;
};

export const canPick = (run: ArenaRun, lane: ArenaLane): boolean => run.status === 'ranked' && run.winner === null && lane.status === 'passed';

/** Ranked lanes best first, then the rest in start order. */
export function rankRows(run: ArenaRun): RankRow[] {
  const order = (lane: ArenaLane) => lane.rank ?? Number.POSITIVE_INFINITY;
  return run.lanes
    .toSorted((a, b) => order(a) - order(b) || a.letter.localeCompare(b.letter))
    .map((lane) => ({
      lane: lane.lane,
      letter: lane.letter,
      label: variantLabel(lane.variant),
      rank: lane.rank,
      state: run.winner === lane.lane ? WINNER_BADGE : LANE_BADGES[lane.status],
      reason: lane.reason,
      cost: lane.costUsd === null || lane.costUsd === 0 ? undefined : formatCost(lane.costUsd),
      winner: run.winner === lane.lane,
      pick: canPick(run, lane),
      checkTail: lane.check?.outcome === 'failed' && lane.check.tail.trim() !== '' ? lane.check.tail : undefined,
    }));
}

/** The hunks ticked for a graft, all from one lane. */
export type GraftSelection = { readonly lane: string; readonly hunks: readonly string[] } | undefined;

/** Ticks or unticks a hunk. A hunk of another lane starts a new selection, since a graft takes one lane at a time. */
export function toggleGraft(selection: GraftSelection, lane: string, hunk: string): GraftSelection {
  if (selection === undefined || selection.lane !== lane) return { lane, hunks: [hunk] };
  const hunks = selection.hunks.includes(hunk) ? selection.hunks.filter((id) => id !== hunk) : [...selection.hunks, hunk];
  return hunks.length === 0 ? undefined : { lane, hunks };
}

export type CompareHunk = { readonly id: string; readonly lane: string; readonly startLine: number; readonly oldText: string; readonly newText: string; readonly graftable: boolean };
/** One lane's hunks in one file; none means the lane left the file alone. */
export type CompareCell = { readonly lane: string; readonly hunks: readonly CompareHunk[] };
/** One path, with a cell per column in column order, so a file's cells line up across lanes. */
export type CompareFile = { readonly path: string; readonly cells: readonly CompareCell[] };
export type CompareColumn = { readonly lane: string; readonly letter: string; readonly label: string; readonly rank: number | null; readonly state: Badge; readonly winner: boolean };

export type CompareView = {
  readonly id: string;
  readonly task: string;
  readonly status: ArenaStatus;
  readonly summary: string | null;
  readonly columns: readonly CompareColumn[];
  readonly files: readonly CompareFile[];
  readonly winner: string | null;
  /** The lane a narrow panel shows. */
  readonly focus: string;
  readonly selected: GraftSelection;
};

const sameChange = (a: LaneHunk, b: LaneHunk): boolean =>
  a.startLine === b.startLine && a.lineCount === b.lineCount && a.oldText === b.oldText && a.newText === b.newText;

/** The lane a narrow compare opens on: the winner, else the review's first pick, else lane A. */
export const defaultFocus = (run: ArenaRun): string => run.winner ?? run.lanes.find((lane) => lane.rank === 1)?.lane ?? run.lanes[0]?.lane ?? '';

/**
 * The side-by-side compare: a column per lane in start order, and a row per file any lane changed, its cells aligned
 * by column. A hunk is graftable once a winner is picked, when it is not the winner's and the winner has no
 * identical hunk in the same file, since grafting that would change nothing.
 */
export function compareView(run: ArenaRun, diffs: readonly LaneDiff[], focus: string | undefined, selected: GraftSelection): CompareView {
  const byLane = new Map(diffs.map((diff) => [diff.lane, new Map(diff.files.map((file) => [file.path, file.hunks]))]));
  const paths = [...new Set(diffs.flatMap((diff) => diff.files.filter((file) => file.hunks.length > 0).map((file) => file.path)))].toSorted();
  const { winner } = run;
  const winnerHunks = (path: string) => (winner === null ? [] : (byLane.get(winner)?.get(path) ?? []));
  const files = paths.map((path) => ({
    path,
    cells: run.lanes.map(({ lane }) => ({
      lane,
      hunks: (byLane.get(lane)?.get(path) ?? []).map((hunk) => ({
        id: hunk.id,
        lane,
        startLine: hunk.startLine,
        oldText: hunk.oldText,
        newText: hunk.newText,
        graftable: winner !== null && lane !== winner && !winnerHunks(path).some((theirs) => sameChange(theirs, hunk)),
      })),
    })),
  }));
  const shownFocus = focus !== undefined && run.lanes.some((lane) => lane.lane === focus) ? focus : defaultFocus(run);
  return {
    id: run.id,
    task: run.task,
    status: run.status,
    summary: run.summary,
    columns: run.lanes.map((lane) => ({
      lane: lane.lane,
      letter: lane.letter,
      label: variantLabel(lane.variant),
      rank: lane.rank,
      state: winner === lane.lane ? WINNER_BADGE : LANE_BADGES[lane.status],
      winner: winner === lane.lane,
    })),
    files,
    winner,
    focus: shownFocus,
    // A selection that no longer fits the compare, such as one made before a newer pick, is dropped.
    selected: selected !== undefined && files.some((file) => file.cells.some((cell) => cell.hunks.some((h) => h.graftable && selected.hunks.includes(h.id)))) ? selected : undefined,
  };
}

/** A hunk's lines as the compare prints them: removed lines, then added ones, each with its sign. */
export function hunkLines({ oldText, newText }: Pick<CompareHunk, 'oldText' | 'newText'>): { readonly sign: '-' | '+'; readonly text: string }[] {
  const lines = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));
  return [...lines(oldText).map((text) => ({ sign: '-' as const, text })), ...lines(newText).map((text) => ({ sign: '+' as const, text }))];
}

export const graftLabel = (selected: GraftSelection, letter: string | undefined): string =>
  selected === undefined ? 'Graft hunks' : `Graft ${selected.hunks.length} ${selected.hunks.length === 1 ? 'hunk' : 'hunks'} from ${letter ?? selected.lane}`;
