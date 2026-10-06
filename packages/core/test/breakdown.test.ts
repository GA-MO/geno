import { describe, expect, it } from 'vitest';
import {
  apportion,
  asSessionId,
  buildRequest,
  costOf,
  estimateTokens,
  MEMORY_PREAMBLE,
  PARTS,
  ratesOf,
  requestBreakdown,
  requestRuns,
  sessionSpend,
  sessionSpendView,
  spendLines,
  turnSpendView,
  ZERO_USAGE,
  type Breakdown,
  type PartRun,
  type Session,
  type TokenUsage,
  type TurnEvent,
} from '../src/index.js';

const at = '2026-10-07T00:00:00.000Z';
const session: Session = { id: asSessionId('s1'), createdAt: at, workspace: '/w', provider: 'modelstudio', model: 'qwen3.8-flash', effort: 'medium' };
const rates = ratesOf('modelstudio', 'qwen3.8-flash');
const usage = (u: Partial<TokenUsage>): TokenUsage => ({ ...ZERO_USAGE, ...u });

/** The contract: parts sum to the request's usage exactly in every bucket, and their costs to its cost within 1e-9 USD. */
function expectSums(breakdown: Breakdown, total: TokenUsage): void {
  for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) {
    expect(PARTS.reduce((sum, p) => sum + breakdown.parts[p].usage[bucket], 0), bucket).toBe(total[bucket]);
  }
  const cost = PARTS.reduce((sum, p) => sum + breakdown.parts[p].costUsd!, 0);
  expect(Math.abs(cost - costOf('modelstudio', 'qwen3.8-flash', total)!)).toBeLessThan(1e-9);
  expect(Math.abs(breakdown.total.costUsd! - cost)).toBeLessThan(1e-9);
}

describe('estimateTokens', () => {
  it.each([
    ['', 0],
    ['hello', 1],
    ['hello world', 2],
    ['internationalization', 3],
    ['12345', 5],
    ['{"a":1}', 5],
    ['line\n\nnext', 3],
    ['กข', 2],
  ])('%j is %i tokens', (text, tokens) => {
    expect(estimateTokens(text)).toBe(tokens);
  });
});

describe('apportion', () => {
  it.each([
    [[1, 1, 1], 1000, [334, 333, 333]],
    [[100, 300, 100], 1000, [200, 600, 200]],
    [[0, 0], 10, [0, 0]],
    [[7, 0, 3], 1, [1, 0, 0]],
  ])('%j over %i is %j', (weights, total, out) => {
    expect(apportion(weights, total)).toEqual(out);
    if (weights.some((w) => w > 0)) expect(out.reduce((a, b) => a + b, 0)).toBe(total);
  });
});

const RUNS: readonly PartRun[] = [
  ['tools', 100],
  ['system', 300],
  ['toolResults', 50],
  ['prompt', 50],
];

describe('requestBreakdown', () => {
  it.each<{ name: string; runs: readonly PartRun[] | undefined; usage: TokenUsage; parts: Partial<Record<string, Partial<TokenUsage>>>; basis: string }>([
    {
      name: 'shares an uncached count by the estimate',
      runs: RUNS,
      usage: usage({ input: 1000, output: 40 }),
      parts: { tools: { input: 200 }, system: { input: 600 }, toolResults: { input: 100 }, prompt: { input: 100 }, output: { output: 40 } },
      basis: 'provider',
    },
    {
      name: 'puts cache reads at the front of the request, then writes, then uncached input',
      runs: RUNS,
      usage: usage({ cacheRead: 600, cacheWrite: 200, input: 200, output: 10 }),
      parts: { tools: { cacheRead: 200 }, system: { cacheRead: 400, cacheWrite: 200 }, toolResults: { input: 100 }, prompt: { input: 100 }, output: { output: 10 } },
      basis: 'provider',
    },
    {
      name: 'keeps the estimate when the provider counted no input',
      runs: RUNS,
      usage: usage({ output: 30 }),
      parts: { tools: { input: 100 }, system: { input: 300 }, toolResults: { input: 50 }, prompt: { input: 50 }, output: { output: 30 } },
      basis: 'estimated',
    },
    {
      name: 'leaves a request logged before the split whole',
      runs: undefined,
      usage: usage({ input: 500, cacheRead: 100, output: 5 }),
      parts: { unsplit: { input: 500, cacheRead: 100 }, output: { output: 5 } },
      basis: 'provider',
    },
    {
      name: 'rounds by largest remainder',
      runs: [['system', 1], ['user', 1], ['prompt', 1]],
      usage: usage({ input: 1000 }),
      parts: { system: { input: 334 }, user: { input: 333 }, prompt: { input: 333 } },
      basis: 'provider',
    },
  ])('$name', ({ runs, usage: u, parts, basis }) => {
    const breakdown = requestBreakdown(runs, u, rates);
    expect(breakdown.basis).toBe(basis);
    for (const part of PARTS) expect(breakdown.parts[part].usage, part).toEqual({ ...ZERO_USAGE, ...parts[part] });
    expectSums(breakdown, breakdown.total.usage);
    if (basis === 'provider') expect(breakdown.total.usage).toEqual(u);
  });

  it('has no cost for an unpriced model', () => {
    const breakdown = requestBreakdown(RUNS, usage({ input: 10 }), undefined);
    expect(breakdown.total.costUsd).toBeNull();
    expect(breakdown.parts.system.costUsd).toBeNull();
  });
});

const tool = { name: 'read', description: 'Read a file.', input_schema: { type: 'object' as const, properties: { path: { type: 'string' } } } };
const context = { instructions: [{ path: 'AGENTS.md', text: 'Use pnpm.' }], rules: [], skills: [] };

const LOG: TurnEvent[] = [
  { kind: 'session-start', session, context },
  { kind: 'user', seq: 1, at, content: 'first question' },
  { kind: 'assistant', seq: 2, at, content: [{ type: 'tool_use', id: 'tu1', name: 'grep', input: { pattern: 'x' } }], stopReason: 'tool_use', usage: usage({ input: 900, output: 20 }), costUsd: 0, latencyMs: 1, model: 'm' },
  { kind: 'tool-result', seq: 3, at, toolUseId: 'tu1', name: 'grep', status: 'ok', output: 'a.ts:1: x' },
  { kind: 'assistant', seq: 4, at, content: [{ type: 'text', text: 'Found it.', citations: null }], stopReason: 'end_turn', usage: usage({ input: 950, output: 5 }), costUsd: 0, latencyMs: 1, model: 'm' },
  {
    kind: 'user',
    seq: 5,
    at,
    content: 'second question',
    context: [{ kind: 'skill', name: 'add-i18n', path: '.agents/skills/add-i18n/SKILL.md', text: 'Add a locale.' }, { kind: 'file', path: 'b.ts', text: 'export const b = 1;' }],
  },
  { kind: 'assistant', seq: 6, at, content: [{ type: 'tool_use', id: 'tu2', name: 'read', input: { path: 'a.ts' } }], stopReason: 'tool_use', usage: usage({ input: 1000, output: 10 }), costUsd: 0, latencyMs: 1, model: 'm' },
  { kind: 'tool-result', seq: 7, at, toolUseId: 'tu2', name: 'read', status: 'ok', output: 'export const a = 1;' },
];

describe('requestRuns', () => {
  it('labels each stretch of a request by what it is, in the order the request sends them', () => {
    const system = `You are Geno.\n\n${MEMORY_PREAMBLE}\n<memory></memory>`;
    const runs = requestRuns(buildRequest(session, LOG, [tool], system), LOG, 'anthropic');
    expect(runs.map(([part]) => part)).toEqual(['tools', 'system', 'context', 'user', 'assistant', 'toolResults', 'assistant', 'prompt', 'attachments', 'context', 'assistant', 'files']);
    expect(runs.every(([, tokens]) => tokens > 0)).toBe(true);
  });

  it('counts thinking only where the wire sends it back', () => {
    const thought: TurnEvent[] = [
      { kind: 'session-start', session },
      { kind: 'user', seq: 1, at, content: 'q' },
      { kind: 'assistant', seq: 2, at, content: [{ type: 'thinking', thinking: 'a long chain of thought about the question', signature: 's' }, { type: 'text', text: 'a', citations: null }], stopReason: 'end_turn', usage: ZERO_USAGE, costUsd: 0, latencyMs: 1, model: 'm' },
      { kind: 'user', seq: 3, at, content: 'r' },
    ];
    const tokens = (adapter: 'anthropic' | 'openai') => requestRuns(buildRequest(session, thought), thought, adapter).filter(([p]) => p === 'assistant').reduce((s, [, n]) => s + n, 0);
    expect(tokens('anthropic') - tokens('openai')).toBe(estimateTokens('a long chain of thought about the question'));
  });
});

const call = (seq: number, runs: readonly PartRun[], u: TokenUsage): TurnEvent => ({
  kind: 'assistant',
  seq,
  at,
  content: [{ type: 'text', text: 'ok', citations: null }],
  stopReason: 'end_turn',
  usage: u,
  costUsd: costOf('modelstudio', 'qwen3.8-flash', u),
  latencyMs: 1,
  model: 'qwen3.8-flash',
  promptParts: runs,
});

const SPEND_LOG: TurnEvent[] = [
  { kind: 'session-start', session },
  { kind: 'user', seq: 1, at, content: 'small' },
  call(2, [['system', 900], ['prompt', 100]], usage({ input: 1000, output: 10 })),
  { kind: 'user', seq: 3, at, content: 'big' },
  call(4, [['system', 900], ['prompt', 100]], usage({ cacheRead: 1000, output: 10 })),
  call(5, [['system', 900], ['toolResults', 8000], ['prompt', 100]], usage({ cacheRead: 1000, input: 9000, output: 100 })),
  { kind: 'child-start', seq: 6, at, child: asSessionId('c1'), toolUseId: 'tu', role: 'explore', model: 'm', effort: 'low', caps: { maxTurns: 4, maxCostUsd: 0.02 }, start: 'fresh' },
  { kind: 'child-end', seq: 7, at, child: asSessionId('c1'), toolUseId: 'tu', end: { kind: 'done' }, turns: 3, costUsd: 0.001, summary: 's' },
  ...[8, 10, 12, 14, 16].flatMap((seq): TurnEvent[] => [
    { kind: 'user', seq, at, content: `tiny ${seq}` },
    call(seq + 1, [['prompt', 10]], usage({ input: 10, output: 1 })),
  ]),
];

describe('sessionSpend', () => {
  const spend = sessionSpend(SPEND_LOG);

  it('sums every request of a turn and counts its children', () => {
    const big = spend.turns.find((t) => t.seq === 3)!;
    expect(big.kind).toBe('model');
    if (big.kind !== 'model') return;
    expect(big.breakdown.requests).toBe(2);
    expect(big.children).toEqual([{ child: 'c1', role: 'explore', turns: 3, costUsd: 0.001 }]);
    expect(big.costUsd).toBeCloseTo(big.breakdown.total.costUsd! + 0.001, 12);
    expectSums(big.breakdown, usage({ cacheRead: 2000, input: 9000, output: 110 }));
  });

  it('ranks the five costliest turns, and the session total sums turns and children', () => {
    expect(spend.top).toEqual([3, 1, 8, 10, 12]);
    const turns = spend.turns.reduce((s, t) => s + (t.kind === 'model' ? t.breakdown.total.costUsd! : 0), 0);
    expect(spend.costUsd).toBeCloseTo(turns + 0.001, 12);
    expect(spend.childrenCostUsd).toBe(0.001);
  });

  it('names the biggest driver of a turn by its share of the cost', () => {
    const view = turnSpendView(spend.turns.find((t) => t.seq === 3)!, 33);
    if (view.kind !== 'model') throw new Error('a model turn');
    expect(view.driver).toBe('Tool results are 49% of the cost');
    expect(view.rows.filter((r) => r.driver).map((r) => r.key)).toEqual(['toolResults']);
    expect(view.rows.map((r) => r.key)).toEqual(['system', 'toolResults', 'prompt', 'output', 'children']);
    expect(view.requests).toBe('2 model calls');
    expect(view.note).toMatch(/^The provider's token count/);
    const shares = view.rows.reduce((s, r) => s + r.share, 0);
    expect(shares).toBeCloseTo(1, 9);
  });

  it('says an external agent turn has no token data', () => {
    const cursor: TurnEvent[] = [
      { kind: 'session-start', session: { ...session, backend: { id: 'cursor' } } },
      { kind: 'user', seq: 1, at, content: 'fix it' },
      { kind: 'assistant', seq: 2, at, content: [{ type: 'text', text: 'done', citations: null }], stopReason: 'end_turn', usage: ZERO_USAGE, costUsd: null, latencyMs: 1, model: 'cursor' },
    ];
    const external = sessionSpend(cursor);
    expect(turnSpendView(external.turns[0]!, 33)).toEqual({ kind: 'external', text: 'Cursor plan, no token data', cost: undefined });
    expect(sessionSpendView(external, 33).external).toBe('Cursor plan, no token data');
  });

  it('prints the same strings the views hold', () => {
    const view = sessionSpendView(spend, 33);
    const lines = spendLines(spend, 33);
    expect(lines[0]).toContain(view.cost.baht);
    for (const row of view.breakdown!.rows) expect(lines.some((l) => l.includes(row.label) && l.includes(row.cost.baht) && l.includes(row.percent))).toBe(true);
    expect(view.children).toEqual({ count: '1 subagent', cost: { baht: '฿0.03', usd: '$0.0010' } });
  });
});
