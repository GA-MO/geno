import path from 'node:path';
import { parseArgs } from 'node:util';
import { asTaskId, DEFAULT_MINE_LIMITS, type EvalTask } from '@g-code/core';
import { agent } from './agent.js';
import { applyCommand, replayCommand } from './apply.js';
import { ask } from './ask.js';
import { chat, showRequest, showSession } from './chat.js';
import { checkTask, formatSeconds, type CheckReport } from './check-task.js';
import { classifierEvalCommand } from './classifier-eval.js';
import { childEnv } from './child-env.js';
import { commandsList } from './commands.js';
import { singleId, UsageError, type Command, type Io } from './command.js';
import { EngineError } from './errors.js';
import { evalArenaCommand } from './eval-arena.js';
import { evalRunCommand } from './eval-run.js';
import { evalSpeedCommand } from './eval-speed.js';
import { laneCommands } from './lane-cli.js';
import { mcpCommands } from './mcp/cli.js';
import { listSessionsCommand } from './history.js';
import { mine } from './mine.js';
import { providerCommands } from './providers.js';
import { rewind } from './rewind.js';
import { serve } from './daemon.js';
import { tabCommands } from './tab.js';
import { usage } from './usage.js';
import { openStore, readTask, readTasks, readTriples, taskDir, type Store } from './store.js';

export const USAGE = `usage:
  gcode agent [--session <id>] [--workspace <dir>] [--effort low|medium|high|xhigh|max] [--max-turns 40] [--max-cost 0.40] [--check "<cmd>"] [--no-check-after-edit] [--mode ask|auto | --non-interactive] [--mcp | --no-mcp] [--append-system-prompt "<text>"] <task...>
  gcode ask [--session <id>] [--workspace <dir>] [--max-turns 25] [--max-cost 0.40] <question...>
  gcode chat [--session <id>] [--model <slug>] [--effort low|medium|high|xhigh|max] <message...>
  gcode session show <session-id>
  gcode session request <session-id> <turn>
  gcode commands list [--workspace <dir>]
  gcode session list [--all]
  gcode rewind --session <id> --to <turn>
  gcode usage --session <id> [--json] [--baht-per-usd 33]
  gcode serve --stdio [--max-turns 40] [--max-cost 0.40]
  gcode serve --socket <path> [--idle-ms 10000] [--max-turns 40] [--max-cost 0.40]
  gcode lane new <name> [--from head|main] [--approve-setup] [--workspace <dir>]
  gcode lane list [--json] [--workspace <dir>]
  gcode lane apply <name> [--dry-run] [--workspace <dir>]
  gcode lane discard <name> [--discard-changes] [--workspace <dir>]
  gcode lane sweep [--workspace <dir>]
  gcode mcp list [--workspace <dir>]
  gcode mcp trust <name> [--workspace <dir>]
  gcode providers list
  gcode providers models <provider> [--json]
  gcode providers test <provider> [--model <id>] [--json]
  gcode eval list
  gcode eval mine --repo <path> [--limit 50] [--max-lines 40] [--no-slices]
  gcode eval replay <triple-id> [--applier <name>] [--model <id>]
  gcode eval apply [--applier <name>] [--model <id>] [--limit n] [--max-cost 0.50] [--out <file> | --resume <file>]
    appliers: noop, oracle, str_replace, apply_patch, whole_file
  gcode eval check-task <task-id>|--all [--verbose] [--keep]
  gcode eval run --agent gcode|claude-code (--task <id> | --all) [--model qwen3.8-flash] [--max-cost-per-task 0.40] [--max-cost 3] [--runs-dir <dir>] [--check "<cmd>"] [--no-check-after-edit]
  gcode eval speed [--model qwen3.8-flash] [--max-cost-per-task 0.08] [--max-cost 0.25] [--runs-dir <dir>] [--check "<cmd>"] [--effort-policy flat|stepped] [--prompt-tier principles|rules] [--agent-tool|--no-agent-tool] [--task <id>]... [--from <results.jsonl>]
  gcode eval arena [--task <id>]... [--n 3] [--model qwen3.8-flash] [--max-cost 1.00] [--max-cost-per-lane 0.07] [--max-turns 30] [--check "<cmd>"] [--runs-dir <dir>]
  gcode eval classifier [--dry-run] [--concurrency 4] [--max-cost 0.40]
  gcode tab report [--since <iso>]
  gcode tab replay [--history 6] [--limit 100] [--warmup 3] [--endpoint <url>] [--out <file>]`;

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
        env: childEnv(io.env),
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
  run: evalRunCommand,
  speed: evalSpeedCommand,
  arena: evalArenaCommand,
  classifier: classifierEvalCommand,
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
  agent,
  ask,
  chat,
  commands: group({ list: commandsList }),
  eval: group(evalCommands),
  lane: group(laneCommands),
  mcp: group(mcpCommands),
  providers: group(providerCommands),
  rewind,
  serve,
  session: group({ show: showSession, list: listSessionsCommand, request: showRequest }),
  tab: group(tabCommands),
  usage,
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
