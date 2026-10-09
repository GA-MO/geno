import type { StopReason, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { REPORT_TOOL, reportMessageOf, STRUCTURED_OUTPUT_TOOL } from './handback.js';
import { BUDGET_REMINDER_SHARE, type BudgetLeft } from './notice.js';
import { IN_CONVERSATION, KEEPS_PENDING_PROMPT, spendOf, toolUsesOf, type ToolResultEvent, type TurnErrorKind, type TurnEvent } from './session.js';

export const DONE_REASONS = ['end_turn', 'max-turns', 'budget', 'refusal', 'error'] as const;
export type DoneReason = (typeof DONE_REASONS)[number];

/** A tool use the loop answers with an error instead of running it. */
export type ToolAnswer = { readonly use: ToolUseBlock; readonly text: string };

export type LoopStep =
  | { readonly kind: 'call-model' }
  | { readonly kind: 'run-tools'; readonly toolUses: readonly ToolUseBlock[] }
  | { readonly kind: 'answer-tools'; readonly answers: readonly ToolAnswer[] }
  /** A child ended its turn without calling report, or a model ended one with nothing to show: log the nudge, then call the model again. */
  | { readonly kind: 'nudge'; readonly empty?: true | undefined }
  | { readonly kind: 'done'; readonly reason: DoneReason };

/** What a call the user turned down tells the model, as Claude Code's rejection does. */
export const STOP_AND_WAIT = 'STOP what you are doing and wait for the user to tell you how to proceed.';

/** Claude Code's don't-ask denial, for a call refused because nobody can answer its question. */
export const DONT_ASK =
  "IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, e.g. using head instead of cat. But you *should not* attempt to work around this denial in malicious ways, e.g. do not use your ability to run tests to execute non-test actions. You should only try to work around this restriction in reasonable ways that do not attempt to bypass the intent behind this denial. If you believe this capability is essential to complete the user's request, STOP and explain to the user what you were trying to do and why you need this permission. Let the user decide how to proceed.";

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
  /** A subagent's run: a report call that went through ends it, and an end without one is nudged once. */
  readonly handback?: true | undefined;
};

const CALL: LoopStep = { kind: 'call-model' };
const done = (reason: DoneReason): LoopStep => ({ kind: 'done', reason });

const ERROR_REASON: Record<TurnErrorKind, DoneReason> = {
  refusal: 'refusal',
  blocked: 'error',
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

/** A Stop or SubagentStop hook's block: the one hook output that keeps the conversation going, after the model ended its turn. */
type StopFeedback = Extract<TurnEvent, { kind: 'hook-context'; event: 'Stop' | 'SubagentStop' }>;

const isStopFeedback = (event: TurnEvent): event is StopFeedback => event.kind === 'hook-context' && (event.event === 'Stop' || event.event === 'SubagentStop');

type ConversationEvent =
  | Exclude<TurnEvent, { kind: 'checkpoint' | 'restored' | 'review' | 'retry' | 'mode' | 'notice' | 'effort' | 'title' | 'child-start' | 'child-end' | 'lane-apply' | 'background-end' | 'wait' | 'wake' | 'backend-start' | 'backend-model' | 'spinoff' | 'chapter' | 'cut' | 'compact' | 'file-changed' | 'hook-context' }>
  | StopFeedback;
type EventOf<K extends ConversationEvent['kind']> = Extract<ConversationEvent, { kind: K }>;

const isConversation = (event: TurnEvent): event is ConversationEvent => IN_CONVERSATION[event.kind] || isStopFeedback(event);

const AFTER_EVENT: { [K in ConversationEvent['kind']]: (event: EventOf<K>) => LoopStep } = {
  'session-start': () => done('end_turn'),
  user: () => CALL,
  'tool-result': () => CALL,
  'report-nudge': () => CALL,
  'hook-context': () => CALL,
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

const thisRun = (events: readonly TurnEvent[], run: Run): readonly TurnEvent[] => events.filter((e) => e.kind !== 'session-start' && e.seq !== undefined && e.seq >= run.firstSeq);

// A compaction's summary call counts toward the budget, not the turns. An unpriced call counts as free here; its usage line still prints cost=unknown.
function spent(events: readonly TurnEvent[], run: Run): { readonly calls: number; readonly costUsd: number } {
  const ran = thisRun(events, run);
  return { calls: ran.filter((e) => e.kind === 'assistant').length, costUsd: ran.reduce((sum, e) => sum + (spendOf(e)?.costUsd ?? 0), 0) };
}

function limitReached(events: readonly TurnEvent[], run: Run): LoopStep | undefined {
  const { calls, costUsd } = spent(events, run);
  if (calls >= run.maxTurns) return done('max-turns');
  if (costUsd > run.maxCostUsd) return done('budget');
  return undefined;
}

/**
 * What the run has left, once, before the model call that starts with 20% or less of its calls or its cost left, so
 * the model can end with a report rather than be stopped mid-task. Undefined before that, after it was told, and at a
 * limit.
 */
export function budgetReminder(events: readonly TurnEvent[], run: Run): BudgetLeft | undefined {
  if (limitReached(events, run) !== undefined || thisRun(events, run).some((e) => e.kind === 'notice' && e.budget !== undefined)) return undefined;
  const { calls, costUsd } = spent(events, run);
  const left: BudgetLeft = {
    calls: run.maxTurns - calls,
    maxCalls: run.maxTurns,
    costUsd: run.maxCostUsd - costUsd,
    maxCostUsd: run.maxCostUsd,
    ...(calls > 0 && costUsd > 0 ? { perCallUsd: costUsd / calls } : {}),
  };
  const low = left.calls <= run.maxTurns * BUDGET_REMINDER_SHARE || left.costUsd <= run.maxCostUsd * BUDGET_REMINDER_SHARE;
  return low ? left : undefined;
}

const reported = (after: readonly TurnEvent[]): boolean => after.some((e) => e.kind === 'tool-result' && e.name === REPORT_TOOL && e.status === 'ok');

/** A turn with no text and no tool call, such as thinking alone: the user would see nothing. */
const answerless = (turn: AssistantEvent): boolean => !turn.content.some((block) => block.type === 'tool_use' || (block.type === 'text' && block.text.trim() !== ''));

/** The conversation event before the newest one, which tells a second empty turn from a first. */
const beforeLast = (events: readonly TurnEvent[]): TurnEvent | undefined => events.filter(isConversation).at(-2);

/** A handback run's model ended its turn without a report: nudged once while a call is left, then the run ends. */
const nudgeDue = (events: readonly TurnEvent[], run: Run): boolean =>
  !thisRun(events, run).some((e) => e.kind === 'report-nudge') && limitReached(events, run) === undefined;

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
  // The report call ends the run, even at a limit: the child said what it had.
  if (run.handback === true && last.kind === 'tool-result' && reported(newestTurn(events)!.after)) return done('end_turn');
  // So does a schema step's forced call after it, valid or not: one that fails leaves the report's JSON block to stand.
  if (last.kind === 'tool-result' && last.name === STRUCTURED_OUTPUT_TOOL) return done('end_turn');
  const step = after(last);
  if (run.handback === true && last.kind === 'assistant' && step.kind === 'done' && step.reason === 'end_turn' && nudgeDue(events, run)) return { kind: 'nudge' };
  // An empty end is not an answer, so the run goes on once; a second in a row ends it as an error, never as done.
  if (last.kind === 'assistant' && step.kind === 'done' && step.reason === 'end_turn' && answerless(last)) {
    const prior = beforeLast(events);
    if (prior?.kind === 'report-nudge' && prior.empty === true) return done('error');
    return limitReached(events, run) ?? { kind: 'nudge', empty: true };
  }
  if (step.kind !== 'call-model') return step;
  return cutTwice(events, run) ? done('error') : (limitReached(events, run) ?? step);
}

/** Claude Code's `stop_hook_active`: a Stop hook already kept this run going. */
export const stopHookActive = (events: readonly TurnEvent[], run: Run): boolean => thisRun(events, run).some(isStopFeedback);

/**
 * Whether a Stop hook's block may keep the turn going: once in a row. After a block, the model must call a tool before
 * another block counts, so a hook that always blocks cannot loop the model; the run's limits bound the rest. A
 * subagent's report call does not count, or a SubagentStop hook that always blocks would loop the subagent.
 */
export function stopMayContinue(events: readonly TurnEvent[], run: Run): boolean {
  const ran = thisRun(events, run);
  const last = ran.findLastIndex(isStopFeedback);
  return last === -1 || ran.slice(last + 1).some((e) => e.kind === 'tool-result' && e.name !== REPORT_TOOL);
}

/** Whether the model ended the turn itself, which fires Stop, rather than the user's no or a subagent's report. */
export const modelEndedTurn = (events: readonly TurnEvent[], run: Run): boolean => lastLiveEvent(events, run).kind === 'assistant';

/** Whether a subagent finished responding, which fires SubagentStop: its model ended the turn, or its report went through. */
export function finishedResponding(events: readonly TurnEvent[], run: Run): boolean {
  if (modelEndedTurn(events, run)) return true;
  const newest = newestTurn(events);
  return run.handback === true && lastLiveEvent(events, run).kind === 'tool-result' && newest !== undefined && reported(newest.after);
}

/** Claude Code's `last_assistant_message`: the text of the newest model turn. */
export const lastAssistantText = (events: readonly TurnEvent[]): string =>
  newestTurn(events)?.turn.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n') ?? '';

/** A subagent's `last_assistant_message`: its newest turn's report, when that turn reported, else the turn's text. */
export function lastResponseText(events: readonly TurnEvent[]): string {
  const report = newestTurn(events)?.turn.content.flatMap((block) => (block.type === 'tool_use' ? (reportMessageOf(block) ?? []) : [])).at(-1);
  return report ?? lastAssistantText(events);
}
