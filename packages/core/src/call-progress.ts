/** What the model is writing: its thinking, its answer, or the input of a tool call, with the path it names once one streamed. */
export type Writing =
  | { readonly kind: 'thinking' }
  | { readonly kind: 'text' }
  | { readonly kind: 'tool'; readonly name: string; readonly target?: string | undefined };

/** One try of a model call as it streams, for the working row. Times are ms since the epoch. */
export type CallProgress = {
  /** The try went out. */
  readonly requestAt: number;
  /** The last bytes of the response arrived: its headers, its content or a keepalive. Null before any. */
  readonly lastByteAt: number | null;
  /** How long this try may stay silent before it is given up; null when nothing watches it. */
  readonly limitMs: number | null;
  /** Null until the first block of the answer starts. */
  readonly writing: Writing | null;
  /** About how many tokens of thinking, text and tool input this try streamed, from their characters; usage comes only at the end. */
  readonly tokens: number;
};

/** In a `notice` session update's `_meta`: the model call's progress. */
export const PROGRESS_META = 'gcode/progress';

/** How long a call is silent before the working row says so: Claude Code's slow-first-byte mark (CLAUDE_SLOW_FIRST_BYTE_MS). */
export const QUIET_SHOWN_MS = 30_000;

/** 42s, 3m, 3m 20s. */
export function durationText(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

/** 640 tokens, 3.2k tokens, 61k tokens. */
export function tokensText(tokens: number): string {
  if (tokens < 1000) return `${tokens} tokens`;
  return tokens < 100_000 ? `${(tokens / 1000).toFixed(1)}k tokens` : `${Math.round(tokens / 1000)}k tokens`;
}

function writingLabel(writing: Writing): string {
  switch (writing.kind) {
    case 'thinking':
      return 'Thinking';
    case 'text':
      return 'Writing the answer';
    case 'tool':
      return `Writing ${writing.name}${writing.target === undefined ? '' : ` ${writing.target}`}`;
  }
}

/**
 * The working row's words for a call at `now`: what it writes and how much so far, or how long it has been silent once
 * that passes QUIET_SHOWN_MS, so a long answer reads apart from a call that hangs.
 */
export function progressLabel(progress: CallProgress, now: number): string {
  const silentMs = now - (progress.lastByteAt ?? progress.requestAt);
  if (silentMs >= QUIET_SHOWN_MS) {
    const head = progress.lastByteAt === null ? `No response from the model after ${durationText(silentMs)}` : `The model went quiet ${durationText(silentMs)} ago`;
    return progress.limitMs === null ? head : `${head} · waiting up to ${durationText(progress.limitMs)}`;
  }
  if (progress.writing === null || progress.tokens === 0) return 'Thinking';
  return `${writingLabel(progress.writing)} · ↓ ${tokensText(progress.tokens)}`;
}
