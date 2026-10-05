import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { addUsage, asTaskId, isPriced, ZERO_USAGE, type EffortPolicy, type EvalTask, type TokenUsage } from '@g-code/core';
import { chooseModel, formatCost } from './chat.js';
import { checkCacheDir } from './check-command.js';
import { childEnv } from './child-env.js';
import { UsageError, type Command, type Context, type Io } from './command.js';
import { positiveNumber } from './drive.js';
import { EngineError } from './errors.js';
import { cloneAt } from './git.js';
import { claudeCodeAdapter } from './eval-claude.js';
import { gcodeAdapter } from './eval-gcode.js';
import { runShell, tail } from './process.js';
import { homeOf, readTask, readTasks, taskDir } from './store.js';

export const AGENT_NAMES = ['gcode', 'claude-code'] as const;
export type AgentName = (typeof AGENT_NAMES)[number];
const isAgentName = (raw: string): raw is AgentName => (AGENT_NAMES as readonly string[]).includes(raw);

export type AgentRunInput = {
  readonly task: EvalTask;
  /** The clone at the task's base commit, already set up. */
  readonly workspace: string;
  /** Scratch space the agent may write; deleted after the task. */
  readonly tempDir: string;
  readonly runDir: string;
  readonly model: string;
  readonly maxCostUsd: number;
  readonly check: string | undefined;
  readonly checkAfterEdit: boolean;
  /** Undefined runs the agent's default; an adapter for another agent ignores it. */
  readonly effortPolicy?: EffortPolicy | undefined;
};

export type AgentRunResult = {
  /** Why the agent stopped, in its own words: end_turn, max-turns, budget, error, timeout. */
  readonly stop: string;
  readonly turns: number;
  readonly usage: TokenUsage;
  /** Recomputed from our price table. */
  readonly costUsd: number | null;
  /** What the agent itself reported, when it reports a cost. */
  readonly reportedCostUsd: number | null;
  readonly denials: number;
  readonly finalMessage: string;
  /** The session log or output file to read for the agent's turns. */
  readonly transcript: string;
};

export type AgentAdapter = { run(input: AgentRunInput, ctx: Context): Promise<AgentRunResult> };

export const ADAPTERS: Readonly<Record<AgentName, AgentAdapter>> = {
  gcode: gcodeAdapter,
  'claude-code': claudeCodeAdapter,
};

export const OUTCOMES = ['pass', 'fail', 'setup-failed', 'clone-failed'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export type TaskResult = {
  readonly runId: string;
  readonly agent: AgentName;
  readonly model: string;
  readonly taskId: string;
  readonly outcome: Outcome;
  readonly pass: boolean;
  /** Setup, agent and verify together. */
  readonly wallMs: number;
  readonly agentMs: number;
  readonly verifyTail: string;
} & AgentRunResult;

const NOT_RUN: AgentRunResult = {
  stop: 'not-run',
  turns: 0,
  usage: ZERO_USAGE,
  costUsd: 0,
  reportedCostUsd: null,
  denials: 0,
  finalMessage: '',
  transcript: '',
};

const SETUP_TIMEOUT_MS = 15 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

export type EvalRunOptions = {
  readonly tasks: readonly EvalTask[];
  readonly agent: AgentName;
  readonly adapter: AgentAdapter;
  readonly model: string;
  readonly maxCostPerTaskUsd: number;
  readonly maxCostUsd: number;
  readonly runsDir: string;
  readonly check: string | undefined;
  readonly checkAfterEdit: boolean;
  readonly effortPolicy?: EffortPolicy | undefined;
};

export type EvalRun = { readonly file: string; readonly results: readonly TaskResult[]; readonly stopped: boolean };

async function runTask(task: EvalTask, options: EvalRunOptions, runId: string, runDir: string, budget: number, ctx: Context): Promise<TaskResult> {
  const { io, store } = ctx;
  const started = performance.now();
  const base = await mkdtemp(path.join(tmpdir(), `gcode-eval-${task.id}-`));
  const workspace = path.join(base, path.basename(task.repo));
  const tempDir = path.join(base, 'tmp');
  const record = (outcome: Outcome, agentRun: AgentRunResult, agentMs: number, verifyTail: string): TaskResult => ({
    runId,
    agent: options.agent,
    model: options.model,
    taskId: task.id,
    outcome,
    pass: outcome === 'pass',
    wallMs: Math.round(performance.now() - started),
    agentMs: Math.round(agentMs),
    verifyTail,
    ...agentRun,
  });
  try {
    await mkdir(tempDir);
    try {
      await cloneAt(task.repo, workspace, task.baseCommit);
    } catch (error) {
      if (error instanceof EngineError) return record('clone-failed', NOT_RUN, 0, error.message);
      throw error;
    }
    const taskEnv = childEnv(io.env, { GCODE_TASK_DIR: taskDir(store, task.id) });
    const setup = await runShell(task.setup, { cwd: workspace, env: taskEnv, timeoutMs: SETUP_TIMEOUT_MS });
    if (setup.code !== 0) return record('setup-failed', NOT_RUN, 0, tail(setup.output));

    const agentStarted = performance.now();
    const agentRun = await options.adapter.run(
      { task, workspace, tempDir, runDir, model: options.model, maxCostUsd: budget, check: options.check, checkAfterEdit: options.checkAfterEdit, effortPolicy: options.effortPolicy },
      ctx,
    );
    const agentMs = performance.now() - agentStarted;

    const verify = await runShell(task.verify, {
      cwd: workspace,
      env: taskEnv,
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
    return record(verify.code === 0 ? 'pass' : 'fail', agentRun, agentMs, tail(verify.output, 20, 2000));
  } finally {
    await rm(checkCacheDir(homeOf(store), path.join(await realpath(base), path.basename(task.repo))), { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
const tokens = (u: TokenUsage) => `${u.input}/${u.cacheRead}/${u.cacheWrite}/${u.output}`;

const COLUMNS: readonly [heading: string, cell: (r: TaskResult) => string][] = [
  ['task', (r) => r.taskId],
  ['outcome', (r) => r.outcome],
  ['stop', (r) => r.stop],
  ['turns', (r) => String(r.turns)],
  ['tokens in/cr/cw/out', (r) => tokens(r.usage)],
  ['cost', (r) => formatCost(r.costUsd).replace('cost=', '')],
  ['agent time', (r) => seconds(r.agentMs)],
  ['denials', (r) => String(r.denials)],
];


export const spentOf = (results: readonly TaskResult[]): number => results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);

export function printSummary(io: Io, results: readonly TaskResult[]): void {
  const cells = [COLUMNS.map(([heading]) => heading), ...results.map((r) => COLUMNS.map(([, cell]) => cell(r)))];
  const widths = cells[0]!.map((_, i) => Math.max(...cells.map((row) => row[i]!.length)));
  io.out('');
  for (const row of cells) io.out(row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd());
  const passed = results.filter((r) => r.pass).length;
  const usage = results.reduce((sum, r) => addUsage(sum, r.usage), ZERO_USAGE);
  const rate = results.length === 0 ? '0.0' : ((passed / results.length) * 100).toFixed(1);
  io.out(`passed ${passed}/${results.length} (${rate}%)`);
  io.out(
    `total: turns=${results.reduce((n, r) => n + r.turns, 0)} tokens=${tokens(usage)} cost=$${spentOf(results).toFixed(4)} agent time=${seconds(
      results.reduce((n, r) => n + r.agentMs, 0),
    )} denials=${results.reduce((n, r) => n + r.denials, 0)}`,
  );
}

export async function runEval(ctx: Context, options: EvalRunOptions): Promise<EvalRun> {
  const { io } = ctx;
  // One interrupt listener for the whole run; each task asking for its own would pile up SIGINT handlers.
  const interrupt = io.interrupts();
  const taskCtx: Context = { ...ctx, io: { ...io, interrupts: () => interrupt } };
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${options.agent}-${options.model.replace(/[^\w.-]/g, '_')}`;
  const runDir = path.join(options.runsDir, runId);
  const file = path.join(runDir, 'results.jsonl');
  await mkdir(runDir, { recursive: true });
  await writeFile(file, '');
  io.out(`agent: ${options.agent}  model: ${options.model}`);
  io.out(`results: ${file}`);

  const results: TaskResult[] = [];
  let stopped = false;
  for (const [i, task] of options.tasks.entries()) {
    const left = options.maxCostUsd - spentOf(results);
    if (left <= 0) {
      io.err(`budget: stopped at an estimated $${spentOf(results).toFixed(4)} before task ${i + 1} of ${options.tasks.length}, past --max-cost ${options.maxCostUsd}`);
      stopped = true;
      break;
    }
    const result = await runTask(task, options, runId, runDir, Math.min(options.maxCostPerTaskUsd, left), taskCtx);
    results.push(result);
    await appendFile(file, `${JSON.stringify(result)}\n`);
    io.out(`[${i + 1}/${options.tasks.length}] ${task.id} ${result.outcome} turns=${result.turns} ${formatCost(result.costUsd)} ${seconds(result.wallMs)}`);
  }
  printSummary(io, results);
  return { file, results, stopped };
}

export const evalRunCommand: Command = async (args, ctx) => {
  const { io, store } = ctx;
  const { values } = parseArgs({
    args,
    strict: true,
    allowNegative: true,
    options: {
      agent: { type: 'string' },
      task: { type: 'string' },
      all: { type: 'boolean', default: false },
      model: { type: 'string', default: 'qwen3.8-flash' },
      'max-cost-per-task': { type: 'string', default: '0.40' },
      'max-cost': { type: 'string', default: '3' },
      'runs-dir': { type: 'string' },
      check: { type: 'string' },
      'check-after-edit': { type: 'boolean', default: true },
    },
  });
  if (values.agent === undefined || !isAgentName(values.agent)) throw new UsageError(`--agent must be one of ${AGENT_NAMES.join(', ')}`);
  if (values.all === (values.task !== undefined)) throw new UsageError('pass --task <id> or --all');
  if (!isPriced(chooseModel(io, { provider: undefined, model: values.model }).provider, values.model)) throw new UsageError(`no price for ${values.model}, so --max-cost cannot be enforced; add it to PRICES`);
  let tasks: EvalTask[];
  if (values.all) tasks = await readTasks(store);
  else {
    const task = await readTask(store, asTaskId(values.task!));
    if (task === undefined) throw new EngineError(`no task ${values.task} in ${store.tasksDir}`);
    tasks = [task];
  }
  const run = await runEval(ctx, {
    tasks,
    agent: values.agent,
    adapter: ADAPTERS[values.agent],
    model: values.model,
    maxCostPerTaskUsd: positiveNumber('max-cost-per-task', values['max-cost-per-task'], false),
    maxCostUsd: positiveNumber('max-cost', values['max-cost'], false),
    runsDir: values['runs-dir'] === undefined ? path.join(store.evalsDir, 'runs') : path.resolve(io.cwd, values['runs-dir']),
    check: values.check,
    checkAfterEdit: values['check-after-edit'],
  });
  return run.stopped ? 3 : 0;
};
