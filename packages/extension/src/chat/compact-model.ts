import type { CompactMark, CompactTrigger } from '@g-code/core/compact';
import type { CompactBlock, Turn } from './messages.js';

/**
 * Context compaction in the panel (U47): the divider where the engine compacted, and how it reads. Pure and bundled
 * into the webview, so it imports only types from core.
 */

/** A compaction as its block, once per seq: the live chunk and a replay of the same compaction stay one divider. */
export function withCompact(turn: Turn, mark: CompactMark): Turn {
  const id = `compact:${mark.seq}`;
  if (turn.blocks.some((block) => block.id === id)) return turn;
  const block: CompactBlock = { kind: 'compact', id, mark };
  return { ...turn, blocks: [...turn.blocks, block] };
}

export type CompactLook = {
  readonly title: string;
  /** "84,213 → about 12,400 tokens": the context after is the engine's estimate until the next call measures it. */
  readonly numbers: string;
  /** Why it happened, when the turn does not already say: the /compact chip says it for a manual one. */
  readonly reason: string | undefined;
  readonly focus: string | undefined;
};

const count = (n: number): string => n.toLocaleString('en-US');

const REASONS: Readonly<Record<CompactTrigger, string | undefined>> = {
  auto: 'Geno compacted on its own before the context filled.',
  overflow: 'The model refused the request as too long, so Geno compacted and sent it again.',
  manual: undefined,
};

export const compactLook = ({ trigger, tokensBefore, tokensAfter, focus }: CompactMark): CompactLook => ({
  title: 'Context compacted',
  numbers: `${count(tokensBefore)} → about ${count(tokensAfter)} tokens`,
  reason: REASONS[trigger],
  focus: focus === undefined || focus === '' ? undefined : focus,
});

export const compactFoldId = (block: CompactBlock): string => `compact:${block.mark.seq}`;
