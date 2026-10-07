import type { StopReason, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { IN_CONVERSATION, KEEPS_PENDING_PROMPT, spendOf, toolUsesOf, type ToolResultEvent, type TurnErrorKind, type TurnEvent } from './session.js';

export const DONE_REASONS = ['end_turn', 'max-turns', 'budget', 'refusal', 'error'] as const;
export type DoneReason = (typeof DONE_REASONS)[number];

/** A tool use the loop answers with an error instead of running it. */
export type ToolAnswer = { readonly use: ToolUseBlock; readonly text: string };

export type LoopStep =
  | { readonly kind: 'call-model' }
  | { readonly kind: 'run-tools'; readonly toolUses: readonly ToolUseBlock[] }
  | { readonly kind: 'answer-tools'; readonly answers: readonly ToolAnswer[] }
  | { readonly kind: 'done'; readonly reason: DoneReason };

/** What a call the user turned down tells the model, as Claude Code's rejection does. */
export const STOP_AND_WAIT = 'STOP what you are doing and wait for the user to tell you how to proceed.';

/** Worded after Claude Code's interrupt, output-limit and rejection results, so the model knows why a call has no output. */
export const UNRUN_TEXTS = {
  stopped: '[Request interrupted by user for tool use] The user stopped this call while it ran, so it may have partly run.',
  'not-started': '[Request interrupted by user for tool use] The user stopped the turn before this call started, so it did not run.',
  'cut-off': 'Your response hit the output limit and cut this tool call short, so it did not run. Continue, and keep each tool call smaller.',
  rejected: `The user rejected an earlier call of this turn, so this one did not run. ${STOP_AND_WAIT}`,
} as const;

/** The answers to calls the user stopped, so no later run runs them: `started` tells a call that began from one that never did. */
export const stoppedAnswers = (uses: readonly ToolUseBlock[], started: (id: string) => boolean): ToolAnswer[] =>
  uses.map((use) => ({ use, text: started(use.id) ? UNRUN_TEXTS.stopped : UNRUN_TEXTS['not-started'] }));

export const answerEvent = ({ use, text }: ToolAnswer, seq: number, at: string): ToolResultEvent => ({
  kind: 'tool-result',
  seq,
  at,
  toolUseId: use.id,
  name: use.name,
  status: 'error',
  output: text,
});

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

type ConversationEvent = Exclude<TurnEvent, { kind: 'checkpoint' | 'restored' | 'review' | 'retry' | 'mode' | 'notice' | 'effort' | 'title' | 'child-start' | 'child-end' | 'lane-apply' | 'background-end' | 'wait' | 'wake' | 'backend-start' | 'backend-model' | 'spinoff' | 'chapter' | 'cut' | 'compact' | 'file-changed' }>;
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

type AssistantEvent = EventOf<'assistant'>;

/** The newest model turn, and what the log holds after it. */
function newestTurn(events: readonly TurnEvent[]): { readonly turn: AssistantEvent; readonly after: readonly TurnEvent[] } | undefined {
  const index = events.findLastIndex((e) => e.kind === 'assistant');
  const turn = events[index];
  return turn?.kind === 'assistant' ? { turn, after: events.slice(index + 1) } : undefined;
}

/** Tool uses of the newest assistant turn that have no logged result yet, in the order the model sent them. */
export function pendingToolUses(events: readonly TurnEvent[]): ToolUseBlock[] {
  const newest = newestTurn(events);
  if (newest === undefined) return [];
  const answered = new Set(newest.after.flatMap((e) => (e.kind === 'tool-result' ? [e.toolUseId] : [])));
  return toolUsesOf(newest.turn.content).filter((use) => !answered.has(use.id));
}

/** The tool use a max_tokens stop cut short: the turn's last block, when that is a tool use. */
function cutOff(turn: AssistantEvent): ToolUseBlock | undefined {
  const last = turn.content.at(-1);
  return turn.stopReason === 'max_tokens' && last?.type === 'tool_use' ? last : undefined;
}

/** Whether the user turned down a call of the newest model turn, which ends the turn there. */
const userRejected = (after: readonly TurnEvent[]): boolean => after.some((e) => e.kind === 'tool-result' && e.status === 'rejected');

/**
 * Pending tool uses that must never run: every one the user stopped, every one after a call the user rejected, or the
 * one the output limit cut short. An abort logged before batches were timed names no started calls, so each counts as
 * started.
 */
function unrunnable(events: readonly TurnEvent[], pending: readonly ToolUseBlock[]): ToolAnswer[] {
  const { turn, after } = newestTurn(events)!;
  if (userRejected(after)) return pending.map((use) => ({ use, text: UNRUN_TEXTS.rejected }));
  const stop = after.find((e): e is EventOf<'error'> => e.kind === 'error' && e.error === 'abort');
  if (stop !== undefined) {
    const started = stop.tools === undefined ? undefined : new Set(stop.tools.map((tool) => tool.toolUseId));
    return stoppedAnswers(pending, (id) => started?.has(id) ?? true);
  }
  const cut = cutOff(turn);
  return cut !== undefined && pending.some((use) => use.id === cut.id) ? [{ use: cut, text: UNRUN_TEXTS['cut-off'] }] : [];
}

// A turn cut off at the output limit goes on once; a second in a row ends the run rather than spend it on more cuts.
function cutTwice(events: readonly TurnEvent[], run: Run): boolean {
  const turns = events.filter((e): e is AssistantEvent => e.kind === 'assistant' && e.seq >= run.firstSeq).slice(-2);
  return turns.length === 2 && turns.every((turn) => cutOff(turn) !== undefined);
}

function limitReached(events: readonly TurnEvent[], run: Run): LoopStep | undefined {
  const ran = events.filter((e) => e.kind !== 'session-start' && e.seq !== undefined && e.seq >= run.firstSeq);
  if (ran.filter((e) => e.kind === 'assistant').length >= run.maxTurns) return done('max-turns');
  // A compaction's summary call counts toward the budget, not the turns. An unpriced call counts as free here; its usage line still prints cost=unknown.
  const cost = ran.reduce((sum, e) => sum + (spendOf(e)?.costUsd ?? 0), 0);
  if (cost > run.maxCostUsd) return done('budget');
  return undefined;
}

export function loopStep(events: readonly TurnEvent[], run: Run): LoopStep {
  const last = lastLiveEvent(events, run);
  if (last.kind === 'error') return after(last);
  const toolUses = pendingToolUses(events);
  if (toolUses.length > 0) {
    const answers = unrunnable(events, toolUses);
    return answers.length > 0 ? { kind: 'answer-tools', answers } : { kind: 'run-tools', toolUses };
  }
  // A no from the user ends the turn; the model next hears from the user, as in Claude Code.
  if (last.kind === 'tool-result' && userRejected(newestTurn(events)!.after)) return done('end_turn');
  const step = after(last);
  if (step.kind !== 'call-model') return step;
  return cutTwice(events, run) ? done('error') : (limitReached(events, run) ?? step);
}
