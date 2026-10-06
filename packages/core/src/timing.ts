import type { ContentBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import type { TurnEvent } from './session.js';
import { percentile, type Spread } from './tab/report.js';

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
  /** Time the call spent waiting offline or for a rate limit, before the attempt that produced the result. Absent when it never waited. */
  readonly waitMs?: number | undefined;
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
 * One model call and the tools it asked for. `wallMs` = `modelMs` + `toolMs` + `waitMs` + `overheadMs`, and
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
  /** Waiting offline or for a rate limit to reset. */
  readonly waitMs: number;
  /** The rest of the wall: checkpoints, retries and their backoff, spilling and logging. */
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
  readonly spans: ToolMarks[];
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
    spans: [],
    lastAt: Math.max(Date.parse(event.at), marks.endAt),
  };
}

function closed(turn: OpenTurn, endAt: number): TurnTiming {
  const { startAt, requestAt, firstTokenAt, firstAnswerAt, lastTokenAt } = turn.marks;
  const wallMs = endAt - startAt;
  const modelMs = turn.marks.endAt - requestAt;
  const toolMs = coveredMs(turn.spans);
  const waitMs = turn.marks.waitMs ?? 0;
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
    waitMs,
    overheadMs: wallMs - modelMs - toolMs - waitMs,
    tools: turn.tools,
    tokens: turn.tokens,
  };
}

/** The wall time some span covers, so tools that ran at the same time count once. */
function coveredMs(spans: readonly ToolMarks[]): number {
  let total = 0;
  let reached = -Infinity;
  for (const { startAt, endAt } of spans.toSorted((a, b) => a.startAt - b.startAt)) {
    total += Math.max(0, endAt - Math.max(startAt, reached));
    reached = Math.max(reached, endAt);
  }
  return total;
}

function addTool(turn: OpenTurn, toolUseId: string, name: string, marks: ToolMarks): void {
  turn.tools.push({ toolUseId, name, ms: marks.endAt - marks.startAt });
  turn.spans.push(marks);
}

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
    if (event.kind === 'user' && event.steer !== true) close(open?.lastAt ?? 0);
    if ((event.kind === 'assistant' || event.kind === 'error') && event.timing !== undefined) {
      close(event.timing.startAt);
      open = opened(event, event.timing);
      continue;
    }
    if (open === undefined) continue;
    if (event.kind === 'tool-result' && event.timing !== undefined) {
      addTool(open, event.toolUseId, event.name, event.timing);
      open.lastAt = Math.max(open.lastAt, Date.parse(event.at));
    }
    if (event.kind === 'error') {
      if (event.tools !== undefined) open.outcome = outcomeOf(event.error);
      for (const tool of event.tools ?? []) addTool(open, tool.toolUseId, tool.name, tool);
      open.lastAt = Math.max(open.lastAt, Date.parse(event.at));
    }
  }
  close(open?.lastAt ?? 0);
  return timings;
}

/** The parts of a turn a speed report spreads, keyed by how each reads off a turn. Null leaves the turn out of that part. */
export const SPEED_PARTS = {
  'first token': (t: TurnTiming) => t.ttftMs,
  thinking: (t: TurnTiming) => t.thinkingMs,
  decode: (t: TurnTiming) => t.decodeMs,
  model: (t: TurnTiming) => t.modelMs,
  tools: (t: TurnTiming) => t.toolMs,
  overhead: (t: TurnTiming) => t.overheadMs,
} as const satisfies Record<string, (t: TurnTiming) => number | null>;
export type SpeedPart = keyof typeof SPEED_PARTS;

export type TaskTiming = { readonly taskId: string; readonly pass: boolean; readonly agentMs: number; readonly turns: readonly TurnTiming[] };

/** Per turn, over every turn of every task, and the sum over all of them. */
export type PartSpread = Spread & { readonly totalMs: number };

export type SpeedReport = {
  readonly tasks: number;
  readonly passed: number;
  readonly turns: number;
  /** The agent's wall time, summed over tasks: what the parts have to explain. */
  readonly agentMs: number;
  readonly parts: Readonly<Record<SpeedPart, PartSpread>>;
  /** Agent time no turn covers: the sandbox, loading context, and the gap after the last turn. */
  readonly outsideTurnsMs: number;
  /** Model plus tool time as a share of agent time; null with no agent time. */
  readonly explained: number | null;
  readonly outputTokens: Spread;
  readonly thinkingTokens: Spread;
  /** Output tokens per second of streamed output (thinking plus decode), over turns that streamed any. */
  readonly outputTokensPerSecond: Spread;
};

const spreadOf = (values: readonly number[]): Spread => ({ p50: percentile(values, 50), p90: percentile(values, 90) });

export function speedReport(tasks: readonly TaskTiming[]): SpeedReport {
  const turns = tasks.flatMap((task) => task.turns);
  const partOf = (read: (t: TurnTiming) => number | null): PartSpread => {
    const values = turns.flatMap((t) => read(t) ?? []);
    return { ...spreadOf(values), totalMs: values.reduce((sum, v) => sum + v, 0) };
  };
  const parts = Object.fromEntries(Object.entries(SPEED_PARTS).map(([part, read]) => [part, partOf(read)])) as Record<SpeedPart, PartSpread>;
  const agentMs = tasks.reduce((sum, task) => sum + task.agentMs, 0);
  const wallMs = turns.reduce((sum, t) => sum + t.wallMs, 0);
  const answered = turns.flatMap((t) => (t.tokens === null ? [] : [{ t, tokens: t.tokens }]));
  const streamed = answered.filter(({ t }) => t.thinkingMs + t.decodeMs > 0);
  return {
    tasks: tasks.length,
    passed: tasks.filter((task) => task.pass).length,
    turns: turns.length,
    agentMs,
    parts,
    outsideTurnsMs: agentMs - wallMs,
    explained: agentMs === 0 ? null : (parts.model.totalMs + parts.tools.totalMs) / agentMs,
    outputTokens: spreadOf(answered.map(({ tokens }) => tokens.output)),
    thinkingTokens: spreadOf(answered.map(({ tokens }) => tokens.thinking)),
    outputTokensPerSecond: spreadOf(streamed.map(({ t, tokens }) => (tokens.output * 1000) / (t.thinkingMs + t.decodeMs))),
  };
}
