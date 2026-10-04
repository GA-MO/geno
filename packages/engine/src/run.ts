import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  appliersFor,
  asTaskId,
  asTripleId,
  DEFAULT_MINE_LIMITS,
  isApplierName,
  replay,
  summarize,
  type ApplierName,
  type EvalTask,
  type ReplayResult,
} from '@g-code/core';
import { ask } from './ask.js';
import { chat, showSession } from './chat.js';
import { checkTask, formatSeconds, type CheckReport } from './check-task.js';
import { singleId, UsageError, type Command, type Io } from './command.js';
import { EngineError } from './errors.js';
import { mine } from './mine.js';
import { tabCommands } from './tab.js';
import {
  openStore,
  readTask,
  readTasks,
  readTriple,
  readTriples,
  taskDir,
  type Store,
} from './store.js';

export const USAGE = `usage:
  gcode ask [--session <id>] [--workspace <dir>] [--max-turns 25] [--max-cost 0.40] <question...>
  gcode chat [--session <id>] [--model <slug>] [--effort low|medium|high|xhigh|max] <message...>
  gcode session show <session-id>
  gcode eval list
  gcode eval mine --repo <path> [--limit 50] [--max-lines 40] [--no-slices]
  gcode eval replay <triple-id> [--applier noop|oracle]
  gcode eval apply [--applier noop|oracle]
  gcode eval check-task <task-id>|--all [--verbose] [--keep]
  gcode tab report [--since <iso>]`;

const preview = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 60);

const list: Command = async (args, { io, store }) => {
  parseArgs({ args, options: {}, strict: true });
  const [tasks, triples] = await Promise.all([readTasks(store), readTriples(store)]);
  io.out(`store: ${store.evalsDir}`);
  for (const task of tasks) {
    io.out(`task    ${task.id}  ${path.basename(task.repo)}  ${preview(task.prompt)}`);
  }
  for (const triple of triples) {
    io.out(`triple  ${triple.id}  ${path.basename(triple.repo)}  ${preview(triple.instruction)}`);
  }
  if (tasks.length === 0 && triples.length === 0) io.out('the store is empty');
  io.out(`${tasks.length} tasks, ${triples.length} triples`);
  return 0;
};

function positiveInt(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new UsageError(`--${flag} must be a positive integer`);
  return value;
}

const mineCommand: Command = async (args, { io, store }) => {
  const { values } = parseArgs({
    args,
    strict: true,
    allowNegative: true,
    options: {
      slices: { type: 'boolean', default: true },
      repo: { type: 'string' },
      limit: { type: 'string', default: '50' },
      'max-lines': { type: 'string', default: String(DEFAULT_MINE_LIMITS.maxChangedLines) },
    },
  });
  if (values.repo === undefined) throw new UsageError('--repo is required');
  const report = await mine(store, path.resolve(io.cwd, values.repo), {
    limit: positiveInt('limit', values.limit),
    limits: { ...DEFAULT_MINE_LIMITS, maxChangedLines: positiveInt('max-lines', values['max-lines']) },
    slices: values.slices,
  });
  const skippedTotal = [...report.skipped.values()].reduce((sum, n) => sum + n, 0);
  io.out(`repo: ${report.repo}`);
  io.out(`store: ${store.triplesDir}`);
  io.out(`scanned ${report.scanned} commits, kept ${report.kept.length}, skipped ${skippedTotal}`);
  for (const [reason, count] of [...report.skipped].sort((a, b) => b[1] - a[1])) {
    io.out(`  skipped ${reason}: ${count}`);
  }
  for (const id of report.kept) io.out(`  kept ${id}`);
  return 0;
};

const applierOption = { applier: { type: 'string', default: 'noop' } } as const;

function applierName(raw: string): ApplierName {
  if (!isApplierName(raw)) throw new UsageError(`unknown applier: ${raw}`);
  return raw;
}

function describeOutcome(result: ReplayResult): string {
  const { outcome } = result;
  return outcome.kind === 'applied' ? 'applied' : `failed (${outcome.reason}): ${outcome.detail}`;
}

const replayCommand: Command = async (args, { io, store }) => {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: applierOption,
  });
  const rawId = singleId(positionals, 'triple');
  const name = applierName(values.applier);
  const triple = await readTriple(store, asTripleId(rawId));
  if (triple === undefined) throw new EngineError(`no triple ${rawId} in ${store.triplesDir}`);

  const result = await replay(triple, appliersFor(triple)[name]);
  io.out(`triple: ${result.tripleId}`);
  io.out(`applier: ${result.applier}`);
  io.out(`outcome: ${describeOutcome(result)}`);
  io.out(`exact match: ${result.exactMatch ? 'yes' : 'no'}`);
  if (result.diff !== '') io.out(result.diff.trimEnd());
  return result.exactMatch ? 0 : 1;
};

const percent = (rate: number) => `${(rate * 100).toFixed(1)}%`;

const applyCommand: Command = async (args, { io, store }) => {
  const { values } = parseArgs({ args, strict: true, options: applierOption });
  const name = applierName(values.applier);
  const results: ReplayResult[] = [];
  for (const triple of await readTriples(store)) {
    results.push(await replay(triple, appliersFor(triple)[name]));
  }
  const summary = summarize(results);
  io.out(`applier: ${name}`);
  io.out(`triples: ${summary.total}`);
  io.out(`exact match: ${summary.exact}/${summary.total} (${percent(summary.exactRate)})`);
  io.out(`failed: ${summary.failed}/${summary.total} (${percent(summary.failureRate)})`);
  return 0;
};

const checkTaskCommand: Command = async (args, { io, store }) => {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    options: {
      all: { type: 'boolean', default: false },
      verbose: { type: 'boolean', default: false },
      keep: { type: 'boolean', default: false },
    },
  });
  if (values.all && positionals.length > 0) throw new UsageError('pass a task id or --all, not both');
  const tasks = values.all ? await readTasks(store) : [await requireTask(store, singleId(positionals, 'task'))];

  const reports: [EvalTask, CheckReport][] = [];
  for (const task of tasks) {
    reports.push([
      task,
      await checkTask(task, {
        taskDir: taskDir(store, task.id),
        env: io.env,
        verbose: values.verbose,
        keep: values.keep,
        log: io.out,
      }),
    ]);
  }
  if (values.all) printSummary(io, reports);
  return reports.every(([, report]) => report.verdict.valid) ? 0 : 1;
};

async function requireTask(store: Store, rawId: string): Promise<EvalTask> {
  const task = await readTask(store, asTaskId(rawId));
  if (task === undefined) throw new EngineError(`no task ${rawId} in ${store.tasksDir}`);
  return task;
}

function printSummary(io: Io, reports: readonly [EvalTask, CheckReport][]): void {
  const width = Math.max(4, ...reports.map(([task]) => task.id.length));
  io.out('');
  io.out(`${'task'.padEnd(width)}  ${'time'.padStart(8)}  verdict`);
  for (const [task, { verdict, ms }] of reports) {
    const text = verdict.valid ? 'valid' : `invalid: ${verdict.reason}`;
    io.out(`${task.id.padEnd(width)}  ${formatSeconds(ms).padStart(8)}  ${text}`);
  }
  const valid = reports.filter(([, report]) => report.verdict.valid).length;
  io.out(`${valid}/${reports.length} tasks valid`);
}

const evalCommands: Record<string, Command> = {
  list,
  mine: mineCommand,
  replay: replayCommand,
  apply: applyCommand,
  'check-task': checkTaskCommand,
};

const group =
  (commands: Record<string, Command>): Command =>
  async ([name, ...rest], ctx) => {
    if (name === undefined || !Object.hasOwn(commands, name)) {
      throw new UsageError(name === undefined ? 'missing command' : `unknown command: ${name}`);
    }
    return commands[name]!(rest, ctx);
  };

const commands: Record<string, Command> = {
  ask,
  chat,
  eval: group(evalCommands),
  session: group({ show: showSession }),
  tab: group(tabCommands),
};

export async function run(argv: string[], io: Io): Promise<number> {
  const [name, ...rest] = argv;
  const command = name !== undefined && Object.hasOwn(commands, name) ? commands[name] : undefined;
  if (command === undefined) {
    io.err(USAGE);
    return 2;
  }
  try {
    return await command(rest, { io, store: openStore(io.env) });
  } catch (error) {
    if (error instanceof UsageError || isParseArgsError(error)) {
      io.err((error as Error).message);
      io.err(USAGE);
      return 2;
    }
    if (error instanceof EngineError) {
      io.err(`error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

const isParseArgsError = (error: unknown): boolean =>
  typeof (error as { code?: unknown })?.code === 'string' &&
  (error as { code: string }).code.startsWith('ERR_PARSE_ARGS');
