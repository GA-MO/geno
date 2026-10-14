import { appendFile, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  asTaskId,
  isArenaSize,
  isPriced,
  variantLabel,
  type ArenaRun,
  type ArenaSize,
  type DoneReason,
  type EvalTask,
  type LaneEnd,
  capUsd,
} from '@g-code/core';
import { runAgent } from './agent.js';
import { arenaPreview, arenaVariants, REVIEW_LIMITS, startArena, type ArenaDeps } from './arena.js';
import { chooseModel, startSession } from './chat.js';
import { checkCacheDir } from './check-command.js';
import { childEnv } from './child-env.js';
import { UsageError, type Command, type Context, type Io } from './command.js';
import { positiveNumber } from './drive.js';
import { EngineError } from './errors.js';
import { cloneAt } from './git.js';
import { laneRepoOf, requireLane } from './lanes.js';
import { sharedSlots } from './model-slots.js';
import { runShell, tail } from './process.js';
import { readSessionLog } from './sessions.js';
import { homeOf, readTask, taskDir } from './store.js';
import { homesOf } from './commands.js';
import { NON_INTERACTIVE } from './tools/agent.js';

const LANE_ENDS: Readonly<Record<DoneReason, LaneEnd>> = { end_turn: 'done', 'max-turns': 'capped', budget: 'capped', refusal: 'failed', error: 'failed' };

/** The three tasks both agents failed in E5, then three that passed there, cheap ones. */
export const ARENA_EVAL_TASKS = ['next-base-path', 'payload-page-metadata-helper', 'payload-site-url-runtime', 'payload-dayjs-bangkok', 'next-about-translations', 'next-counter-floor'] as const;

const E5_CHECK = 'npx tsc --noEmit';
const SETUP_TIMEOUT_MS = 15 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

export type ArenaLaneResult = {
  readonly letter: string;
  readonly variant: string;
  readonly status: string;
  readonly check: string;
  readonly rank: number | null;
  readonly turns: number;
  readonly costUsd: number | null;
  readonly verified: boolean;
  readonly verifyTail: string;
  readonly retries: number;
};

export type ArenaTaskResult = {
  readonly taskId: string;
  readonly n: ArenaSize;
  readonly outcome: 'ran' | 'setup-failed' | 'budget';
  readonly status: string;
  readonly lanes: readonly ArenaLaneResult[];
  /** The share of lanes whose code passes the hidden check: the expected pass rate of one lane. */
  readonly pass1: number;
  /** Whether any lane's code passes it. */
  readonly passN: boolean;
  /** Whether the lane the review ranked first, or the only passing one, passes it: what the Arena hands the user. */
  readonly picked: boolean | null;
  readonly reviewCostUsd: number | null;
  readonly costUsd: number;
  readonly wallMs: number;
  readonly summary: string | null;
};

/** Retries a lane's session logged after a rate-limit answer. */
async function rateRetries(sessionFile: string): Promise<number> {
  const { events } = await readSessionLog(sessionFile).catch(() => ({ events: [] }));
  return events.filter((e) => e.kind === 'retry' && /429|rate.?limit|too many/i.test(e.message)).length;
}

async function runArenaTask(task: EvalTask, n: ArenaSize, laneCapUsd: number, maxTurns: number, check: string, ctx: Context, sessionFiles: Map<string, string>): Promise<ArenaTaskResult> {
  const { io, store } = ctx;
  const started = performance.now();
  const base = await mkdtemp(path.join(tmpdir(), `gcode-arena-${task.id}-`));
  const workspace = path.join(base, path.basename(task.repo));
  const empty = (outcome: ArenaTaskResult['outcome'], summary: string): ArenaTaskResult => ({
    taskId: task.id,
    n,
    outcome,
    status: outcome,
    lanes: [],
    pass1: 0,
    passN: false,
    picked: null,
    reviewCostUsd: null,
    costUsd: 0,
    wallMs: Math.round(performance.now() - started),
    summary,
  });
  try {
    await cloneAt(task.repo, workspace, task.baseCommit);
    const taskEnv = childEnv(io.env, { GCODE_TASK_DIR: taskDir(store, task.id) });
    const setup = await runShell(task.setup, { cwd: workspace, env: taskEnv, timeoutMs: SETUP_TIMEOUT_MS });
    if (setup.code !== 0) return empty('setup-failed', tail(setup.output));
    const repo = await laneRepoOf(await realpath(workspace));
    const quiet: Io = { ...io, cwd: repo.main, out: () => {}, write: () => {}, err: () => {} };
    const deps: ArenaDeps = {
      repo,
      store,
      io: quiet,
      check,
      onUpdate: (run) => io.out(`  ${task.id}: ${run.status} ${run.lanes.map((l) => `${l.letter}=${l.status}`).join(' ')}`),
      runLane: async (lane, variant, prompt) => {
        const opened = await startSession(store, { ...quiet, cwd: lane.path }, { workspace: lane.path, provider: undefined, model: variant.model ?? undefined, effort: variant.effort ?? undefined });
        sessionFiles.set(opened.log.session.id, opened.log.file);
        const ended = runAgent({ ...quiet, cwd: lane.path }, store, opened, prompt, {
          limits: { maxTurns, maxCostUsd: laneCapUsd },
          check,
          checkAfterEdit: true,
          approval: NON_INTERACTIVE,
        }).then((result) => LANE_ENDS[result.reason]);
        return { sessionId: opened.log.session.id, ended };
      },
    };
    const variants = await arenaVariants(homesOf(store, io.env), repo.main, n, undefined);
    const arena = await startArena(deps, task.prompt, variants, await arenaPreview(store, quiet, n));
    const run: ArenaRun = await arena.finished;
    const lanes = await Promise.all(
      run.lanes.map(async (lane): Promise<ArenaLaneResult> => {
        const record = await requireLane(repo, lane.lane);
        const verify = await runShell(task.verify, { cwd: record.path, env: taskEnv, timeoutMs: VERIFY_TIMEOUT_MS });
        await rm(checkCacheDir(homeOf(store), record.path), { recursive: true, force: true });
        return {
          letter: lane.letter,
          variant: variantLabel(lane.variant),
          status: lane.status,
          check: lane.check?.outcome ?? '-',
          rank: lane.rank,
          turns: lane.turns,
          costUsd: lane.costUsd,
          verified: verify.code === 0,
          verifyTail: tail(verify.output, 12, 1200),
          retries: await rateRetries(sessionFiles.get(lane.sessionId) ?? ''),
        };
      }),
    );
    const top = lanes.find((lane) => lane.rank === 1);
    const reviewCostUsd = run.review?.costUsd ?? null;
    return {
      taskId: task.id,
      n,
      outcome: 'ran',
      status: run.status,
      lanes,
      pass1: lanes.filter((lane) => lane.verified).length / lanes.length,
      passN: lanes.some((lane) => lane.verified),
      picked: top === undefined ? null : top.verified,
      reviewCostUsd,
      costUsd: lanes.reduce((sum, lane) => sum + (lane.costUsd ?? 0), 0) + (reviewCostUsd ?? 0),
      wallMs: Math.round(performance.now() - started),
      summary: run.summary,
    };
  } finally {
    await rm(checkCacheDir(homeOf(store), path.join(await realpath(base).catch(() => base), path.basename(task.repo))), { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
}

const money = (usd: number | null) => (usd === null ? '-' : `$${usd.toFixed(4)}`);

export function printArena(io: Io, results: readonly ArenaTaskResult[]): void {
  io.out('');
  io.out('| Task | Lanes (variant: check, hidden check) | pass@1 | pass@n | Review pick passes | Cost |');
  io.out('|---|---|---|---|---|---|');
  for (const r of results) {
    const lanes = r.lanes.map((l) => `${l.letter} ${l.variant}: ${l.check}${l.rank === null ? '' : ` #${l.rank}`}, ${l.verified ? 'pass' : 'fail'}`).join('; ');
    io.out(`| ${r.taskId} | ${lanes || r.outcome} | ${r.pass1.toFixed(2)} | ${r.passN ? 'yes' : 'no'} | ${r.picked === null ? '-' : r.picked ? 'yes' : 'no'} | ${money(r.costUsd)} |`);
  }
  const ran = results.filter((r) => r.outcome === 'ran');
  const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
  io.out(
    `pass@1 ${mean(ran.map((r) => r.pass1)).toFixed(2)}, pass@n ${ran.filter((r) => r.passN).length}/${ran.length}, review pick ${ran.filter((r) => r.picked === true).length}/${ran.length}, cost $${results
      .reduce((sum, r) => sum + r.costUsd, 0)
      .toFixed(4)}`,
  );
}

export const evalArenaCommand: Command = async (args, ctx) => {
  const { io, store } = ctx;
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      task: { type: 'string', multiple: true },
      n: { type: 'string', default: '3' },
      model: { type: 'string', default: 'qwen3.8-flash' },
      'max-cost': { type: 'string', default: '1.00' },
      'max-cost-per-lane': { type: 'string', default: '0.07' },
      'max-turns': { type: 'string', default: '30' },
      check: { type: 'string', default: E5_CHECK },
      'runs-dir': { type: 'string' },
    },
  });
  const n = Number(values.n);
  if (!isArenaSize(n)) throw new UsageError('--n must be 2, 3 or 4');
  const { provider } = chooseModel(io, { provider: undefined, model: values.model });
  if (!isPriced(provider, values.model)) throw new UsageError(`no price for ${values.model}, so --max-cost cannot be enforced; add it to PRICES`);
  const maxCost = positiveNumber('max-cost', values['max-cost'], false);
  const perLane = positiveNumber('max-cost-per-lane', values['max-cost-per-lane'], false);
  const maxTurns = positiveNumber('max-turns', values['max-turns'], true);
  const ids = values.task ?? [...ARENA_EVAL_TASKS];
  const tasks: EvalTask[] = [];
  for (const id of ids) {
    const task = await readTask(store, asTaskId(id));
    if (task === undefined) throw new EngineError(`no task ${id} in ${store.tasksDir}`);
    tasks.push(task);
  }
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-arena${n}-${values.model.replace(/[^\w.-]/g, '_')}`;
  const runDir = path.join(values['runs-dir'] === undefined ? path.join(store.evalsDir, 'runs') : path.resolve(io.cwd, values['runs-dir']), runId);
  const file = path.join(runDir, 'results.jsonl');
  await mkdir(runDir, { recursive: true });
  await writeFile(file, '');
  io.out(`arena: best-of-${n} on ${values.model}, ${tasks.length} tasks, at most $${perLane} a lane and $${maxCost} in all`);
  io.out(`results: ${file}`);
  // The review's session takes its model from here, as the lanes' do unless their variant names one.
  const env = { ...io.env, GCODE_MODEL: values.model };
  const taskCtx: Context = { io: { ...io, env }, store };
  const results: ArenaTaskResult[] = [];
  const sessionFiles = new Map<string, string>();
  let stopped = false;
  for (const [i, task] of tasks.entries()) {
    const spent = results.reduce((sum, r) => sum + r.costUsd, 0);
    // Each task may spend n lanes at their cap plus the review's; past what is left, the run stops.
    const cap = Math.min(perLane, (maxCost - spent - capUsd(REVIEW_LIMITS.maxCostUsd, provider, values.model)) / n);
    if (cap < 0.005) {
      io.err(`budget: stopped at an estimated $${spent.toFixed(4)} before task ${i + 1} of ${tasks.length}, past --max-cost ${maxCost}`);
      stopped = true;
      break;
    }
    io.out(`[${i + 1}/${tasks.length}] ${task.id}: ${n} lanes at most $${cap.toFixed(4)} each`);
    const result = await runArenaTask(task, n, cap, maxTurns, values.check, taskCtx, sessionFiles);
    results.push(result);
    await appendFile(file, `${JSON.stringify(result)}\n`);
    io.out(`[${i + 1}/${tasks.length}] ${task.id} ${result.status} pass@1=${result.pass1.toFixed(2)} pass@${n}=${result.passN} picked=${result.picked} ${money(result.costUsd)} ${(result.wallMs / 1000).toFixed(0)}s`);
  }
  printArena(io, results);
  const slots = sharedSlots(provider, env).stats();
  const retries = results.reduce((sum, r) => sum + r.lanes.reduce((s, l) => s + l.retries, 0), 0);
  io.out(`limiter: ${slots.size} slots, ${slots.calls} calls, peak ${slots.peak} at once, ${slots.waited} waited ${(slots.waitMs / 1000).toFixed(1)}s in all, ${slots.pauses} pauses; ${retries} rate-limit retries in lane logs`);
  await writeFile(path.join(runDir, 'limiter.json'), `${JSON.stringify({ slots, retries }, null, 2)}\n`);
  return stopped ? 3 : 0;
};
