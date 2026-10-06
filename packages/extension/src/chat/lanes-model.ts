import type { CheckOutcome, LaneInfo, LaneStatus, TaskRecord, TaskStatus } from '@g-code/core';
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
  /** Every task the engine knows, and the session the panel shows. */
  | { readonly type: 'tasks'; readonly tasks: readonly TaskRecord[]; readonly shown: string | undefined }
  | { readonly type: 'show-tasks' };

export type LanesFromView =
  | { readonly type: 'lanes-list' }
  /** Runs the draft as the task of a new lane, in the background. */
  | { readonly type: 'lane-new'; readonly text: string }
  /** Opens the lane's session in the panel. */
  | { readonly type: 'lane-open'; readonly name: string }
  /** Applies the lane into the main checkout, as changes for review in the shown chat. */
  | { readonly type: 'lane-apply'; readonly name: string }
  /** `discardChanges` is the user's yes to the confirm a lane with changes asks. */
  | { readonly type: 'lane-discard'; readonly name: string; readonly discardChanges: boolean }
  | { readonly type: 'task-open'; readonly sessionId: string }
  | { readonly type: 'task-stop'; readonly sessionId: string };

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
  /** The lane it runs in, or the main checkout. */
  readonly where: string;
  readonly state: Badge;
  /** How long it has run, or ran. */
  readonly time: string;
  readonly cost: string | undefined;
  readonly live: boolean;
  /** The session the panel shows. */
  readonly current: boolean;
  /** Its background commands that run now, by job id and in words. */
  readonly jobs: readonly { readonly id: string; readonly label: string }[];
};

export function taskRowOf(task: TaskRecord, shown: string | undefined, now: number, clock: (ms: number) => string = clockOf): TaskRow {
  return {
    id: task.sessionId,
    title: task.title,
    where: task.lane === null ? 'Main checkout' : `Lane ${task.lane}`,
    state: task.status === 'waiting' && task.waiting !== undefined ? { label: waitLabel(task.waiting, now, clock), tone: 'wait' } : TASK_BADGES[task.status],
    time: formatDuration((task.endedAt ?? now) - task.startedAt),
    cost: task.usage?.costUsd == null ? undefined : formatCost(task.usage.costUsd),
    live: isLiveStatus(task.status),
    current: task.sessionId === shown,
    jobs: (task.jobs ?? []).map((job) => ({ id: job.id, label: job.description ?? job.command })),
  };
}

/** Running tasks first, then the rest, newest first. */
export const taskOrder = (tasks: readonly TaskRecord[]): TaskRecord[] =>
  tasks.toSorted((a, b) => Number(isLiveStatus(b.status)) - Number(isLiveStatus(a.status)) || b.startedAt - a.startedAt);
