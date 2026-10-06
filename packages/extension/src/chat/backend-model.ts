import type { BackendShown } from '@g-code/core';
import { formatCost } from './format.js';
import type { Block, Transcript, Usage } from './messages.js';

/**
 * How a session on an external agent reads in the transcript: the agent's name beside Geno's, the plan that pays
 * for a turn the agent reports no price for, and the lane whose changes wait to be applied. The webview bundles this
 * file, so it imports only types and other pure webview modules.
 */

export type CostSlot = { readonly text: string; readonly title: string };

/** What pays for the turn when the agent sends no price: the user's own plan with it. */
export const planCost = (backend: BackendShown): CostSlot => ({ text: backend.plan, title: `${backend.label} reports no price for this turn; your ${backend.plan} pays for it` });

/** A finished turn's cost: its price, the plan for an external turn without one, or nothing for Geno's own unpriced model. */
export function turnCost(costUsd: number | null, backend: BackendShown | undefined): CostSlot | undefined {
  if (costUsd !== null) return { text: formatCost(costUsd), title: `$${costUsd} estimated` };
  return backend === undefined ? undefined : planCost(backend);
}

/** An external agent counts no tokens through Geno, so a turn of one that reports none shows no token counts. */
export const showsTokens = (usage: Usage, backend: BackendShown | undefined): boolean => backend === undefined || usage.inputTokens + usage.outputTokens > 0;

/** An edit the agent made in its lane: it reached no editor, so it carries no diff until an Apply brings it back. */
const laneEdit = (block: Block): boolean => block.kind === 'tool' && block.toolKind === 'edit' && block.status === 'completed' && block.diff === undefined;
/** An edit that came back to the main checkout under review, as an Apply's do. */
const reviewedEdit = (block: Block): boolean => block.kind === 'tool' && block.diff !== undefined;

/**
 * The lane to offer Apply for under the last turn: the agent edited in it after the latest apply, and nothing runs.
 * Undefined for Geno's own sessions and before the agent's first turn names its lane.
 */
export function laneOffer(transcript: Transcript): string | undefined {
  const lane = transcript.backend?.lane;
  const last = transcript.turns.at(-1);
  if (lane == null || last === undefined || last.status === 'streaming') return undefined;
  const edited = transcript.turns.findLastIndex((turn) => turn.blocks.some(laneEdit));
  const applied = transcript.turns.findLastIndex((turn) => turn.blocks.some(reviewedEdit));
  return edited > applied ? lane : undefined;
}
