import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  asCompletionId,
  buildNextEditPrompt,
  COMPLETION_SOURCES,
  editMoments,
  FILTER_NAMES,
  foldTabEvents,
  GRADES,
  gradePrediction,
  MAX_HISTORY,
  OUTCOME_KINDS,
  parseNextEdit,
  percentile,
  streamNextEdit,
  tabReport,
  type FimResult,
  type Grade,
  type ModelReport,
  type NextEditPrompt,
  type Spread,
  type TabEvent,
} from '@g-code/core/tab';
import { UsageError, type Command } from './command.js';
import { EngineError } from './errors.js';
import { isMissing, readTriples, StoreError } from './store.js';

const ms = z.number().nonnegative();
const id = z.string().min(1).transform(asCompletionId);

const outcome = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(OUTCOME_KINDS).exclude(['suppressed']) }),
  z.strictObject({ kind: z.literal('suppressed'), filter: z.enum(FILTER_NAMES) }),
]);

const snippet = z.strictObject({ path: z.string(), text: z.string() });
const offset = z.number().int().nonnegative();
const span = { start: offset, end: offset };

const requestFields = {
  id,
  path: z.string(),
  version: z.number().int(),
  offset,
  model: z.string().min(1),
  source: z.enum(COMPLETION_SOURCES),
  promptTokens: z.number().int().nonnegative(),
  sentAt: z.iso.datetime(),
  ttftMs: ms.nullable(),
  latencyMs: ms.nullable(),
  text: z.string().nullable(),
  outcome,
  persisted: z.union([z.boolean(), z.literal('unknown')]),
};

const historyEntry = z.strictObject({
  path: z.string(),
  at: z.iso.datetime(),
  line: offset,
  oldText: z.string(),
  newText: z.string(),
});

const request = z.discriminatedUnion('kind', [
  z.strictObject({
    ...requestFields,
    kind: z.literal('fim'),
    inputs: z.strictObject({
      repo: z.string(),
      path: z.string(),
      prefix: z.string(),
      suffix: z.string(),
      snippets: z.array(snippet),
    }),
  }),
  z.strictObject({
    ...requestFields,
    kind: z.literal('next-edit'),
    inputs: z.strictObject({
      path: z.string(),
      cursor: offset,
      region: z.strictObject({ ...span, text: z.string() }),
      history: z.array(historyEntry),
      related: z.array(snippet),
    }),
    edit: z.strictObject({ ...span, text: z.string() }).nullable(),
  }),
]);

const tabEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('request'), request }),
  z.strictObject({ kind: z.literal('outcome'), id, at: z.iso.datetime(), outcome }),
  z.strictObject({ kind: z.literal('persisted'), id, at: z.iso.datetime(), persisted: z.boolean() }),
]);

/** A torn last line is skipped: the extension may have died mid-append. */
export async function readTabEvents(file: string): Promise<TabEvent[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const lines = text.split('\n');
  const lastLine = text.endsWith('\n') ? lines.length - 1 : lines.length;
  const events: TabEvent[] = [];
  for (let i = 0; i < lastLine; i++) {
    let raw: unknown;
    try {
      raw = JSON.parse(lines[i]!);
    } catch (error) {
      if (i === lastLine - 1 && !text.endsWith('\n')) break;
      throw new StoreError(file, `line ${i + 1}: ${(error as Error).message}`);
    }
    const parsed = tabEventSchema.safeParse(raw);
    if (!parsed.success) throw new StoreError(file, `line ${i + 1}: ${z.prettifyError(parsed.error)}`);
    events.push(parsed.data);
  }
  return events;
}

const millis = (value: number | null): string => (value === null ? '-' : `${Math.round(value)} ms`);
const tokens = (value: number | null): string => (value === null ? '-' : `${Math.round(value)}`);
const rate = (value: number | null): string => (value === null ? '-' : `${(value * 100).toFixed(1)}%`);
const pair = (s: Spread, show: (v: number | null) => string): string => `p50 ${show(s.p50)}, p90 ${show(s.p90)}`;

function printModel(out: (line: string) => void, r: ModelReport): void {
  out(`model: ${r.model} (${r.kind})`);
  out(`  requests: ${r.total}`);
  for (const [kind, count] of Object.entries(r.byOutcome)) out(`    ${kind}: ${count}`);
  out(`  shown: ${r.shown} (${r.timedShown} answered by the model, ${r.shown - r.timedShown} reused)`);
  out(`  time to first token: ${pair(r.ttftMs, millis)}`);
  out(`  total latency: ${pair(r.latencyMs, millis)}`);
  out(`  prompt tokens: ${pair(r.promptTokens, tokens)}`);
  out(`  accept per shown: ${rate(r.acceptPerShown)}`);
  out(`  persisted per accepted: ${rate(r.persistedPerAccepted)}`);
}

const report: Command = async (args, { io, store }) => {
  const { values } = parseArgs({ args, strict: true, options: { since: { type: 'string' } } });
  if (values.since !== undefined && Number.isNaN(Date.parse(values.since))) {
    throw new UsageError(`--since must be an ISO date: ${values.since}`);
  }
  const models = tabReport(foldTabEvents(await readTabEvents(store.tabEvents)), values.since);
  io.out(`log: ${store.tabEvents}`);
  if (models.length === 0) io.out('no completion requests');
  for (const model of models) printModel(io.out, model);
  return 0;
};

const DEFAULT_NEXT_EDIT_ENDPOINT = 'http://127.0.0.1:8013';

function count(flag: string, raw: string, min: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new UsageError(`--${flag} must be an integer of at least ${min}`);
  return value;
}

/** Code unlike the replayed files, so warming the server caches none of their prompts. */
const warmupDocument = (i: number): string =>
  Array.from({ length: 60 }, (_, line) => `def step_${i}_${line}(state):\n    return state + ${line}\n`).join('');

type ReplayRow = {
  readonly id: string;
  readonly grade: Grade;
  readonly none: string | null;
  /** Whether the target hunk lies inside the editable region the model was allowed to rewrite. */
  readonly reachable: boolean;
  readonly historyEntries: number;
  readonly promptTokensEstimate: number;
  readonly promptTokens: number | null;
  readonly processedTokens: number | null;
  readonly generatedTokens: number | null;
  readonly ttftMs: number | null;
  readonly latencyMs: number;
  readonly output: string;
};

async function ask(endpoint: string, prompt: NextEditPrompt, fetch: typeof globalThis.fetch): Promise<FimResult> {
  try {
    return await streamNextEdit({ fetch, endpoint, prompt, now: () => performance.now() });
  } catch (error) {
    throw new EngineError(`next-edit server at ${endpoint}: ${(error as Error).message}`);
  }
}

const replayCommand: Command = async (args, { io, store }) => {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      history: { type: 'string', default: String(MAX_HISTORY) },
      limit: { type: 'string', default: '100' },
      warmup: { type: 'string', default: '3' },
      endpoint: { type: 'string', default: DEFAULT_NEXT_EDIT_ENDPOINT },
      out: { type: 'string' },
    },
  });
  const history = count('history', values.history, 1);
  const limit = count('limit', values.limit, 1);
  const warmup = count('warmup', values.warmup, 0);
  const fetch = io.fetch ?? globalThis.fetch;
  const triples = (await readTriples(store)).toSorted((a, b) => a.id.localeCompare(b.id));
  const moments = triples
    .flatMap((t) => editMoments({ id: t.id, path: t.path, before: t.before, after: t.expected }, history))
    .slice(0, limit);
  const out =
    values.out ?? path.join(store.evalsDir, 'tab-replay', `${new Date().toISOString().replaceAll(':', '-')}-h${history}.jsonl`);
  io.out(`triples: ${triples.length} in ${store.triplesDir}, moments: ${moments.length}, history: ${history}`);
  io.out(`endpoint: ${values.endpoint}, warmup: ${warmup} uncounted, sequential`);
  io.out(`load average at start: ${loadavg().map((l) => l.toFixed(2)).join(' ')}`);
  if (moments.length === 0) {
    io.out('no edit moments');
    return 0;
  }

  for (let i = 0; i < warmup; i++) {
    const text = warmupDocument(i);
    await ask(values.endpoint, buildNextEditPrompt([], { path: `warmup_${i}.py`, text }, text.length / 2, []), fetch);
  }

  await mkdir(path.dirname(out), { recursive: true });
  const rows: ReplayRow[] = [];
  let model: string | null = null;
  for (const moment of moments) {
    const prompt = buildNextEditPrompt(moment.history, { path: moment.path, text: moment.document }, moment.cursor, []);
    const result = await ask(values.endpoint, prompt, fetch);
    model ??= result.model;
    const prediction = parseNextEdit(result.text, prompt.inputs.region);
    const { region } = prompt.inputs;
    const row: ReplayRow = {
      id: moment.id,
      grade: gradePrediction(moment, prediction),
      none: prediction.kind === 'none' ? prediction.reason : null,
      reachable: moment.target.start >= region.start && moment.target.end <= region.end,
      historyEntries: prompt.inputs.history.length,
      promptTokensEstimate: prompt.tokens,
      promptTokens: result.promptTokens,
      processedTokens: result.timings?.promptTokens ?? null,
      generatedTokens: result.timings?.predictedTokens ?? null,
      ttftMs: result.ttftMs,
      latencyMs: result.latencyMs,
      output: result.text,
    };
    rows.push(row);
    await appendFile(out, `${JSON.stringify(row)}\n`);
  }

  const spread = (xs: readonly (number | null)[]): Spread => {
    const known = xs.filter((x): x is number => x !== null);
    return { p50: percentile(known, 50), p90: percentile(known, 90) };
  };
  io.out(`model: ${model ?? 'unknown'}`);
  io.out(`results: ${out}`);
  io.out(`load average at end: ${loadavg().map((l) => l.toFixed(2)).join(' ')}`);
  io.out(`grades (of ${rows.length}):`);
  for (const grade of GRADES) io.out(`  ${grade}: ${rows.filter((r) => r.grade === grade).length}`);
  const reachable = rows.filter((r) => r.reachable);
  io.out(`target inside the editable region: ${reachable.length}; exact among those: ${reachable.filter((r) => r.grade === 'exact').length}`);
  io.out(`time to first token: ${pair(spread(rows.map((r) => r.ttftMs)), millis)}`);
  io.out(`total latency: ${pair(spread(rows.map((r) => r.latencyMs)), millis)}`);
  io.out(`prompt tokens (server): ${pair(spread(rows.map((r) => r.promptTokens)), tokens)}`);
  io.out(`prompt tokens processed: ${pair(spread(rows.map((r) => r.processedTokens)), tokens)}`);
  io.out(`generated tokens: ${pair(spread(rows.map((r) => r.generatedTokens)), tokens)}`);
  return 0;
};

export const tabCommands: Record<string, Command> = { report, replay: replayCommand };
