import { PART_NAMES, PARTS, tokensOf, type Breakdown, type Part, type TokenBasis } from './parts.js';
import type { ChildSpend, SessionSpend, TurnSpend } from './spend.js';

const addCost = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : a + b);
const sumCost = (costs: readonly (number | null)[]): number | null => costs.reduce<number | null>(addCost, 0);

/** How the panel and `gcode usage` write numbers: short enough for a 300px row, precise where small values matter. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** A turn on a cheap model costs a fraction of a cent, so small amounts keep four decimals. */
export const formatUsd = (usd: number): string => (usd > 0 && usd < 0.00005 ? '<$0.0001' : usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

export const formatBaht = (usd: number, bahtPerUsd: number): string => {
  const baht = usd * bahtPerUsd;
  return baht > 0 && baht < 0.01 ? '<฿0.01' : `฿${baht.toFixed(2)}`;
};

const formatShare = (share: number): string => (share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`);

export const DEFAULT_BAHT_PER_USD = 33;

/** A cost as the views show it: baht first, the dollars beside it, or "no price" for an unpriced model. */
export type CostText = { readonly baht: string; readonly usd: string };

const costText = (usd: number | null, bahtPerUsd: number): CostText =>
  usd === null ? { baht: 'no price', usd: 'no price' } : { baht: formatBaht(usd, bahtPerUsd), usd: formatUsd(usd) };

export type SpendRowKey = Part | 'children';

export type SpendRow = {
  readonly key: SpendRowKey;
  readonly label: string;
  /** Empty for the subagents row, whose tokens are in their own sessions. */
  readonly tokens: string;
  /** Of the cost when it is priced, else of the tokens; 0 to 1. */
  readonly share: number;
  readonly percent: string;
  readonly cost: CostText;
  readonly driver: boolean;
};

export type BreakdownView = {
  readonly basis: TokenBasis;
  /** What the numbers rest on, in one line. */
  readonly note: string;
  /** "Tool results are 61% of the cost", or undefined when nothing was spent. */
  readonly driver: string | undefined;
  readonly rows: readonly SpendRow[];
  readonly tokens: string;
  readonly cost: CostText;
  /** How the input billed: cache read, cache write, uncached, and the output. */
  readonly cache: string;
  readonly requests: string;
};

export type TurnSpendView = ({ readonly kind: 'model' } & BreakdownView) | { readonly kind: 'external'; readonly text: string; readonly cost: CostText | undefined };

const SUBAGENTS = { label: 'Subagents', subject: 'subagents are' } as const;

const NOTES: Readonly<Record<TokenBasis, string>> = {
  provider: "The provider's token count, split into parts by Geno's estimate.",
  estimated: 'Estimated: the provider reported no token count.',
};

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** Over a session, a file a turn read counts in that turn and as a tool result in every later one. */
const SESSION_LABELS: Partial<Record<Part, string>> = { files: 'Files as first read' };

function breakdownView(breakdown: Breakdown, children: readonly ChildSpend[], bahtPerUsd: number, labels: Partial<Record<Part, string>> = {}): BreakdownView {
  const childCost = sumCost(children.map((c) => c.costUsd));
  const totalCost = addCost(breakdown.total.costUsd, children.length === 0 ? 0 : childCost);
  const byCost = totalCost !== null && totalCost > 0;
  const totalTokens = tokensOf(breakdown.total.usage);
  const entries = [
    ...PARTS.flatMap((part) => {
      const { usage, costUsd } = breakdown.parts[part];
      const tokens = tokensOf(usage);
      return tokens === 0 ? [] : [{ key: part as SpendRowKey, names: PART_NAMES[part], tokens: formatTokens(tokens), weight: byCost ? (costUsd ?? 0) : tokens, costUsd }];
    }),
    ...(children.length === 0 ? [] : [{ key: 'children' as SpendRowKey, names: SUBAGENTS, tokens: '', weight: byCost ? (childCost ?? 0) : 0, costUsd: childCost }]),
  ];
  const whole = byCost ? totalCost : totalTokens;
  const biggest = entries.reduce<(typeof entries)[number] | undefined>((best, e) => (best === undefined || e.weight > best.weight ? e : best), undefined);
  const rows = entries.map(
    (e): SpendRow => ({ key: e.key, label: (e.key === 'children' ? undefined : labels[e.key]) ?? e.names.label, tokens: e.tokens, share: whole > 0 ? e.weight / whole : 0, percent: formatShare(whole > 0 ? e.weight / whole : 0), cost: costText(e.costUsd, bahtPerUsd), driver: e === biggest }),
  );
  const top = rows.find((r) => r.driver);
  const { usage } = breakdown.total;
  return {
    basis: breakdown.basis,
    note: NOTES[breakdown.basis],
    driver: top === undefined || whole <= 0 ? undefined : `${capitalized(biggest!.names.subject)} ${top.percent} of the ${byCost ? 'cost' : 'tokens'}`,
    rows,
    tokens: formatTokens(totalTokens),
    cost: costText(totalCost, bahtPerUsd),
    cache: `Cache read ${formatTokens(usage.cacheRead)} · write ${formatTokens(usage.cacheWrite)} · uncached ${formatTokens(usage.input)} · output ${formatTokens(usage.output)}`,
    requests: breakdown.requests === 1 ? '1 model call' : `${breakdown.requests} model calls`,
  };
}

export function turnSpendView(turn: TurnSpend, bahtPerUsd: number): TurnSpendView {
  if (turn.kind === 'external') return { kind: 'external', text: `${turn.plan}, no token data`, cost: turn.costUsd === null ? undefined : costText(turn.costUsd, bahtPerUsd) };
  return { kind: 'model', ...breakdownView(turn.breakdown, turn.children, bahtPerUsd) };
}

export type TopTurnView = { readonly seq: number; readonly prompt: string; readonly cost: CostText; readonly tokens: string; readonly driver: string | undefined };

export type SessionSpendView = {
  readonly cost: CostText;
  readonly turns: string;
  /** The model requests of the whole session; undefined when every turn ran on an external agent. */
  readonly breakdown: BreakdownView | undefined;
  readonly top: readonly TopTurnView[];
  readonly children: { readonly count: string; readonly cost: CostText } | undefined;
  /** "Cursor plan, no token data" when the session runs on an external agent. */
  readonly external: string | undefined;
};

const PROMPT_CHARS = 60;

const shortPrompt = (prompt: string): string => {
  const line = prompt.replace(/\s+/g, ' ').trim();
  return line.length <= PROMPT_CHARS ? line : `${line.slice(0, PROMPT_CHARS - 1)}…`;
};

export function sessionSpendView(spend: SessionSpend, bahtPerUsd: number): SessionSpendView {
  const external = spend.turns.find((t) => t.kind === 'external');
  const top = spend.top.flatMap((seq): TopTurnView[] => {
    const turn = spend.turns.find((t) => t.seq === seq);
    if (turn === undefined) return [];
    const view = turnSpendView(turn, bahtPerUsd);
    return [{ seq, prompt: shortPrompt(turn.prompt), cost: costText(turn.costUsd, bahtPerUsd), tokens: view.kind === 'model' ? view.tokens : '', driver: view.kind === 'model' ? view.driver : undefined }];
  });
  return {
    cost: costText(spend.costUsd, bahtPerUsd),
    turns: spend.turns.length === 1 ? '1 turn' : `${spend.turns.length} turns`,
    breakdown: external !== undefined && external.kind === 'external' ? undefined : breakdownView(spend.breakdown, [], bahtPerUsd, SESSION_LABELS),
    top,
    children: spend.children.length === 0 ? undefined : { count: spend.children.length === 1 ? '1 subagent' : `${spend.children.length} subagents`, cost: costText(spend.childrenCostUsd, bahtPerUsd) },
    external: external?.kind === 'external' ? `${external.plan}, no token data` : undefined,
  };
}

/** The text `gcode usage` prints: the same view the panel draws, one line per row. */
export function spendLines(spend: SessionSpend, bahtPerUsd: number): string[] {
  const view = sessionSpendView(spend, bahtPerUsd);
  const rowLines = (b: BreakdownView) => b.rows.map((r) => `  ${r.label.padEnd(22)} ${r.tokens.padStart(6)} ${r.percent.padStart(4)} ${r.cost.baht.padStart(8)} ${r.cost.usd.padStart(9)}${r.driver ? '  <- biggest' : ''}`);
  const lines = [`session ${spend.sessionId} · ${spend.model} · ${view.turns} · ${view.cost.baht} (${view.cost.usd})`];
  if (view.external !== undefined) lines.push(view.external);
  if (view.breakdown !== undefined) lines.push(view.breakdown.note, view.breakdown.cache, ...rowLines(view.breakdown));
  if (view.children !== undefined) lines.push(`${view.children.count}: ${view.children.cost.baht} (${view.children.cost.usd})`);
  lines.push('top turns:', ...view.top.map((t) => `  #${t.seq} ${t.cost.baht} (${t.cost.usd}) ${t.tokens} ${t.prompt}${t.driver === undefined ? '' : ` · ${t.driver}`}`));
  for (const turn of spend.turns) {
    const t = turnSpendView(turn, bahtPerUsd);
    lines.push(`turn #${turn.seq}: ${shortPrompt(turn.prompt)}`);
    if (t.kind === 'external') lines.push(`  ${t.text}${t.cost === undefined ? '' : ` · ${t.cost.baht} (${t.cost.usd})`}`);
    else lines.push(`  ${t.requests} · ${t.tokens} · ${t.cost.baht} (${t.cost.usd})${t.driver === undefined ? '' : ` · ${t.driver}`}`, ...rowLines(t));
  }
  return lines;
}
