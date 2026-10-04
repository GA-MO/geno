import path from 'node:path';
import { parseArgs } from 'node:util';
import { openStore, readTasks, readTriples, StoreError, type Store } from './store.js';

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

const evalCommands: Record<string, Command> = { list };

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
    if (error instanceof StoreError) {
      io.err(`error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

const isParseArgsError = (error: unknown): boolean =>
  typeof (error as { code?: unknown })?.code === 'string' &&
  (error as { code: string }).code.startsWith('ERR_PARSE_ARGS');
