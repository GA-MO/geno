import type { TaskRecord, TaskStatus } from './tasks.js';
import type { WakeView } from './wake.js';

/**
 * Which sessions wait on the user. The Tasks list puts each top-level task, with its subagents or Arena lanes rolled
 * into it, in one of four sections, and orders each section by when the task last came back to the user. The
 * webview bundles this file, so it imports only types.
 */

/** A task whose turn has not ended. */
export const isLive = (status: TaskStatus): boolean => status === 'running' || status === 'needs-input' || status === 'waiting';

/**
 * What a task wants from the user, most urgent first: a card to answer, a failure to read, subagents a stop of Geno
 * cut off to resume or leave, a limit to retry, or wakes paused at their hourly cap.
 */
export const NEEDS_YOU_REASONS = ['permission', 'question', 'failed', 'interrupted', 'limited', 'paused'] as const;
export type NeedsYouReason = (typeof NEEDS_YOU_REASONS)[number];

/** The card a `needs-input` task shows. */
export type Asking = Extract<NeedsYouReason, 'permission' | 'question'>;

export type Attention =
  /** `at` is the session that shows what to answer: the task's own, or the Arena lane that asks. */
  | { readonly kind: 'needs-you'; readonly reason: NeedsYouReason; readonly at: string }
  /** Finished with results the user has not opened since. */
  | { readonly kind: 'ready' }
  /** Running, or waiting for a call that goes out again by itself. */
  | { readonly kind: 'working' }
  /** Ended, and seen since; or stopped by the user. */
  | { readonly kind: 'done' };

export const SECTIONS = ['needs-you', 'ready', 'working', 'done'] as const satisfies readonly Attention['kind'][];
export type Section = (typeof SECTIONS)[number];

/** A permission and a question share the first tier. */
const TIER: { readonly [R in NeedsYouReason]: number } = { permission: 0, question: 0, failed: 1, interrupted: 1, limited: 2, paused: 2 };

/** Which of a task's and its children's states the task shows: the most urgent, where a running child outranks a finished parent. */
const urgency = (attention: Attention): number =>
  attention.kind === 'needs-you' ? TIER[attention.reason] : { working: 3, ready: 4, done: 5 }[attention.kind];

/** Where a child's question shows: a subagent asks on its parent's card, an Arena lane in its own session. */
const ANSWERED_IN: { readonly [K in TaskKind]: 'own' | 'parent' } = { session: 'own', subagent: 'parent', arena: 'own' };

/** `session`: a chat or a lane's session. `subagent`: a child inside a parent's tool call. `arena`: a best-of-n run, whose children are its lanes. */
export const TASK_KINDS = ['session', 'subagent', 'arena'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** A model call held for the user's Retry now; a call that will go out by itself is still work. */
const holds = (task: Pick<TaskRecord, 'status' | 'waiting'>): boolean => task.status === 'waiting' && task.waiting?.retryAt === null;

/** The task is the user's turn: it asks, holds at a limit, or ended. */
export const isWithUser = (task: Pick<TaskRecord, 'status' | 'waiting'>): boolean => (task.status !== 'running' && task.status !== 'waiting') || holds(task);

/**
 * When the task last came back to the user: now, as it becomes the user's turn or its status changes while it is;
 * otherwise whatever it was before. Null for a task that has not come back yet.
 */
export const returnedAtOf = (before: TaskRecord | undefined, after: TaskRecord, now: number): number | null =>
  isWithUser(after) && (before === undefined || !isWithUser(before) || before.status !== after.status) ? now : (before?.returnedAt ?? null);

const returned = (task: TaskRecord): number => task.returnedAt ?? task.endedAt ?? task.startedAt;

/** A turn that ended while background work it started will wake the session again. */
export const isWaking = (wake: WakeView | undefined): boolean => wake !== undefined && wake.paused === undefined && wake.waitsFor.length > 0;

/** A task's own state, without its children. `seen` says the user opened it after it last came back. */
function ownAttention(task: TaskRecord, seen: boolean): Attention {
  if (!isLive(task.status) && task.wake?.paused === 'cap') return { kind: 'needs-you', reason: 'paused', at: task.sessionId };
  // Nothing resumes a subagent that was cut off but the user or the session's model, so it waits on the user, seen or not.
  if (!isLive(task.status) && (task.interrupted?.length ?? 0) > 0) return { kind: 'needs-you', reason: 'interrupted', at: task.sessionId };
  if (!isLive(task.status) && isWaking(task.wake)) return { kind: 'working' };
  switch (task.status) {
    case 'needs-input':
      return { kind: 'needs-you', reason: task.asking ?? 'permission', at: task.sessionId };
    case 'waiting':
      return holds(task) ? { kind: 'needs-you', reason: 'limited', at: task.sessionId } : { kind: 'working' };
    case 'running':
      return { kind: 'working' };
    case 'failed':
      return seen ? { kind: 'done' } : { kind: 'needs-you', reason: 'failed', at: task.sessionId };
    case 'done':
      return seen ? { kind: 'done' } : { kind: 'ready' };
    case 'stopped':
      return { kind: 'done' };
  }
}

/** A task, its children, and when the user last opened it; undefined for never. */
export type AttentionInput = { readonly task: TaskRecord; readonly children: readonly TaskRecord[]; readonly seenAt: number | undefined };

/** `key` sorts ascending: the section, the reason's tier within Needs you, then the newest return first. */
export type Placement = { readonly attention: Attention; readonly returnedAt: number; readonly key: readonly [number, number, number] };

/**
 * A task's section and sort key. A live child rolls up into it: a subagent or lane that asks, or holds at a limit,
 * puts the task in Needs you, and one that runs keeps it Working. A child that ended says nothing; the parent goes on.
 */
export function placeTask({ task, children, seenAt }: AttentionInput): Placement {
  const returnedAt = Math.max(returned(task), ...children.map(returned));
  const own = ownAttention(task, seenAt !== undefined && seenAt >= returnedAt);
  const fromChildren = children.filter((child) => isLive(child.status)).map((child): Attention => {
    const attention = ownAttention(child, false);
    return attention.kind === 'needs-you' && ANSWERED_IN[child.kind ?? 'session'] === 'parent' ? { ...attention, at: task.sessionId } : attention;
  });
  const attention = fromChildren.reduce((best, next) => (urgency(next) < urgency(best) ? next : best), own);
  return { attention, returnedAt, key: [SECTIONS.indexOf(attention.kind), attention.kind === 'needs-you' ? TIER[attention.reason] : 0, -returnedAt] };
}

export type PlacedTask = Placement & { readonly task: TaskRecord; readonly children: readonly TaskRecord[] };

const compareKeys = (a: readonly number[], b: readonly number[]): number => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
};

/**
 * Every top-level task with its children, placed and sorted. A child whose parent the list no longer holds, such as
 * an Arena lane after its engine restarted, stands on its own.
 */
export function placeTasks(tasks: readonly TaskRecord[], seen: Readonly<Record<string, number>>): PlacedTask[] {
  const ids = new Set(tasks.map((task) => task.sessionId));
  const isChild = (task: TaskRecord): boolean => task.parent != null && ids.has(task.parent);
  return tasks
    .filter((task) => !isChild(task))
    .map((task) => {
      const children = tasks.filter((child) => child.parent === task.sessionId);
      return { task, children, ...placeTask({ task, children, seenAt: seen[task.sessionId] }) };
    })
    .toSorted((a, b) => compareKeys(a.key, b.key));
}

/** How many top-level tasks need the user, for the view's badge. */
export const needsYouCount = (placed: readonly PlacedTask[]): number => placed.filter((p) => p.attention.kind === 'needs-you').length;
