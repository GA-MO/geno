import { LANE_CONFLICT_REASONS, type LaneConflict, type LaneStatus } from './lanes.js';
import type { TurnEvent } from './session.js';
import type { Waiting } from './waiting.js';

/**
 * Background sessions. The engine runs as one process per workspace that outlives the editor's window, so a turn goes
 * on when the panel closes or the window reloads. Every session that runs a turn in that process is a task.
 */

/**
 * `needs-input`: a permission or a question waits for the user. `waiting`: a model call waits offline or for a rate
 * limit, and the record's `waiting` says which. `stopped`: the user stopped it.
 */
export const TASK_STATUSES = ['running', 'needs-input', 'waiting', 'done', 'failed', 'stopped'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** A task whose turn has not ended. */
export const isLive = (status: TaskStatus): boolean => status === 'running' || status === 'needs-input' || status === 'waiting';

/** A live task that wants the user's eye: a card to answer, or a call held offline or by a limit. */
export const NEEDS_ATTENTION: { readonly [S in TaskStatus]: boolean } = {
  running: false,
  'needs-input': true,
  waiting: true,
  done: false,
  failed: false,
  stopped: false,
};

/** One session's latest turn, as the engine reports it to every editor connected to it. Times are ms since the epoch. */
export type TaskRecord = {
  readonly sessionId: string;
  readonly title: string;
  /** The session's workspace: the main checkout, or a lane's worktree. */
  readonly workspace: string;
  /** The lane the session runs in, or null. */
  readonly lane: string | null;
  readonly status: TaskStatus;
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** The turn's model calls so far; undefined before the first. */
  readonly usage?: TaskUsage | undefined;
  /** What a `waiting` task waits for; absent in every other status. */
  readonly waiting?: Waiting | undefined;
};

/** Tokens in and out of a turn's model calls, and their cost, null for a model with no price. */
export type TaskUsage = { readonly model: string; readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number | null };

/** What a status change tells the user, when it tells anything. */
export type TaskNoticeKind = 'done' | 'needs-input' | 'failed';
export type TaskNotice = { readonly kind: TaskNoticeKind; readonly severity: 'info' | 'warning' | 'error'; readonly verb: string };

/**
 * The notification trigger table: the status a task moves to decides the notice. Moving back to `running` after an
 * answer, and a stop the user made, say nothing. A status that does not change says nothing either.
 */
export const TASK_NOTICES: { readonly [S in TaskStatus]: TaskNotice | undefined } = {
  running: undefined,
  'needs-input': { kind: 'needs-input', severity: 'warning', verb: 'needs your answer' },
  // A dropped connection or a short limit passes by itself; the running row and the tasks list show it.
  waiting: undefined,
  done: { kind: 'done', severity: 'info', verb: 'finished' },
  failed: { kind: 'failed', severity: 'error', verb: 'failed' },
  stopped: undefined,
};

export const taskNotice = (from: TaskStatus | undefined, to: TaskStatus): TaskNotice | undefined => (from === to ? undefined : TASK_NOTICES[to]);

/** Key in the client capabilities' `_meta`, true when the client takes TASK_UPDATE_METHOD notifications. */
export const TASKS_CAPABILITY = 'gcode/tasks';

/** Lists the engine's tasks, newest first. `missed` are the notices no editor was connected to hear, each given once. */
export const TASKS_METHOD = '_gcode/tasks';
export type TasksResponse = { readonly tasks: readonly TaskRecord[]; readonly missed: readonly { readonly sessionId: string; readonly kind: TaskNoticeKind }[] };

/** A notification to every connected editor whenever a task changes. `notice` is the trigger table's verdict. */
export const TASK_UPDATE_METHOD = '_gcode/taskUpdate';
export type TaskUpdate = { readonly task: TaskRecord; readonly notice: TaskNoticeKind | null };

/**
 * The editor no longer shows the session. Its running turn goes on in the background; its questions wait for an editor
 * that shows it again with session/load or session/resume.
 */
export const DETACH_METHOD = '_gcode/detach';
export type DetachRequest = { readonly sessionId: string };

/**
 * An editor's answer to a question about a session it stopped showing before the user answered. The question goes
 * back to waiting, for the next editor that shows the session.
 */
export const NOT_SHOWN_ERROR = { code: -32011, reason: 'not-shown' } as const;

/** In the load and resume responses' `_meta`: the session's turn is still running, and its updates follow live. */
export const RUNNING_META = 'gcode/running';

/** Lines added and removed, over how many files. */
export type DiffStat = { readonly files: number; readonly added: number; readonly removed: number };

/** The lane session's last check after an edit; `none` before any ran. */
export type CheckOutcome = 'passed' | 'failed' | 'none';

const CHECK_LINE = /^check `.*` (passed|failed \(exit [^)]+\)|timed out)$/m;

/** The outcome of the last check a session's edits ran, read from the line `checkHeadline` writes. */
export function checkOutcomeOf(events: readonly TurnEvent[]): CheckOutcome {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind !== 'tool-result' || !('output' in event)) continue;
    const match = CHECK_LINE.exec(event.output);
    if (match !== null) return match[1] === 'passed' ? 'passed' : 'failed';
  }
  return 'none';
}

/** A lane as the Lanes pane lists it: its record, what it changed, and the session that worked in it. */
export type LaneInfo = {
  readonly name: string;
  readonly path: string;
  readonly branch: string;
  readonly status: LaneStatus;
  readonly createdAt: string;
  readonly diff: DiffStat;
  readonly check: CheckOutcome;
  /** The lane's session: its task is its title, and its spend so far. */
  readonly session: { readonly id: string; readonly title: string; readonly turns: number; readonly costUsd: number | null } | null;
  /** The session's turn, while the engine knows it. */
  readonly task: TaskStatus | null;
};

export const LANES_METHOD = '_gcode/lanes';
export type LanesRequest = { readonly cwd: string };
export type LanesResponse = { readonly lanes: readonly LaneInfo[] };

/** Makes a lane from the main checkout's HEAD and runs `prompt` in it as a background task. */
export const LANE_NEW_METHOD = '_gcode/lanes/new';
export type LaneNewRequest = { readonly cwd: string; readonly prompt: string; readonly mode?: string | undefined };
export type LaneNewResponse = { readonly name: string; readonly sessionId: string };

/** Removes a lane. One with changes needs `discardChanges`, the user's yes to a confirm. */
export const LANE_DISCARD_METHOD = '_gcode/lanes/discard';
export type LaneDiscardRequest = { readonly cwd: string; readonly name: string; readonly discardChanges: boolean };

/** In a session/prompt's `_meta`: apply this lane into the session's workspace, as changes for review, instead of a model turn. */
export const LANE_APPLY_META = 'gcode/laneApply';

/** What an apply wrote, or why it wrote nothing, as the apply step's result in the session log. */
/** `grafted` is how many of the lane's hunks a graft took; absent for an apply of the whole lane. */
export type LaneApplyRecord = { readonly lane: string; readonly conflicts: readonly LaneConflict[]; readonly deleted: readonly string[]; readonly grafted?: number | undefined };

/** The prompt an apply shows as, in the panel and in a replay. */
export const laneApplyPrompt = (lane: string, grafted?: number): string =>
  grafted === undefined ? `Apply lane ${lane}` : `Graft ${grafted} ${grafted === 1 ? 'hunk' : 'hunks'} from lane ${lane}`;

/** What a lane apply says in the chat, live and replayed; `written` is how many files it wrote. */
export function laneApplyText({ lane, conflicts, deleted, grafted }: LaneApplyRecord, written: number): string {
  const verb = grafted === undefined ? 'applied' : 'grafted';
  if (conflicts.length > 0) {
    const lines = conflicts.map((conflict) => `- \`${conflict.path}\`: ${LANE_CONFLICT_REASONS[conflict.reason]}`);
    const count = conflicts.length === 1 ? '1 file conflicts' : `${conflicts.length} files conflict`;
    return [`Nothing from lane ${lane} was ${verb}: ${count} with the main checkout.`, ...lines].join('\n');
  }
  const files = written + deleted.length;
  if (files === 0) return `Lane ${lane} has nothing to apply.`;
  const gone = deleted.length === 0 ? '' : ` Deleted ${deleted.map((file) => `\`${file}\``).join(', ')}.`;
  const what = grafted === undefined ? '' : `${grafted === 1 ? '1 hunk' : `${grafted} hunks`} in `;
  return `${grafted === undefined ? 'Applied' : 'Grafted'} ${what}${files === 1 ? '1 file' : `${files} files`} from lane ${lane}. Keep or undo each change.${gone}`;
}
