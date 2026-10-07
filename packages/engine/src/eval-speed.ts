import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { asTaskId, DEFAULT_EFFORT_POLICY, EFFORT_POLICIES, isEffortPolicyName, isPriced, isPromptTier, PROMPT_TIERS, SPEED_PARTS, speedReport, turnTimings, type EvalTask, type SpeedPart, type SpeedReport, type TaskTiming } from '@g-code/core';
import type { Spread } from '@g-code/core/tab';
import { chooseModel } from './chat.js';
import { UsageError, type Command, type Io } from './command.js';
import { positiveNumber } from './drive.js';
import { EngineError } from './errors.js';
import { ADAPTERS, runEval, type TaskResult } from './eval-run.js';
import { readSessionLog } from './sessions.js';
import { readTask } from './store.js';

/**
 * Five E5 tasks that passed there, chosen for few turns and low cost, so a run is cheap enough to repeat before and
 * after each speed change. Changing the list breaks comparison with earlier runs. The default caps leave room for all
 * five: the first run's estimate reached $0.12 before the fifth task, and a budget stop scores as a failure.
 */
export const SPEED_TASKS = [
  'payload-dayjs-bangkok',
  'next-about-translations',
  'next-counter-floor',
  'next-theme-typography',
  'next-demo-services-consolidate',
] as const;

/** E5's check, so turns and tool time compare with its baseline. */
const E5_CHECK = 'npx tsc --noEmit';

async function timingsOf(results: readonly TaskResult[]): Promise<TaskTiming[]> {
  const ran = results.filter((r) => r.transcript !== '');
  return Promise.all(
    ran.map(async (r) => ({ taskId: r.taskId, pass: r.pass, agentMs: r.agentMs, turns: turnTimings((await readSessionLog(r.transcript)).events) })),
  );
}

const seconds = (ms: number | null) => (ms === null ? '-' : `${(ms / 1000).toFixed(1)}s`);
const percent = (share: number | null) => (share === null ? '-' : `${(share * 100).toFixed(1)}%`);
const pair = ({ p50, p90 }: Spread, show: (v: number | null) => string) => `p50 ${show(p50)}, p90 ${show(p90)}`;
const whole = (v: number | null) => (v === null ? '-' : v.toFixed(0));

export function printSpeed(io: Io, report: SpeedReport): void {
  const share = (ms: number) => (report.agentMs === 0 ? null : ms / report.agentMs);
  const rows: string[][] = [
    ['part', 'p50/turn', 'p90/turn', 'total', 'of agent time'],
    ...(Object.keys(SPEED_PARTS) as SpeedPart[]).map((part) => {
      const { p50, p90, totalMs } = report.parts[part];
      return [part, seconds(p50), seconds(p90), seconds(totalMs), percent(share(totalMs))];
    }),
    ['outside turns', '', '', seconds(report.outsideTurnsMs), percent(share(report.outsideTurnsMs))],
    ['agent time', '', '', seconds(report.agentMs), percent(share(report.agentMs))],
  ];
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  io.out('');
  io.out(`speed: ${report.tasks} tasks, ${report.turns} turns, passed ${report.passed}/${report.tasks} (${percent(report.tasks === 0 ? null : report.passed / report.tasks)})`);
  for (const row of rows) io.out(row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]!) : cell.padStart(widths[i]!))).join('  '));
  io.out(`model + tools explain ${percent(report.explained)} of agent time`);
  io.out(`output tokens per turn: ${pair(report.outputTokens, whole)}; thinking tokens (estimated): ${pair(report.thinkingTokens, whole)}`);
  io.out(`output tokens per streamed second: ${pair(report.outputTokensPerSecond, (v) => (v === null ? '-' : v.toFixed(1)))}`);
}

async function readResults(file: string): Promise<TaskResult[]> {
  const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new EngineError(`no results file at ${file}`);
    throw error;
  });
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as TaskResult);
}

async function report(io: Io, results: readonly TaskResult[], out: string): Promise<void> {
  const tasks = await timingsOf(results);
  const speed = speedReport(tasks);
  await writeFile(out, `${JSON.stringify({ report: speed, tasks }, null, 2)}\n`);
  printSpeed(io, speed);
  io.out(`timings: ${out}`);
}

export const evalSpeedCommand: Command = async (args, ctx) => {
  const { io, store } = ctx;
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      model: { type: 'string', default: 'qwen3.8-flash' },
      'max-cost-per-task': { type: 'string', default: '0.08' },
      'max-cost': { type: 'string', default: '0.25' },
      'runs-dir': { type: 'string' },
      check: { type: 'string', default: E5_CHECK },
      from: { type: 'string' },
      'effort-policy': { type: 'string', default: DEFAULT_EFFORT_POLICY },
      'prompt-tier': { type: 'string' },
    },
  });
  if (values.from !== undefined) {
    const file = path.resolve(io.cwd, values.from);
    await report(io, await readResults(file), path.join(path.dirname(file), 'speed.json'));
    return 0;
  }
  const policy = values['effort-policy'];
  if (!isEffortPolicyName(policy)) throw new UsageError(`--effort-policy must be one of ${Object.keys(EFFORT_POLICIES).join(', ')}`);
  const tier = values['prompt-tier'];
  if (tier !== undefined && !isPromptTier(tier)) throw new UsageError(`--prompt-tier must be one of ${PROMPT_TIERS.join(', ')}`);
  if (!isPriced(chooseModel(io, { provider: undefined, model: values.model }).provider, values.model)) throw new UsageError(`no price for ${values.model}, so --max-cost cannot be enforced; add it to PRICES`);
  const tasks: EvalTask[] = [];
  for (const id of SPEED_TASKS) {
    const task = await readTask(store, asTaskId(id));
    if (task === undefined) throw new EngineError(`no task ${id} in ${store.tasksDir}; the speed eval needs the E5 tasks`);
    tasks.push(task);
  }
  io.out(`effort policy: ${policy}`);
  io.out(`prompt tier: ${tier ?? "the model's own"}`);
  const run = await runEval(ctx, {
    tasks,
    agent: 'gcode',
    adapter: ADAPTERS.gcode,
    model: values.model,
    maxCostPerTaskUsd: positiveNumber('max-cost-per-task', values['max-cost-per-task'], false),
    maxCostUsd: positiveNumber('max-cost', values['max-cost'], false),
    runsDir: values['runs-dir'] === undefined ? path.join(store.evalsDir, 'runs') : path.resolve(io.cwd, values['runs-dir']),
    check: values.check,
    checkAfterEdit: true,
    effortPolicy: EFFORT_POLICIES[policy],
    promptTier: tier,
  });
  await report(io, run.results, path.join(path.dirname(run.file), 'speed.json'));
  return run.stopped ? 3 : 0;
};
