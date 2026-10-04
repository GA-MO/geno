import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  asCompletionId,
  COMPLETION_KINDS,
  COMPLETION_SOURCES,
  FILTER_NAMES,
  foldTabEvents,
  OUTCOME_KINDS,
  tabReport,
  type ModelReport,
  type Spread,
  type TabEvent,
} from '@g-code/core/tab';
import { UsageError, type Command } from './command.js';
import { isMissing, StoreError } from './store.js';

const ms = z.number().nonnegative();
const id = z.string().min(1).transform(asCompletionId);

const outcome = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(OUTCOME_KINDS).exclude(['suppressed']) }),
  z.strictObject({ kind: z.literal('suppressed'), filter: z.enum(FILTER_NAMES) }),
]);

const snippet = z.strictObject({ path: z.string(), text: z.string() });

const tabEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('request'),
    request: z.strictObject({
      id,
      kind: z.enum(COMPLETION_KINDS),
      path: z.string(),
      version: z.number().int(),
      offset: z.number().int().nonnegative(),
      inputs: z.strictObject({
        repo: z.string(),
        path: z.string(),
        prefix: z.string(),
        suffix: z.string(),
        snippets: z.array(snippet),
      }),
      model: z.string().min(1),
      source: z.enum(COMPLETION_SOURCES),
      promptTokens: z.number().int().nonnegative(),
      sentAt: z.iso.datetime(),
      ttftMs: ms.nullable(),
      latencyMs: ms.nullable(),
      text: z.string().nullable(),
      outcome,
      persisted: z.union([z.boolean(), z.literal('unknown')]),
    }),
  }),
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
  out(`model: ${r.model}`);
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

export const tabCommands: Record<string, Command> = { report };
