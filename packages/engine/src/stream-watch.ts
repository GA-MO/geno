import type { MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages/messages';
import { CHARS_PER_TOKEN, type CallProgress, type Writing } from '@g-code/core';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * How long a try may go without a byte of its response before it is given up: until the first byte, then between any
 * two. Bytes count, keepalives included, so a model that thinks for a long time without writing is never cut off.
 */
export type StreamLimits = { readonly firstByteMs: number; readonly idleMs: number };

/**
 * Claude Code's byte watchdog for the first-party API: 180 s for the headers and 180 s between bytes
 * (CLAUDE_STREAM_FIRST_BYTE_TIMEOUT_MS, CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS). The slowest first token in 1,837 logged
 * Model Studio calls took 11 s.
 */
export const STREAM_LIMITS: StreamLimits = { firstByteMs: 180_000, idleMs: 180_000 };

export const STREAM_LIMIT_ENV: { readonly [K in keyof StreamLimits]: string } = {
  firstByteMs: 'GCODE_STREAM_FIRST_BYTE_TIMEOUT_MS',
  idleMs: 'GCODE_STREAM_IDLE_TIMEOUT_MS',
};

/** A whole number of ms from the variable; 0 turns that limit off, and anything else keeps the default. */
function limitOf(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return fallback;
  const ms = Number(raw);
  return ms === 0 ? Infinity : ms;
}

export const streamLimitsOf = (env: Env): StreamLimits => ({
  firstByteMs: limitOf(env[STREAM_LIMIT_ENV.firstByteMs], STREAM_LIMITS.firstByteMs),
  idleMs: limitOf(env[STREAM_LIMIT_ENV.idleMs], STREAM_LIMITS.idleMs),
});

const seconds = (ms: number): string => `${Number((ms / 1000).toFixed(1))}s`;

/** A try given up because its response went silent for `limit`. `giveUp` is how the turn ends when no retry is left. */
export class StreamStalled extends Error {
  readonly giveUp: string;
  constructor(readonly limit: keyof StreamLimits, limitMs: number) {
    super(limit === 'firstByteMs' ? `the model sent no response for ${seconds(limitMs)}` : `the model stopped responding for ${seconds(limitMs)}`);
    this.name = 'StreamStalled';
    const hint = limit === 'firstByteMs' ? '; a proxy or gateway that holds streamed responses until they finish can cause this' : '';
    this.giveUp = `${this.message}${hint}; set ${STREAM_LIMIT_ENV[limit]} to wait longer`;
  }
}

/** The working row needs no more than a few updates a second. */
const PROGRESS_EVERY_MS = 250;

const PATH_FIELD = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/;

const pathIn = (json: string): string | undefined => {
  const quoted = PATH_FIELD.exec(json)?.[1];
  if (quoted === undefined) return undefined;
  try {
    return JSON.parse(`"${quoted}"`) as string;
  } catch {
    return undefined;
  }
};

const BLOCK_WRITING: Readonly<Record<string, Writing>> = { thinking: { kind: 'thinking' }, redacted_thinking: { kind: 'thinking' }, text: { kind: 'text' } };

function deltaChars(event: MessageStreamEvent): number {
  if (event.type !== 'content_block_delta') return 0;
  const { delta } = event;
  if (delta.type === 'text_delta') return delta.text.length;
  if (delta.type === 'thinking_delta') return delta.thinking.length;
  return delta.type === 'input_json_delta' ? delta.partial_json.length : 0;
}

const shownLimit = (ms: number): number | null => (Number.isFinite(ms) ? ms : null);

/**
 * One try's response as it arrives. It aborts `signal` once the response is silent past its limit, and reports the
 * try's progress when it starts and then at most every PROGRESS_EVERY_MS while bytes come in. `stop` ends both.
 */
export function watchStream(limits: StreamLimits, report: (progress: CallProgress) => void) {
  const abort = new AbortController();
  const requestAt = Date.now();
  let progress: CallProgress = { requestAt, lastByteAt: null, limitMs: shownLimit(limits.firstByteMs), writing: null, tokens: 0 };
  let toolJson = '';
  let chars = 0;
  let stalled: StreamStalled | undefined;
  let check: ReturnType<typeof setTimeout> | undefined;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let reportedAt = 0;
  let stopped = false;

  const send = () => {
    pending = undefined;
    reportedAt = Date.now();
    report(progress);
  };
  const changed = () => {
    if (pending !== undefined || stopped) return;
    const wait = reportedAt + PROGRESS_EVERY_MS - Date.now();
    if (wait <= 0) send();
    else pending = setTimeout(send, wait);
  };
  // The timer is set once per limit's span and moved on when it finds bytes came since, not once per byte.
  const arm = (ms: number) => {
    if (Number.isFinite(ms)) check = setTimeout(watch, ms);
  };
  const watch = () => {
    const limit = progress.lastByteAt === null ? 'firstByteMs' : 'idleMs';
    const silentMs = Date.now() - (progress.lastByteAt ?? requestAt);
    if (silentMs < limits[limit]) return arm(limits[limit] - silentMs);
    stalled = new StreamStalled(limit, limits[limit]);
    stop();
    abort.abort(stalled);
  };

  const stop = () => {
    stopped = true;
    clearTimeout(check);
    clearTimeout(pending);
  };
  const bytes = () => {
    if (stopped) return;
    if (progress.lastByteAt === null) {
      clearTimeout(check);
      arm(limits.idleMs);
    }
    progress = { ...progress, lastByteAt: Date.now(), limitMs: shownLimit(limits.idleMs) };
    changed();
  };

  send();
  arm(limits.firstByteMs);
  return {
    signal: abort.signal,
    bytes,
    event(event: MessageStreamEvent) {
      if (event.type === 'content_block_start') {
        const block = event.content_block;
        toolJson = '';
        const writing = block.type === 'tool_use' ? { kind: 'tool' as const, name: block.name } : BLOCK_WRITING[block.type];
        if (writing !== undefined) progress = { ...progress, writing };
      }
      const more = deltaChars(event);
      if (more > 0) {
        chars += more;
        progress = { ...progress, tokens: Math.round(chars / CHARS_PER_TOKEN) };
      }
      const writing = progress.writing;
      if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta' && writing?.kind === 'tool' && writing.target === undefined) {
        toolJson += event.delta.partial_json;
        const target = pathIn(toolJson);
        if (target !== undefined) progress = { ...progress, writing: { ...writing, target } };
      }
      bytes();
    },
    /** Why the try was given up, when silence gave it up. */
    stalled: (): StreamStalled | undefined => stalled,
    stop,
  };
}
