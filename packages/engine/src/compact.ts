import {
  CHARS_PER_TOKEN,
  compactAtTokens,
  compactionEvent,
  contextTokens,
  contextWindowOf,
  keepTailTokens,
  nextSeq,
  planCompaction,
  sessionEffortOf,
  SUMMARY_SYSTEM,
  summaryEvents,
  summaryPrompt,
  type CompactEvent,
  type CompactPlan,
  type CompactTrigger,
  type ModelRetry,
  type Session,
  type StoredAttachments,
  type TurnEvent,
} from '@g-code/core';
import type { Gateway } from './gateway.js';
import { UsageError } from './command.js';

/** Sets the context size, in tokens, at which auto compaction starts, in place of 80% of the model's window. */
export const COMPACT_AT_ENV = 'GCODE_COMPACT_AT';

type Env = Readonly<Record<string, string | undefined>>;

/** Where this session compacts on its own, from the environment and the model's window; undefined when the window is unknown and nothing is set. */
export function compactAtOf(env: Env, { provider, model }: Pick<Session, 'provider' | 'model'>): number | undefined {
  const raw = env[COMPACT_AT_ENV]?.trim();
  const setting = raw === undefined || raw === '' ? undefined : Number(raw);
  if (setting !== undefined && !(Number.isInteger(setting) && setting > 0)) throw new UsageError(`${COMPACT_AT_ENV} must be a positive whole number of tokens`);
  return compactAtTokens(contextWindowOf(provider, model), setting);
}

export type CompactOutcome =
  | { readonly kind: 'compacted'; readonly event: CompactEvent }
  | { readonly kind: 'nothing' }
  | { readonly kind: 'failed'; readonly message: string };

export type CompactRequest = {
  readonly trigger: CompactTrigger;
  /** The cut, when the caller planned it already, as auto compaction does; else the usual one. */
  readonly plan?: CompactPlan | undefined;
  readonly focus?: string | undefined;
  readonly compactAt: number | undefined;
  readonly stored: StoredAttachments;
  readonly signal: AbortSignal;
  readonly onRetry?: (retry: ModelRetry) => void | Promise<void>;
};

/**
 * Summarizes the older part of the session's context with the session's own model and effort, and returns the
 * compaction to log, numbered 0 for the log to number. Nothing is logged here, and a failed call changes nothing.
 */
export async function compactContext(gateway: Gateway, session: Session, events: readonly TurnEvent[], request: CompactRequest): Promise<CompactOutcome> {
  const plan = request.plan ?? planCompaction(events, keepTailTokens(request.compactAt));
  if (plan === undefined) return { kind: 'nothing' };
  const at = new Date().toISOString();
  const maxChars = request.compactAt === undefined ? undefined : Math.floor(request.compactAt * CHARS_PER_TOKEN);
  const result = await gateway.turn({
    session: { ...session, effort: sessionEffortOf(session, events) },
    events: summaryEvents(session, summaryPrompt(plan, request.focus, request.stored, maxChars), at),
    tools: [],
    system: SUMMARY_SYSTEM,
    stored: request.stored,
    signal: request.signal,
    onText: () => {},
    onRetry: request.onRetry ?? (() => {}),
  });
  if (result.kind === 'error') return { kind: 'failed', message: `${result.error}: ${result.message}` };
  const text = result.turn.content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('')
    .trim();
  if (text === '') return { kind: 'failed', message: `the model wrote no summary (stop reason ${result.turn.stopReason ?? 'none'})` };
  const { usage, costUsd, model } = result.turn;
  return {
    kind: 'compacted',
    event: compactionEvent(plan, { trigger: request.trigger, focus: request.focus, summary: { text, spend: { usage, costUsd, model } }, tokensBefore: contextTokens(events), at }),
  };
}

/** The compaction numbered as the next event of `events`. */
export const numbered = (event: CompactEvent, events: readonly TurnEvent[]): CompactEvent => ({ ...event, seq: nextSeq(events) });
