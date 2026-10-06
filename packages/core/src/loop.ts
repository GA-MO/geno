import type { StopReason, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { IN_CONVERSATION, KEEPS_PENDING_PROMPT, toolUsesOf, type TurnErrorKind, type TurnEvent } from './session.js';

export const DONE_REASONS = ['end_turn', 'max-turns', 'budget', 'refusal', 'error'] as const;
export type DoneReason = (typeof DONE_REASONS)[number];

export type LoopStep =
  | { readonly kind: 'call-model' }
  | { readonly kind: 'run-tools'; readonly toolUses: readonly ToolUseBlock[] }
  | { readonly kind: 'done'; readonly reason: DoneReason };

/** One `ask` run: the events from `firstSeq` on, and the limits on its model calls. */
export type Run = {
  readonly firstSeq: number;
  readonly maxTurns: number;
  readonly maxCostUsd: number;
};

const CALL: LoopStep = { kind: 'call-model' };
const done = (reason: DoneReason): LoopStep => ({ kind: 'done', reason });

const ERROR_REASON: Record<TurnErrorKind, DoneReason> = {
  refusal: 'refusal',
  transport: 'error',
  overflow: 'error',
  abort: 'error',
  'max-turns': 'max-turns',
  budget: 'budget',
};

const AFTER_STOP: Record<StopReason, LoopStep> = {
  end_turn: done('end_turn'),
  stop_sequence: done('end_turn'),
  pause_turn: CALL,
  // A tool_use stop with tool uses never gets here: those run first.
  tool_use: done('error'),
  max_tokens: done('error'),
  refusal: done('refusal'),
  model_context_window_exceeded: done('error'),
};

type ConversationEvent = Exclude<TurnEvent, { kind: 'checkpoint' | 'restored' | 'review' | 'retry' | 'mode' | 'effort' | 'title' | 'child-start' | 'child-end' | 'lane-apply' | 'background-end' | 'wait' }>;
type EventOf<K extends ConversationEvent['kind']> = Extract<ConversationEvent, { kind: K }>;

const isConversation = (event: TurnEvent): event is ConversationEvent => IN_CONVERSATION[event.kind];

const AFTER_EVENT: { [K in ConversationEvent['kind']]: (event: EventOf<K>) => LoopStep } = {
  'session-start': () => done('end_turn'),
  user: () => CALL,
  'tool-result': () => CALL,
  assistant: ({ stopReason }) => (stopReason === null ? done('error') : AFTER_STOP[stopReason]),
  error: ({ error }) => done(ERROR_REASON[error]),
};

const after = <K extends ConversationEvent['kind']>(event: EventOf<K>): LoopStep =>
  (AFTER_EVENT[event.kind] as (e: EventOf<K>) => LoopStep)(event);

// An interruption logged by an earlier run is what this run resumes from, so it does not end this one.
function lastLiveEvent(events: readonly TurnEvent[], run: Run): ConversationEvent {
  const live = events.findLast(
    (e): e is ConversationEvent =>
      isConversation(e) && !(e.kind === 'error' && e.seq < run.firstSeq && KEEPS_PENDING_PROMPT[e.error]),
  );
  return live ?? (events[0] as ConversationEvent);
}

/** Tool uses of the newest assistant turn that have no logged result yet, in the order the model sent them. */
export function pendingToolUses(events: readonly TurnEvent[]): ToolUseBlock[] {
  const index = events.findLastIndex((e) => e.kind === 'assistant');
  const assistant = events[index];
  if (assistant?.kind !== 'assistant') return [];
  const answered = new Set(events.slice(index + 1).flatMap((e) => (e.kind === 'tool-result' ? [e.toolUseId] : [])));
  return toolUsesOf(assistant.content).filter((use) => !answered.has(use.id));
}

function limitReached(events: readonly TurnEvent[], run: Run): LoopStep | undefined {
  const calls = events.filter((e) => e.kind === 'assistant' && e.seq >= run.firstSeq);
  if (calls.length >= run.maxTurns) return done('max-turns');
  // An unpriced call counts as free here; its usage line still prints cost=unknown.
  const cost = calls.reduce((sum, e) => sum + (e.kind === 'assistant' ? (e.costUsd ?? 0) : 0), 0);
  if (cost > run.maxCostUsd) return done('budget');
  return undefined;
}

export function loopStep(events: readonly TurnEvent[], run: Run): LoopStep {
  const last = lastLiveEvent(events, run);
  if (last.kind === 'error') return after(last);
  const toolUses = pendingToolUses(events);
  if (toolUses.length > 0) return { kind: 'run-tools', toolUses };
  const step = after(last);
  return step.kind === 'call-model' ? (limitReached(events, run) ?? step) : step;
}
