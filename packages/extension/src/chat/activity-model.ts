import type { TaskRecord } from '@g-code/core';
import { isLive, isWaking, placeTasks, type NeedsYouReason, type PlacedTask } from '@g-code/core/attention';
import { waitsForText } from '@g-code/core/wake';
import { clockOf } from './format.js';
import type { SeenMarkers } from './lanes-model.js';
import type { Transcript } from './messages.js';
import { runningChildren } from './transcript.js';

/**
 * The composer row's one pill and one label, as Claude Code's running line has them: how much runs beside this chat
 * and how much waits on the user, then a label only for what the transcript above does not show: the top task of Needs you, or what this chat waits on to be woken. The webview bundles this file, so it imports
 * only types and other pure webview modules.
 */

/** Every task the engine knows, when the user last opened each, and the session the panel shows. */
export type Background = { readonly tasks: readonly TaskRecord[]; readonly seen: SeenMarkers; readonly shown: string | undefined };

export const NO_BACKGROUND: Background = { tasks: [], seen: {}, shown: undefined };

export type ActivityView = {
  /** Tasks at work beside this chat's own turn: other sessions and lanes, and this chat's subagents. */
  readonly running: number;
  /** Top-level tasks in Needs you, this chat among them; the same number as the view's badge. */
  readonly needsYou: number;
  /** The pill's words, such as "3 running · 1 needs you". */
  readonly text: string;
  /** Undefined when nothing stands out. `tone` is `needs-you` for the top task of Needs you, `working` for what this chat waits on to be woken. */
  readonly label: { readonly text: string; readonly tone: 'needs-you' | 'working' } | undefined;
};

const needWord = (n: number): string => `${n} ${n === 1 ? 'needs' : 'need'} you`;

/** Where a task runs, in a label's few words: here, its lane, or its title. */
const whereOf = (task: TaskRecord, shown: string | undefined): string => (task.sessionId === shown ? 'this chat' : (task.lane ?? task.title));

const NEEDS_YOU_LABELS: { readonly [R in NeedsYouReason]: (where: string) => string } = {
  permission: (where) => `Waiting for your approval in ${where}`,
  question: (where) => `Waiting for your answer in ${where}`,
  failed: (where) => `Failed in ${where}`,
  interrupted: (where) => `Subagents cut off in ${where}`,
  limited: (where) => `Held at a rate limit in ${where}`,
  paused: (where) => `Wake-ups paused in ${where}`,
};

/** A session whose turn ended and that waits for its background work to wake it, which counts as running. */
const waitsToWake = (task: TaskRecord): boolean => !isLive(task.status) && isWaking(task.wake);

const isAtWork = (placed: PlacedTask): boolean =>
  placed.attention.kind === 'working' && (isLive(placed.task.status) || placed.children.some((child) => isLive(child.status)) || waitsToWake(placed.task));

/** The pill and its label; undefined while nothing runs beside the chat and nothing waits on the user. */
export function activityOf(transcript: Transcript, { tasks, seen, shown }: Background): ActivityView | undefined {
  const placed = placeTasks(tasks, seen);
  const others = placed.filter((p) => p.task.sessionId !== shown && isAtWork(p));
  // The shown chat has no clock while it waits to be woken, so the pill counts it; its subagents count themselves.
  const here = placed.find((p) => p.task.sessionId === shown && waitsToWake(p.task));
  const running = others.length + Math.max(runningChildren(transcript).length, here === undefined ? 0 : 1);
  const asking = placed.filter((p) => p.attention.kind === 'needs-you');
  if (running === 0 && asking.length === 0) return undefined;
  const text = [running > 0 ? `${running} running` : undefined, asking.length > 0 ? needWord(asking.length) : undefined].filter(Boolean).join(' · ');
  const top = asking[0];
  const label: ActivityView['label'] =
    top?.attention.kind === 'needs-you'
      ? { text: NEEDS_YOU_LABELS[top.attention.reason](whereOf(top.task, shown)), tone: 'needs-you' }
      : here !== undefined
        ? { text: waitsForText(here.task.wake!.waitsFor, clockOf), tone: 'working' }
        : undefined;
  return { running, needsYou: asking.length, text, label };
}
