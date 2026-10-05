import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import type { TurnEvent } from './session.js';

/**
 * When one model call's stream reached each point, in ms since the Unix epoch. Bookkeeping only: the request is
 * built from the events' content, never from these, so the bytes the model sees and the cached prefix stay the same.
 */
export type StreamMarks = {
  /** The request of the attempt that produced the result went out. Earlier attempts and their waits are overhead. */
  readonly requestAt: number;
  /** The first streamed content of any kind: thinking, text or a tool call. Null when none arrived. */
  readonly firstTokenAt: number | null;
  /** The first text or tool-call content, after any thinking. Null when none arrived. */
  readonly firstAnswerAt: number | null;
  /** The last streamed content. Null when none arrived. */
  readonly lastTokenAt: number | null;
  /** The call returned: the message completed, failed or was aborted. */
  readonly endAt: number;
};

/** A model call's marks, from the moment the loop began it: before its checkpoint, attachment load and retries. */
export type ModelMarks = { readonly startAt: number } & StreamMarks;

export type ToolMarks = { readonly startAt: number; readonly endAt: number };

/** A tool of a batch the user interrupted; its result is never logged, so its marks ride on the abort error. */
export type InterruptedTool = { readonly toolUseId: string; readonly name: string } & ToolMarks;

export const TURN_OUTCOMES = ['answer', 'error', 'aborted'] as const;
export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

export type ToolTime = { readonly toolUseId: string; readonly name: string; readonly ms: number };

export type TurnTokens = {
  readonly input: number;
  readonly output: number;
  /**
   * Output tokens spent thinking, estimated as the output's share of thinking characters, because the
   * Anthropic usage block reports thinking and answer tokens as one number.
   */
  readonly thinking: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
};

/**
 * One model call and the tools it asked for. `wallMs` = `modelMs` + `toolMs` + `overheadMs`, and
 * `modelMs` = `ttftMs` + `thinkingMs` + `decodeMs` + the stream's tail after its last token.
 */
export type TurnTiming = {
  /** The seq of the call's assistant or error event. */
  readonly seq: number;
  readonly outcome: TurnOutcome;
  /** From the call's start to the next call's start, or to the last moment the turn logged. */
  readonly wallMs: number;
  /** Request sent to first token: network, queueing and prefill. Null when no token arrived. */
  readonly ttftMs: number | null;
  /** First token to first answer token; 0 for a call that did not think. */
  readonly thinkingMs: number;
  /** First answer token to last token. */
  readonly decodeMs: number;
  /** Request sent to the call's end. */
  readonly modelMs: number;
  readonly toolMs: number;
  /** The rest of the wall: checkpoints, retries and their waits, spilling and logging. */
  readonly overheadMs: number;
  readonly tools: readonly ToolTime[];
  /** Null for a call that ended in an error, which reports no usage. */
  readonly tokens: TurnTokens | null;
};

type AnswerEvent = Extract<TurnEvent, { kind: 'assistant' }>;
type ErrorEvent = Extract<TurnEvent, { kind: 'error' }>;

function charsOf(content: readonly ContentBlock[]): { thought: number; answered: number } {
  let thought = 0;
  let answered = 0;
  for (const block of content) {
    if (block.type === 'thinking') thought += block.thinking.length;
    else if (block.type === 'text') answered += block.text.length;
    else if (block.type === 'tool_use') answered += JSON.stringify(block.input).length;
  }
  return { thought, answered };
}

function tokensOf({ content, usage }: AnswerEvent): TurnTokens {
  const { thought, answered } = charsOf(content);
  const all = thought + answered;
  return {
    input: usage.input,
    output: usage.output,
    thinking: all === 0 ? 0 : Math.round((usage.output * thought) / all),
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
  };
}

const outcomeOf = (error: ErrorEvent['error']): TurnOutcome => (error === 'abort' ? 'aborted' : 'error');

/** A turn as the log builds it up: the call that opened it, then its tools, until the next call or prompt closes it. */
type OpenTurn = {
  readonly seq: number;
  readonly marks: ModelMarks;
  outcome: TurnOutcome;
  readonly tokens: TurnTokens | null;
  readonly tools: ToolTime[];
  /** The latest moment the turn's own events were logged, in ms since the epoch. */
  lastAt: number;
};

function opened(event: AnswerEvent | ErrorEvent, marks: ModelMarks): OpenTurn {
  return {
    seq: event.seq,
    marks,
    outcome: event.kind === 'assistant' ? 'answer' : outcomeOf(event.error),
    tokens: event.kind === 'assistant' ? tokensOf(event) : null,
    tools: [],
    lastAt: Math.max(Date.parse(event.at), marks.endAt),
  };
}

function closed(turn: OpenTurn, endAt: number): TurnTiming {
  const { startAt, requestAt, firstTokenAt, firstAnswerAt, lastTokenAt } = turn.marks;
  const wallMs = endAt - startAt;
  const modelMs = turn.marks.endAt - requestAt;
  const toolMs = turn.tools.reduce((sum, tool) => sum + tool.ms, 0);
  // A call cut off before it answered spent all its streamed time thinking.
  const thoughtUntil = firstAnswerAt ?? lastTokenAt;
  return {
    seq: turn.seq,
    outcome: turn.outcome,
    wallMs,
    ttftMs: firstTokenAt === null ? null : firstTokenAt - requestAt,
    thinkingMs: firstTokenAt === null || thoughtUntil === null ? 0 : thoughtUntil - firstTokenAt,
    decodeMs: firstAnswerAt === null || lastTokenAt === null ? 0 : lastTokenAt - firstAnswerAt,
    modelMs,
    toolMs,
    overheadMs: wallMs - modelMs - toolMs,
    tools: turn.tools,
    tokens: turn.tokens,
  };
}

const toolTime = (toolUseId: string, name: string, marks: ToolMarks): ToolTime => ({ toolUseId, name, ms: marks.endAt - marks.startAt });

/**
 * The timing of each timed model call in the log and the tools it asked for, in log order. A turn runs from its
 * call's start to the next call's start. A prompt in between ends it at its own last logged moment instead, so the
 * time the user spent typing belongs to no turn. Calls logged before turns were timed are skipped.
 */
export function turnTimings(events: readonly TurnEvent[]): TurnTiming[] {
  const timings: TurnTiming[] = [];
  let open: OpenTurn | undefined;
  const close = (endAt: number) => {
    if (open !== undefined) timings.push(closed(open, endAt));
    open = undefined;
  };
  for (const event of events) {
    if (event.kind === 'user') close(open?.lastAt ?? 0);
    if ((event.kind === 'assistant' || event.kind === 'error') && event.timing !== undefined) {
      close(event.timing.startAt);
      open = opened(event, event.timing);
      continue;
    }
    if (open === undefined) continue;
    if (event.kind === 'tool-result' && event.timing !== undefined) {
      open.tools.push(toolTime(event.toolUseId, event.name, event.timing));
      open.lastAt = Math.max(open.lastAt, Date.parse(event.at));
    }
    if (event.kind === 'error') {
      if (event.tools !== undefined) open.outcome = outcomeOf(event.error);
      for (const tool of event.tools ?? []) open.tools.push(toolTime(tool.toolUseId, tool.name, tool));
      open.lastAt = Math.max(open.lastAt, Date.parse(event.at));
    }
  }
  close(open?.lastAt ?? 0);
  return timings;
}
