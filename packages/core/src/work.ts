import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { isJobId, type JobId, type JobState } from './background.js';
import type { ChildStatus } from './subagent.js';
import { isWakeId, type WakeId } from './wake.js';

/**
 * A session's background work as the model controls it (P19): `list_agents` lists its subagents, background commands
 * and pending wakes, and `task_stop` stops one by the id it was started with.
 */

export const TASK_STOP_TOOL = 'task_stop';
export const LIST_AGENTS_TOOL = 'list_agents';

/** What a task_stop id names: a background command, a monitor, wake-up or PR watch, or a subagent's session. */
export type TaskRef = { readonly kind: 'job'; readonly id: JobId } | { readonly kind: 'wake'; readonly id: WakeId } | { readonly kind: 'child'; readonly id: string };

const SESSION_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function taskRefOf(raw: string): TaskRef | undefined {
  if (isJobId(raw)) return { kind: 'job', id: raw };
  if (isWakeId(raw)) return { kind: 'wake', id: raw };
  return SESSION_ID.test(raw) ? { kind: 'child', id: raw } : undefined;
}

/** One line of list_agents. Times are ms since the epoch. */
export type WorkRow =
  | {
      readonly kind: 'child';
      readonly id: string;
      readonly role: string;
      readonly status: ChildStatus;
      readonly model: string;
      readonly turns: number;
      readonly costUsd: number | null;
      readonly startedAt: number;
    }
  | { readonly kind: 'job'; readonly id: JobId; readonly command: string; readonly state: JobState; readonly startedAt: number; readonly outputFile: string }
  | { readonly kind: 'monitor'; readonly id: WakeId; readonly job: JobId; readonly pattern: string; readonly startedAt: number }
  | { readonly kind: 'schedule'; readonly id: WakeId; readonly dueAt: number; readonly reason: string; readonly startedAt: number }
  | { readonly kind: 'pr'; readonly id: WakeId; readonly pr: number; readonly startedAt: number };

const JOB_STATUS: { readonly [K in JobState['status']]: (state: Extract<JobState, { status: K }>) => string } = {
  running: () => 'running',
  exited: ({ exitCode, signal }) => (exitCode === 0 ? 'done' : `failed (${exitCode === null ? `killed by ${signal ?? 'a signal'}` : `exit code ${exitCode}`})`),
  stopped: ({ by }) => (by === 'user' ? 'cancelled by the user' : 'cancelled'),
  killed: () => 'interrupted',
};

const CHILD_STATUS: { readonly [K in ChildStatus['kind']]: (status: Extract<ChildStatus, { kind: K }>) => string } = {
  running: () => 'running',
  done: () => 'done',
  failed: ({ reason }) => `failed (${reason})`,
  cancelled: ({ by }) => (by === 'model' ? 'cancelled' : 'cancelled by the user'),
  capped: ({ cap }) => `capped at its ${cap === 'turns' ? 'turn' : 'cost'} limit`,
  interrupted: () => 'interrupted',
};

/** Where a row is, in the words of a child's status; `pending` is a wake-up not yet due. */
const statusText = (row: WorkRow): string => {
  if (row.kind === 'child') return (CHILD_STATUS[row.status.kind] as (s: ChildStatus) => string)(row.status);
  if (row.kind === 'job') return (JOB_STATUS[row.state.status] as (s: JobState) => string)(row.state);
  return row.kind === 'schedule' ? 'pending' : 'running';
};

const isLive = (row: WorkRow): boolean => {
  const status = statusText(row);
  return status === 'running' || status === 'pending';
};

/** A span as list_agents shows it: whole seconds, then whole minutes, then whole hours. */
export function spanText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
}

const cost = (usd: number | null): string => (usd === null ? 'cost unknown' : `$${usd.toFixed(4)}`);

function rowText(row: WorkRow, now: number): string {
  const age = `started ${spanText(now - row.startedAt)} ago`;
  const status = statusText(row);
  switch (row.kind) {
    case 'child':
      return `- ${row.id}: ${row.role} subagent, ${status}. ${row.model}, ${row.turns} ${row.turns === 1 ? 'turn' : 'turns'}, ${cost(row.costUsd)}, ${age}`;
    case 'job':
      return `- ${row.id}: background command \`${row.command}\`, ${status}, ${age}. Output: ${row.outputFile}`;
    case 'monitor':
      return `- ${row.id}: monitor on ${row.job} for /${row.pattern}/, ${status}, ${age}`;
    case 'schedule':
      return `- ${row.id}: wake-up, ${status}, due in ${spanText(row.dueAt - now)}: ${row.reason}`;
    case 'pr':
      return `- ${row.id}: watch of PR #${row.pr}'s checks, ${status}, ${age}`;
  }
}

/** What list_agents returns: every row, newest first, and how to stop one while any is live. */
export function workListText(rows: readonly WorkRow[], now: number): string {
  if (rows.length === 0) return 'This session has no subagents and no background commands, monitors, wake-ups or PR watches.';
  const lines = rows.toSorted((a, b) => b.startedAt - a.startedAt).map((row) => rowText(row, now));
  return [
    "This session's subagents and background work, newest first:",
    ...lines,
    ...(rows.some(isLive) ? ['Stop a running or pending one with task_stop and its id.'] : []),
  ].join('\n');
}

export const TASK_STOP_TOOL_DEFINITION: Tool = {
  name: TASK_STOP_TOOL,
  description:
    "Stop background work by the id it started with: a background command (bg-1), a monitor, wake-up or PR watch (wake-1), or a subagent running in the background (its session id). A command gets SIGTERM, then SIGKILL a few seconds later, and the result has the end of its output. A stopped monitor, wake-up or watch never wakes you. A stopped subagent's partial report is the result, with status cancelled, and no other report of it arrives. list_agents shows the ids.",
  input_schema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'What to stop: bg-1, wake-1, or a subagent session id.' } },
    required: ['id'],
    additionalProperties: false,
  },
};

export const LIST_AGENTS_TOOL_DEFINITION: Tool = {
  name: LIST_AGENTS_TOOL,
  description:
    "List this session's subagents and background work, newest first: each subagent with its status (running, done, failed, cancelled, capped or interrupted), model, spend and age; each background command with its status and output file; and each pending monitor, wake-up and PR watch. Takes no input.",
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
};
