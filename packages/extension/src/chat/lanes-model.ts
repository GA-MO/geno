import type { Attention, CheckOutcome, LaneInfo, LaneStatus, NeedsYouReason, PlacedTask, Section, TaskRecord, TaskStatus } from '@g-code/core';
import { placeTasks, SECTIONS } from '@g-code/core/attention';
import { EXTERNAL_BACKENDS } from '@g-code/core/backends';
import { waitLabel } from '@g-code/core/waiting';
import { clockOf, formatCost, formatDuration } from './format.js';

/**
 * The Lanes and Tasks panes' view models: pure functions from what the engine reports to what each row shows. The
 * webview bundles this file, so it imports only types and other pure webview modules.
 */

/** What the Lanes pane shows: nothing yet, the engine's answer, or why it failed. */
export type LanesListing = { readonly kind: 'loading' } | { readonly kind: 'loaded'; readonly lanes: readonly LaneInfo[] } | { readonly kind: 'failed'; readonly message: string };

export type LanesToView =
  | { readonly type: 'lanes'; readonly listing: LanesListing }
  | { readonly type: 'show-lanes' }
  /** Every task the engine knows, the session the panel shows, and when the user last opened each. */
  | { readonly type: 'tasks'; readonly tasks: readonly TaskRecord[]; readonly shown: string | undefined; readonly seen: SeenMarkers }
  | { readonly type: 'show-tasks' }
  /** A task opened from the list: show what it needs of the user. */
  | { readonly type: 'task-reveal'; readonly reveal: Reveal };

export type LanesFromView =
  | { readonly type: 'lanes-list' }
  /** Runs the draft as the task of a new lane, in the background. */
  | { readonly type: 'lane-new'; readonly text: string }
  /** Opens the lane's session in the panel. */
  | { readonly type: 'lane-open'; readonly name: string }
  /** Applies the lane into the main checkout, as a turn of the shown chat. */
  | { readonly type: 'lane-apply'; readonly name: string }
  /** `discardChanges` is the user's yes to the confirm a lane with changes asks. */
  | { readonly type: 'lane-discard'; readonly name: string; readonly discardChanges: boolean }
  /** Opens a top-level task at what it needs of the user. */
  | { readonly type: 'task-open'; readonly sessionId: string }
  /** The user looked at an Arena run in its pane. */
  | { readonly type: 'task-seen'; readonly id: string }
  | { readonly type: 'task-stop'; readonly sessionId: string }
  /** Opens the session a fork came from, from the fork's row. */
  | { readonly type: 'task-origin'; readonly sessionId: string; readonly workspace: string };

export type Tone = 'ok' | 'wait' | 'busy' | 'failed' | 'quiet';
export type Badge = { readonly label: string; readonly tone: Tone };

/** A task's status as a badge; the same in both panes. */
export const TASK_BADGES: { readonly [S in TaskStatus]: Badge } = {
  running: { label: 'Running', tone: 'busy' },
  'needs-input': { label: 'Needs your answer', tone: 'wait' },
  waiting: { label: 'Waiting', tone: 'wait' },
  done: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed', tone: 'failed' },
  stopped: { label: 'Stopped', tone: 'quiet' },
};

/** A lane whose task the engine no longer knows, such as after it restarted, reads by what its folder holds. */
const LANE_BADGES: { readonly [S in LaneStatus]: Badge } = {
  changed: { label: 'Has changes', tone: 'ok' },
  clean: { label: 'No changes', tone: 'quiet' },
  missing: { label: 'Folder missing', tone: 'failed' },
};

const CHECK_BADGES: { readonly [C in CheckOutcome]: Badge } = {
  passed: { label: 'Check passed', tone: 'ok' },
  failed: { label: 'Check failed', tone: 'failed' },
  none: { label: 'No check', tone: 'quiet' },
};

/** `discard` is `confirm` for a lane with work to lose, which asks before it goes. */
export type LaneActions = { readonly open: boolean; readonly apply: boolean; readonly discard: 'off' | 'plain' | 'confirm' };

export type LaneRow = {
  readonly name: string;
  readonly task: string;
  readonly state: Badge;
  readonly diff: string;
  /** For a screen reader and the tooltip: the diff in words. */
  readonly diffTitle: string;
  readonly check: Badge;
  readonly cost: string | undefined;
  readonly actions: LaneActions;
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const isLiveStatus = (status: TaskStatus | null): boolean => status === 'running' || status === 'needs-input' || status === 'waiting';

export function laneRowOf(lane: LaneInfo): LaneRow {
  const live = isLiveStatus(lane.task);
  const { files, added, removed } = lane.diff;
  return {
    name: lane.name,
    task: lane.session?.title ?? 'No task yet',
    state: lane.task === null ? LANE_BADGES[lane.status] : TASK_BADGES[lane.task],
    diff: files === 0 ? 'No changes' : `+${added} −${removed} · ${plural(files, 'file')}`,
    diffTitle: files === 0 ? 'No changes since the lane started' : `${plural(added, 'line')} added and ${plural(removed, 'line')} removed in ${plural(files, 'file')}`,
    check: CHECK_BADGES[lane.check],
    cost: lane.session?.costUsd == null || lane.session.costUsd === 0 ? undefined : formatCost(lane.session.costUsd),
    actions: {
      open: lane.session !== null && lane.status !== 'missing',
      apply: lane.status === 'changed' && !live,
      discard: live ? 'off' : lane.status === 'changed' ? 'confirm' : 'plain',
    },
  };
}

export type TaskRow = {
  readonly id: string;
  readonly title: string;
  /** The lane it runs in, or the main checkout; an Arena run says how many lanes. */
  readonly where: string;
  readonly state: Badge;
  /** Finished with results the user has not opened. */
  readonly fresh: boolean;
  /** Subagents or lanes rolled into the row, in words; undefined for none. */
  readonly children: string | undefined;
  /** The external agent it runs on; undefined for Geno's own loop. */
  readonly backend: string | undefined;
  /** How long it has run, or ran. */
  readonly time: string;
  readonly cost: string | undefined;
  readonly live: boolean;
  /** Stop is offered: the task runs, and is a session; an Arena run stops from its pane. */
  readonly stop: boolean;
  /** The session the panel shows. */
  readonly current: boolean;
  /** Its background commands that run now, by job id and in words. */
  readonly jobs: readonly { readonly id: string; readonly label: string }[];
  /** The session it was forked from, which the row links to. */
  readonly forkedFrom: { readonly id: string; readonly title: string; readonly workspace: string } | undefined;
};

/** A row in Needs you says what the user is to do, which may be a child's question on a running parent. */
const NEEDS_YOU_BADGES: { readonly [R in Exclude<NeedsYouReason, 'limited'>]: Badge } = {
  permission: { label: 'Needs permission', tone: 'wait' },
  question: { label: 'Needs your answer', tone: 'wait' },
  failed: { label: 'Failed', tone: 'failed' },
};

function stateOf(task: TaskRecord, attention: Attention, now: number, clock: (ms: number) => string): Badge {
  if (task.status === 'waiting' && task.waiting !== undefined) return { label: waitLabel(task.waiting, now, clock), tone: 'wait' };
  if (attention.kind === 'needs-you' && attention.reason !== 'limited') return NEEDS_YOU_BADGES[attention.reason];
  if (attention.kind === 'needs-you') return { label: 'Limited', tone: 'wait' };
  return TASK_BADGES[task.status];
}

function childrenOf({ task, children }: PlacedTask): string | undefined {
  if (children.length === 0) return undefined;
  const running = children.filter((child) => isLiveStatus(child.status)).length;
  if (task.kind === 'arena') return plural(children.length, 'lane');
  return running === 0 ? undefined : `${plural(running, 'agent')} running`;
}

/** Where a task works: its lane, or the main checkout. An external agent always works in a lane, made on its first turn. */
const whereOf = (task: TaskRecord): string => (task.lane !== null ? `Lane ${task.lane}` : task.backend !== undefined ? 'New lane' : 'Main checkout');

export function taskRowOf(placed: PlacedTask, shown: string | undefined, now: number, clock: (ms: number) => string = clockOf): TaskRow {
  const { task, attention } = placed;
  return {
    id: task.sessionId,
    title: task.title,
    where: whereOf(task),
    backend: task.backend === undefined ? undefined : EXTERNAL_BACKENDS[task.backend].label,
    state: stateOf(task, attention, now, clock),
    fresh: attention.kind === 'ready',
    children: childrenOf(placed),
    time: formatDuration((task.endedAt ?? now) - task.startedAt),
    cost: task.usage?.costUsd == null ? undefined : formatCost(task.usage.costUsd),
    live: isLiveStatus(task.status),
    stop: isLiveStatus(task.status) && task.kind !== 'arena',
    current: task.sessionId === shown,
    jobs: (task.jobs ?? []).map((job) => ({ id: job.id, label: job.description ?? job.command })),
    forkedFrom: task.forkedFrom === undefined ? undefined : { id: task.forkedFrom.sessionId, title: task.forkedFrom.title, workspace: task.workspace },
  };
}

/** How many Done rows show before "Show more". */
export const DONE_SHOWN = 5;

export const SECTION_HEADINGS: { readonly [S in Section]: string } = { 'needs-you': 'Needs you', ready: 'Ready', working: 'Working', done: 'Done' };

export type TaskSection = { readonly section: Section; readonly heading: string; readonly rows: readonly TaskRow[] };

/** The Tasks pane's sections in order, each sorted by placement; an empty section is left out. */
export function taskSections(tasks: readonly TaskRecord[], seen: SeenMarkers, shown: string | undefined, now: number, clock: (ms: number) => string = clockOf): TaskSection[] {
  const placed = placeTasks(tasks, seen);
  return SECTIONS.flatMap((section) => {
    const rows = placed.filter((p) => p.attention.kind === section).map((p) => taskRowOf(p, shown, now, clock));
    return rows.length === 0 ? [] : [{ section, heading: SECTION_HEADINGS[section], rows }];
  });
}

/** What opening a task shows: the card to answer, the Retry now of a held limit, or the transcript's end. */
export type Reveal = 'card' | 'retry' | 'end';

export function revealOf(attention: Attention): Reveal {
  if (attention.kind !== 'needs-you') return 'end';
  return attention.reason === 'limited' ? 'retry' : attention.reason === 'failed' ? 'end' : 'card';
}

/** When the user last opened each session or Arena run, in ms since the epoch, by id. */
export type SeenMarkers = Readonly<Record<string, number>>;

/** How many markers are kept, newest first; the engine lists at most 20 ended tasks, with their children. */
const KEPT_SEEN = 200;

/** The markers with `id` seen at `at`, newest first, and no more than `KEPT_SEEN`. A marker never moves back. */
export function markSeen(markers: SeenMarkers, id: string, at: number): SeenMarkers {
  if ((markers[id] ?? -Infinity) >= at) return markers;
  const entries = Object.entries({ ...markers, [id]: at }).toSorted(([, a], [, b]) => b - a);
  return Object.fromEntries(entries.slice(0, KEPT_SEEN));
}
