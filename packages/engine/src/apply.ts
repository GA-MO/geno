import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  APPLY_FAILURES,
  appliersFor,
  asSessionId,
  asTripleId,
  EDIT_FORMATS,
  isApplierName,
  PRICES,
  proposeChange,
  replay,
  summarize,
  TRIPLE_SCOPES,
  type ApplierName,
  type ApplyFailure,
  type ApplyModel,
  type BaseRead,
  type EditFormat,
  type ProposedChange,
  type ReplayCounts,
  type ReplayResult,
  type Session,
} from '@g-code/core';
import { chooseModel, DEFAULT_EFFORT, formatUsage } from './chat.js';
import { singleId, UsageError, type Command, type Io } from './command.js';
import { EngineError } from './errors.js';
import { gatewayFor, type Gateway } from './gateway.js';
import { isMissing, readTriple, readTriples } from './store.js';

/**
 * Applies a model's edit to a file on disk. Nothing is written unless the file still hashes to `base` and
 * the edit applies; the write goes through a temporary file so a crash never leaves half a file.
 */
export async function applyEditToFile(
  file: string,
  edit: { readonly path: string; readonly format: EditFormat; readonly raw: unknown; readonly base: BaseRead },
  turn: ProposedChange['turn'],
): Promise<ProposedChange> {
  let current: string | null;
  try {
    current = await readFile(file, 'utf8');
  } catch (error) {
    if (!isMissing(error)) throw error;
    current = null;
  }
  const { change, after } = proposeChange({ ...edit, current, turn });
  if (after !== null) {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, after);
    await rename(tmp, file);
  }
  return change;
}

// The gateway is built on the first model call, so the noop and oracle appliers need no API key.
function applyModel(io: Io, modelFlag: string | undefined, signal: AbortSignal): ApplyModel {
  const { provider, model } = chooseModel(io, { provider: undefined, model: modelFlag });
  const session: Session = {
    id: asSessionId(`eval-apply-${Date.now()}`),
    createdAt: new Date().toISOString(),
    workspace: io.cwd,
    provider,
    model,
    effort: DEFAULT_EFFORT,
  };
  let gateway: Gateway | undefined;
  return {
    name: model,
    call: (events, tools, system) => {
      gateway ??= gatewayFor(provider, io.env, io.fetch);
      return gateway.turn({ session, events, tools, system, signal, onText: () => {} });
    },
  };
}

function applierName(raw: string): ApplierName {
  if (!isApplierName(raw)) throw new UsageError(`unknown applier: ${raw}`);
  return raw;
}

function describeOutcome({ outcome }: ReplayResult): string {
  return outcome.kind === 'applied' ? 'applied' : `failed (${outcome.reason}): ${outcome.detail}`;
}

export const replayCommand: Command = async (args, { io, store }) => {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: { applier: { type: 'string', default: 'noop' }, model: { type: 'string' } },
  });
  const rawId = singleId(positionals, 'triple');
  const name = applierName(values.applier);
  const triple = await readTriple(store, asTripleId(rawId));
  if (triple === undefined) throw new EngineError(`no triple ${rawId} in ${store.triplesDir}`);

  const model = applyModel(io, values.model, io.interrupts());
  const result = await replay(triple, appliersFor(triple, model)[name]);
  io.out(`triple: ${result.tripleId}`);
  io.out(`applier: ${result.applier}`);
  io.out(`outcome: ${describeOutcome(result)}`);
  if (result.attempt !== null) {
    const { firstTry, retries, calls, usage, costUsd } = result.attempt;
    io.out(`model: ${result.attempt.model} first try: ${firstTry} retries: ${retries} calls: ${calls}`);
    io.out(`usage: ${formatUsage(usage, costUsd)}`);
  }
  io.out(`exact match: ${result.exactMatch ? 'yes' : 'no'}`);
  if (result.diff !== '') io.out(result.diff.trimEnd());
  return result.exactMatch ? 0 : 1;
};

function positiveNumber(flag: string, raw: string, integer: boolean): number {
  const value = Number(raw);
  if (!(value > 0) || (integer && !Number.isInteger(value))) {
    throw new UsageError(`--${flag} must be a positive ${integer ? 'integer' : 'number'}`);
  }
  return value;
}

const percent = (n: number, total: number): string => `${n}/${total} (${total === 0 ? '0.0' : ((n / total) * 100).toFixed(1)}%)`;

const COLUMNS: readonly [heading: string, cell: (c: ReplayCounts) => string][] = [
  ['triples', (c) => String(c.total)],
  ['exact', (c) => percent(c.exact, c.total)],
  ['exact-ignoring-ws', (c) => percent(c.exactIgnoringTrailingWhitespace, c.total)],
  ['first-try-failed', (c) => percent(c.firstTryFailed, c.total)],
  ['final-failed', (c) => percent(c.failed, c.total)],
  ['mean-retries', (c) => (c.total === 0 ? '0.00' : (c.retries / c.total).toFixed(2))],
];

function printTable(io: Io, rows: readonly [string, ReplayCounts][]): void {
  const cells = [['scope', ...COLUMNS.map(([heading]) => heading)], ...rows.map(([scope, c]) => [scope, ...COLUMNS.map(([, cell]) => cell(c))])];
  const widths = cells[0]!.map((_, i) => Math.max(...cells.map((row) => row[i]!.length)));
  for (const row of cells) io.out(row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd());
}

const reasonCounts = (tally: Readonly<Record<ApplyFailure, number>>): string => {
  const nonzero = APPLY_FAILURES.filter((reason) => tally[reason] > 0);
  return nonzero.length === 0 ? 'none' : nonzero.map((reason) => `${reason}=${tally[reason]}`).join(' ');
};

function progressLine(index: number, total: number, result: ReplayResult): string {
  const verdict = result.exactMatch ? 'exact' : result.exactIgnoringTrailingWhitespace ? 'exact-ignoring-ws' : 'differs';
  const outcome = result.outcome.kind === 'applied' ? verdict : `failed ${result.outcome.reason}`;
  const attempt = result.attempt === null ? '' : ` first-try=${result.attempt.firstTry} retries=${result.attempt.retries}`;
  return `[${index}/${total}] ${result.tripleId} ${result.scope} ${outcome}${attempt}`;
}

export const applyCommand: Command = async (args, { io, store }) => {
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      applier: { type: 'string', default: 'noop' },
      model: { type: 'string' },
      limit: { type: 'string' },
      'max-cost': { type: 'string', default: '0.50' },
      out: { type: 'string' },
      resume: { type: 'string' },
    },
  });
  if (values.out !== undefined && values.resume !== undefined) throw new UsageError('pass --out or --resume, not both');
  const name = applierName(values.applier);
  const maxCostUsd = positiveNumber('max-cost', values['max-cost'], false);
  const all = await readTriples(store);
  const triples = values.limit === undefined ? all : all.slice(0, positiveNumber('limit', values.limit, true));
  const model = applyModel(io, values.model, io.interrupts());
  const usesModel = (EDIT_FORMATS as readonly string[]).includes(name);
  if (usesModel && !Object.hasOwn(PRICES, model.name)) {
    throw new UsageError(`no price for ${model.name}, so --max-cost cannot be enforced; add it to PRICES`);
  }

  const modelName = usesModel ? model.name : null;
  let runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}${usesModel ? `-${model.name.replace(/[^\w.-]/g, '_')}` : ''}`;
  let out: string;
  let earlier: RunRecord[] = [];
  if (values.resume === undefined) {
    out = values.out === undefined ? path.join(store.evalsDir, 'apply-runs', `${runId}.jsonl`) : path.resolve(io.cwd, values.out);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, '');
  } else {
    out = path.resolve(io.cwd, values.resume);
    earlier = await readRun(out, name, modelName);
    runId = earlier[0]?.runId ?? runId;
  }
  const done = new Set<string>(earlier.map((record) => record.tripleId));

  io.out(`applier: ${name}`);
  io.out(`model: ${usesModel ? model.name : 'none'}`);
  io.out(`results: ${out}`);
  const results: ReplayResult[] = [...earlier];
  let spent = 0;
  let stopped = false;
  for (const [i, triple] of triples.entries()) {
    if (done.has(triple.id)) continue;
    if (spent >= maxCostUsd) {
      io.err(`budget: stopped at an estimated $${spent.toFixed(6)} before triple ${i + 1} of ${triples.length}, past --max-cost ${maxCostUsd}`);
      stopped = true;
      break;
    }
    const result = await replay(triple, appliersFor(triple, model)[name]);
    results.push(result);
    spent += result.attempt?.costUsd ?? 0;
    await appendFile(out, `${JSON.stringify({ runId, ...result })}\n`);
    io.out(progressLine(i + 1, triples.length, result));
  }

  const summary = summarize(results);
  printTable(io, [['all', summary.all], ...TRIPLE_SCOPES.map((scope) => [scope, summary.byScope[scope]] as [string, ReplayCounts])]);
  io.out(`first-try failures: ${reasonCounts(summary.firstTryFailures)}`);
  io.out(`final failures: ${reasonCounts(summary.finalFailures)}`);
  io.out(`usage: ${formatUsage(summary.usage, summary.costUsd)}`);
  return stopped ? 3 : 0;
};

type RunRecord = ReplayResult & { readonly runId: string };

const runRecordSchema = z.looseObject({
  runId: z.string().min(1),
  tripleId: z.string().min(1),
  applier: z.string(),
  attempt: z.looseObject({ model: z.string() }).nullable(),
});

// Only the fields that decide whether a resume is safe are checked; the rest is this command's own output.
async function readRun(file: string, applier: ApplierName, model: string | null): Promise<RunRecord[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) throw new EngineError(`no results file ${file} to resume`);
    throw error;
  }
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line, i) => {
      const parsed = runRecordSchema.safeParse(JSON.parse(line));
      if (!parsed.success) throw new EngineError(`${file}:${i + 1}: ${z.prettifyError(parsed.error)}`);
      const { applier: recorded, attempt } = parsed.data;
      if (recorded !== applier || (attempt !== null && attempt.model !== model)) {
        throw new UsageError(`${file} holds a ${recorded} run${attempt === null ? '' : ` on ${attempt.model}`}; resume it with the same --applier and --model`);
      }
      return parsed.data as unknown as RunRecord;
    });
}
