import type { TokenUsage } from './session.js';

/**
 * Where a model request's tokens went. A request's input parts are listed in the order the request sends them,
 * then the answer. `unsplit` is a request logged before Geno split requests, which has only its total.
 */
export const PARTS = ['tools', 'system', 'context', 'user', 'assistant', 'toolResults', 'files', 'attachments', 'prompt', 'output', 'unsplit'] as const;
export type Part = (typeof PARTS)[number];
export type InputPart = Exclude<Part, 'output' | 'unsplit'>;
export const INPUT_PARTS = PARTS.filter((p): p is InputPart => p !== 'output' && p !== 'unsplit');

/** How each part reads: as a row's label, and as the subject of the sentence that names the biggest driver. */
export const PART_NAMES: Readonly<Record<Part, { readonly label: string; readonly subject: string }>> = {
  tools: { label: 'Tool definitions', subject: 'tool definitions are' },
  system: { label: 'System prompt', subject: 'the system prompt is' },
  context: { label: 'Rules, memory, skills', subject: 'rules, memory and skills are' },
  user: { label: 'Earlier messages', subject: 'your earlier messages are' },
  assistant: { label: 'Earlier replies', subject: 'earlier replies are' },
  toolResults: { label: 'Tool results', subject: 'tool results are' },
  files: { label: 'Files read this turn', subject: 'files read this turn are' },
  attachments: { label: 'Attachments', subject: 'attachments are' },
  prompt: { label: 'New prompt', subject: 'the new prompt is' },
  output: { label: 'Output', subject: 'output is' },
  unsplit: { label: 'Not split (older log)', subject: 'requests logged before the split are' },
};

/** One stretch of a request that one part fills, with its estimated tokens. A model call logs its request as these. */
export type PartRun = readonly [part: InputPart, tokens: number];

/**
 * `provider`: the request's total is what the provider counted, and the parts share it in proportion to the estimate.
 * `estimated`: the provider reported no input count, so the total is the estimate too.
 */
export type TokenBasis = 'provider' | 'estimated';

/** A part's tokens by how they billed, and their cost, null when the model has no price. */
export type PartUsage = { readonly usage: TokenUsage; readonly costUsd: number | null };

export type Breakdown = {
  readonly basis: TokenBasis;
  /** Model calls summed into this breakdown. */
  readonly requests: number;
  readonly parts: Readonly<Record<Part, PartUsage>>;
  readonly total: PartUsage;
};

export const inputOf = (usage: TokenUsage): number => usage.input + usage.cacheRead + usage.cacheWrite;

export const tokensOf = (usage: TokenUsage): number => inputOf(usage) + usage.output;
