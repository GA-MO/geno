import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_MINE_LIMITS } from '@g-code/core';
import { EngineError } from './errors.js';
import { mine } from './mine.js';
import { openStore, readTasks, readTriples, type Store } from './store.js';

export type Io = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  out(line: string): void;
  err(line: string): void;
};

type Context = { readonly io: Io; readonly store: Store };
type Command = (args: string[], ctx: Context) => Promise<number>;

export class UsageError extends Error {}

export const USAGE = `usage:
  gcode eval list
  gcode eval mine --repo <path> [--limit 50] [--max-lines 40]
  gcode eval replay <triple-id> [--applier noop|oracle]
  gcode eval apply [--applier noop|oracle]`;

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
    options: {
      repo: { type: 'string' },
      limit: { type: 'string', default: '50' },
      'max-lines': { type: 'string', default: String(DEFAULT_MINE_LIMITS.maxChangedLines) },
    },
  });
  if (values.repo === undefined) throw new UsageError('--repo is required');
  const report = await mine(store, path.resolve(io.cwd, values.repo), positiveInt('limit', values.limit), {
    ...DEFAULT_MINE_LIMITS,
    maxChangedLines: positiveInt('max-lines', values['max-lines']),
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

const evalCommands: Record<string, Command> = { list, mine: mineCommand };

export async function run(argv: string[], io: Io): Promise<number> {
  const [group, name, ...rest] = argv;
  const command =
    group === 'eval' && name !== undefined && Object.hasOwn(evalCommands, name)
      ? evalCommands[name]
      : undefined;
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
