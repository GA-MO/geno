import type { ContentBlockParam, MessageStreamParams } from '@anthropic-ai/sdk/resources/messages/messages';
import { renderContextItems, renderLoadedContext, type ContextItem } from './context.js';
import { costAt, type Rates } from './cost.js';
import { MEMORY_PREAMBLE } from './memory.js';
import type { Adapter } from './providers.js';
import { ZERO_USAGE, addUsage, type TokenUsage, type TurnEvent } from './session.js';
import { startsTurn } from './steer.js';
import { inputOf, PARTS, type Breakdown, type InputPart, type Part, type PartRun, type PartUsage, type TokenBasis } from './parts.js';

/**
 * The tokenizer approximation, used wherever the provider gives no count. Text splits into pieces the way BPE
 * pre-tokenizers split it: runs of letters, single digits (Qwen and Llama tokenize digits one by one), runs of other
 * symbols, and whitespace. A run of Latin letters costs one token per wordChars letters, rounded up; a letter
 * outside Latin costs one token; a symbol run one per symbolChars; any other whitespace run one; and a lone space
 * nothing, since BPE merges it into the next word. Messages, tool calls and tool definitions add fixed framing. Calibrated against qwen3.8-flash's counts (docs/u61.md).
 */
export const TOKENIZER = {
  wordChars: 8,
  symbolChars: 3,
  messageOverhead: 4,
  /** A tool call or a tool result: its id and framing. */
  toolCallOverhead: 8,
  /** A tool definition's framing, and the tool-calling instructions the chat template adds once when any tool is offered. */
  toolDefinitionOverhead: 15,
  toolsPreamble: 190,
  imageTokens: 1600,
} as const;

const PIECES = /[A-Za-zÀ-ɏ]+|\p{L}|\p{N}|[^\p{L}\p{N}\s]+|\s+/gu;

export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const [piece] of text.matchAll(PIECES)) {
    const c = piece.charCodeAt(0);
    if (c === 32 && piece.length === 1) continue;
    if (/\s/.test(piece[0]!)) tokens += 1;
    else if (/[A-Za-zÀ-ɏ]/.test(piece[0]!)) tokens += Math.ceil(piece.length / TOKENIZER.wordChars);
    else if (/[\p{L}\p{N}]/u.test(piece)) tokens += 1;
    else tokens += Math.ceil(piece.length / TOKENIZER.symbolChars);
  }
  return tokens;
}

/** What a request's user blocks are, read from the log it was built from. */
type Labels = {
  readonly texts: ReadonlyMap<string, InputPart>;
  /** Context items rendered together into one block, split by what each item is. */
  readonly itemBlocks: ReadonlyMap<string, readonly ContextItem[]>;
  readonly results: ReadonlyMap<string, InputPart>;
  /** Whether the wire sends thinking back; Chat Completions drops it. */
  readonly thinking: boolean;
};

const READ_TOOL = 'read';

function labelsOf(events: readonly TurnEvent[], adapter: Adapter): Labels {
  const texts = new Map<string, InputPart>();
  const itemBlocks = new Map<string, readonly ContextItem[]>();
  const results = new Map<string, InputPart>();
  const turnStart = events.findLast(startsTurn)?.seq ?? Infinity;
  for (const event of events) {
    if (event.kind === 'session-start' && event.context !== undefined) {
      const loaded = renderLoadedContext(event.context);
      if (loaded !== undefined) texts.set(loaded, 'context');
    }
    if (event.kind === 'user') {
      if (event.content !== '') texts.set(event.content, event.seq >= turnStart ? 'prompt' : 'user');
      const files = (event.attachments ?? []).filter((a) => a.kind === 'file');
      const items = event.context ?? [];
      if (items.length > 0 || files.length > 0) itemBlocks.set(renderContextItems(items), items);
    }
    if (event.kind === 'tool-result') results.set(event.toolUseId, event.name === READ_TOOL && event.seq > turnStart ? 'files' : 'toolResults');
  }
  return { texts, itemBlocks, results, thinking: adapter === 'anthropic' };
}

const ITEM_PART: Readonly<Record<ContextItem['kind'], InputPart>> = { file: 'attachments', selection: 'attachments', rule: 'context', skill: 'context' };

function blockRuns(block: ContentBlockParam, role: 'user' | 'assistant', labels: Labels): PartRun[] {
  if (role === 'assistant') {
    if (block.type === 'text') return [['assistant', estimateTokens(block.text)]];
    if (block.type === 'thinking') return labels.thinking ? [['assistant', estimateTokens(block.thinking)]] : [];
    if (block.type === 'tool_use') return [['assistant', TOKENIZER.toolCallOverhead + estimateTokens(`${block.name}${JSON.stringify(block.input)}`)]];
    return [['assistant', estimateTokens(JSON.stringify(block))]];
  }
  if (block.type === 'image') return [['attachments', TOKENIZER.imageTokens]];
  if (block.type === 'tool_result') {
    const part = labels.results.get(block.tool_use_id) ?? 'toolResults';
    const content = typeof block.content === 'string' || block.content === undefined ? [{ type: 'text' as const, text: block.content ?? '' }] : block.content;
    return [[part, TOKENIZER.toolCallOverhead], ...content.map((c): PartRun => [part, c.type === 'text' ? estimateTokens(c.text) : c.type === 'image' ? TOKENIZER.imageTokens : estimateTokens(JSON.stringify(c))])];
  }
  if (block.type !== 'text') return [['user', estimateTokens(JSON.stringify(block))]];
  const items = labels.itemBlocks.get(block.text);
  if (items === undefined) return [[labels.texts.get(block.text) ?? 'user', estimateTokens(block.text)]];
  // The header and attached files are attachments; a rule or a skill the block carries is context.
  const whole = estimateTokens(block.text);
  const carried = items.map((item): PartRun => [ITEM_PART[item.kind], estimateTokens(item.text)]).filter(([part]) => part === 'context');
  const context = carried.reduce((sum, [, n]) => sum + n, 0);
  return [['attachments', Math.max(0, whole - context)], ...carried];
}

function systemRuns(system: MessageStreamParams['system']): PartRun[] {
  const text = typeof system === 'string' ? system : (system ?? []).map((b) => b.text).join('');
  const at = text.indexOf(MEMORY_PREAMBLE);
  return at < 0 ? [['system', estimateTokens(text)]] : [['system', estimateTokens(text.slice(0, at))], ['context', estimateTokens(text.slice(at))]];
}

/** Adjacent runs of one part merge, so a log line stays short. */
function merged(runs: readonly PartRun[]): PartRun[] {
  const out: [InputPart, number][] = [];
  for (const [part, tokens] of runs) {
    if (tokens === 0) continue;
    const last = out.at(-1);
    if (last !== undefined && last[0] === part) last[1] += tokens;
    else out.push([part, tokens]);
  }
  return out;
}

/**
 * A request split into parts, in the order it sends them: tools, then system, then each message. `events` is the
 * log the request was built from, which says what each user block is.
 */
export function requestRuns(request: MessageStreamParams, events: readonly TurnEvent[], adapter: Adapter): PartRun[] {
  const labels = labelsOf(events, adapter);
  const offered = request.tools ?? [];
  const tools = offered.map((tool): PartRun => ['tools', TOKENIZER.toolDefinitionOverhead + estimateTokens(JSON.stringify(tool))]);
  if (offered.length > 0) tools.push(['tools', TOKENIZER.toolsPreamble]);
  const messages = request.messages.flatMap((message): PartRun[] => {
    const blocks: readonly ContentBlockParam[] = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    const runs = blocks.flatMap((block) => blockRuns(block, message.role === 'user' ? 'user' : 'assistant', labels));
    const first = runs[0]?.[0] ?? (message.role === 'user' ? 'user' : 'assistant');
    return [[first, TOKENIZER.messageOverhead], ...runs];
  });
  return merged([...tools, ...systemRuns(request.system), ...messages]);
}

/** Whole numbers in proportion to `weights` that sum to `total` exactly, by largest remainder. */
export function apportion(weights: readonly number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum === 0) return weights.map(() => 0);
  const exact = weights.map((w) => (w * total) / sum);
  const floors = exact.map(Math.floor);
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - floors[i]!, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left-- <= 0) break;
    floors[i]! += 1;
  }
  return floors;
}

const ZERO_PART: PartUsage = { usage: ZERO_USAGE, costUsd: 0 };

const priced = (usage: TokenUsage, rates: Rates | undefined): PartUsage => ({ usage, costUsd: costAt(rates, usage) });

export const EMPTY_BREAKDOWN: Breakdown = {
  basis: 'provider',
  requests: 0,
  parts: Object.fromEntries(PARTS.map((p) => [p, ZERO_PART])) as Record<Part, PartUsage>,
  total: ZERO_PART,
};

/**
 * One request's breakdown. The provider's count is the truth when it gives one: the runs share its input total in
 * proportion to their estimates, and since the cached prefix is the front of the request, the first `cacheRead`
 * tokens billed as cache reads, the next `cacheWrite` as cache writes, and the rest as uncached input. The parts
 * then sum to the request's usage exactly, and their costs to its cost.
 */
export function requestBreakdown(runs: readonly PartRun[] | undefined, usage: TokenUsage, rates: Rates | undefined): Breakdown {
  const counted = inputOf(usage);
  const split = runs !== undefined && runs.length > 0;
  const basis: TokenBasis = counted === 0 && split ? 'estimated' : 'provider';
  const line: readonly (readonly [Part, number])[] = split ? runs : counted === 0 ? [] : [['unsplit', counted]];
  const tokens = basis === 'estimated' ? line.map(([, n]) => n) : apportion(line.map(([, n]) => n), counted);
  const read = basis === 'estimated' ? 0 : usage.cacheRead;
  const write = basis === 'estimated' ? 0 : usage.cacheWrite;
  const parts = new Map<Part, TokenUsage>();
  let at = 0;
  line.forEach(([part], i) => {
    const start = at;
    const end = (at += tokens[i]!);
    const overlap = (from: number, to: number) => Math.max(0, Math.min(end, to) - Math.max(start, from));
    const share: TokenUsage = { cacheRead: overlap(0, read), cacheWrite: overlap(read, read + write), input: overlap(read + write, Infinity), output: 0 };
    parts.set(part, addUsage(parts.get(part) ?? ZERO_USAGE, share));
  });
  parts.set('output', { ...ZERO_USAGE, output: usage.output });
  const total: TokenUsage = basis === 'estimated' ? { ...ZERO_USAGE, input: at, output: usage.output } : usage;
  return {
    basis,
    requests: 1,
    parts: Object.fromEntries(PARTS.map((p) => [p, priced(parts.get(p) ?? ZERO_USAGE, rates)])) as Record<Part, PartUsage>,
    total: priced(total, rates),
  };
}

const addCost = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b);

const addPart = (a: PartUsage, b: PartUsage): PartUsage => ({ usage: addUsage(a.usage, b.usage), costUsd: addCost(a.costUsd, b.costUsd) });

export const addBreakdowns = (a: Breakdown, b: Breakdown): Breakdown => ({
  basis: a.basis === 'estimated' || b.basis === 'estimated' ? 'estimated' : 'provider',
  requests: a.requests + b.requests,
  parts: Object.fromEntries(PARTS.map((p) => [p, addPart(a.parts[p], b.parts[p])])) as Record<Part, PartUsage>,
  total: addPart(a.total, b.total),
});
