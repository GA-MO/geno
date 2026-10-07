import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  endRun,
  hasOpenRun,
  missedRun,
  newTask,
  nextOccurrence,
  patchTask,
  planDue,
  RUN_END_KINDS,
  SCHEDULE_ID_PATTERN,
  SCHEDULE_LIMITS,
  scheduleIdOf,
  settled,
  withRuns,
  type RunEnd,
  type RunTrigger,
  type ScheduleAuthor,
  type ScheduleId,
  type ScheduleDraft,
  type ScheduledTask,
  type SchedulePanelAction,
  type SchedulePolicy,
  type SchedulesResponse,
  type SchedulesUpdate,
  type ScheduleView,
} from '@g-code/core';
import { EngineError } from './errors.js';
import { writeAtomically } from './memory.js';
import { isMissing, StoreError } from './store.js';

/** The engine is the timer, so tests give it a clock they move by hand. `setTimer` returns its own cancel. */
export type Clock = { now(): number; setTimer(run: () => void, ms: number): () => void };

export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  setTimer(run, ms) {
    // The timer is no reason for the process to live; the engine's idle exit decides that.
    const timer = setTimeout(run, ms).unref();
    return () => clearTimeout(timer);
  },
};

/**
 * Node's timers count the monotonic clock, which stands still while the Mac sleeps, so the engine looks again at least
 * this often and a run due during sleep starts within a minute of waking.
 */
export const LOOK_EVERY_MS = 60_000;

/** A refusal the editor or the model can act on: an unknown id, a run already going, too many tasks. */
export class ScheduleError extends EngineError {}

export type ScheduleStart = { readonly dueAt: number; readonly trigger: RunTrigger };

/** A run that started: its session, where that runs, and its end, read from its log once its turn is over. */
export type StartedRun = { readonly sessionId: string; readonly workspace: string; readonly lane: string | null; readonly ended: Promise<RunEnd> };

/** One editor connection's way to start a run as a background session of its own. */
export type ScheduleRunner = { readonly connection: object; start(workspace: string, task: ScheduledTask): Promise<StartedRun> };

export type SchedulerDeps = {
  readonly clock: Clock;
  readonly policy: SchedulePolicy;
  readonly zone: () => string;
  /** This engine's pid, which each run records, and whether another engine's still runs. */
  readonly pid: number;
  readonly alive: (pid: number) => boolean;
  readonly random: () => number;
};

const when = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('cron'), expr: z.string().min(1) }), z.strictObject({ kind: z.literal('at'), at: z.number() })]);
const trigger = z.enum(['schedule', 'catch-up', 'now']);
const runEnd = z.strictObject({ kind: z.enum(RUN_END_KINDS), at: z.number(), costUsd: z.number().nullable(), message: z.string().optional() });
const run = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('ran'),
    dueAt: z.number(),
    trigger,
    startedAt: z.number(),
    sessionId: z.string().min(1),
    workspace: z.string(),
    lane: z.string().nullable(),
    by: z.number().int(),
    end: runEnd.nullable(),
  }),
  z.strictObject({ kind: z.literal('missed'), at: z.number(), from: z.number(), to: z.number(), count: z.number().int().positive(), why: z.enum(['off', 'busy']) }),
  z.strictObject({ kind: z.literal('not-started'), dueAt: z.number(), trigger, at: z.number(), message: z.string() }),
]);
const task = z.strictObject({
  id: z.string().regex(SCHEDULE_ID_PATTERN).transform((id) => id as ScheduleId),
  title: z.string().min(1),
  prompt: z.string().min(1),
  when,
  edits: z.boolean(),
  budget: z.strictObject({ maxCostUsd: z.number().positive(), maxTurns: z.number().int().positive() }),
  paused: z.boolean(),
  createdAt: z.number(),
  createdBy: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('user') }), z.strictObject({ kind: z.literal('model'), sessionId: z.string() })]),
  since: z.number(),
  runs: z.array(run),
});
const fileSchema = z.strictObject({ version: z.literal(1), workspace: z.string(), tasks: z.array(task) });

/** `schedules/<hash>.json` under the app home, keyed by the workspace's main checkout, never in the repository. */
export const scheduleFile = (home: string, workspace: string): string => path.join(home, 'schedules', `${createHash('sha256').update(workspace).digest('hex').slice(0, 32)}.json`);

async function readTasks(file: string): Promise<ScheduledTask[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new StoreError(file, (error as Error).message);
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) throw new StoreError(file, z.prettifyError(parsed.error));
  return parsed.data.tasks as ScheduledTask[];
}

function found(tasks: readonly ScheduledTask[], id: string): number {
  const at = tasks.findIndex((t) => t.id === id);
  if (at !== -1) return at;
  throw new ScheduleError(tasks.length === 0 ? `no scheduled task ${id}; this workspace has none` : `no scheduled task ${id}; the tasks are ${tasks.map((t) => t.id).join(', ')}`);
}

const INTERRUPTED = 'Geno stopped before the run ended';

/**
 * Every workspace's scheduled tasks, for the engine process. It reads and writes each workspace's file one change at
 * a time, looks after every change and on a timer, and applies `planDue` to each task: a run starts through a
 * connected editor, a missed one is recorded. While no editor is connected nothing starts; the grace window then
 * decides, once one connects. The file is the truth, so tasks and their runs outlive the engine.
 */
export class Scheduler {
  private bound: { readonly home: string; readonly err: (line: string) => void } | undefined;
  private readonly runners = new Set<ScheduleRunner>();
  private readonly listeners = new Set<(update: SchedulesUpdate) => void>();
  private readonly workspaces = new Set<string>();
  private readonly timers = new Map<string, () => void>();
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: SchedulerDeps) {}

  /** The app home and the log of the first connection's engine; nothing runs before one connects. */
  bind(home: string, err: (line: string) => void): void {
    this.bound ??= { home, err };
  }

  watch(workspace: string): void {
    if (this.workspaces.has(workspace)) return;
    this.workspaces.add(workspace);
    this.soon(workspace);
  }

  connected(runner: ScheduleRunner): void {
    this.runners.add(runner);
    for (const workspace of this.workspaces) this.soon(workspace);
  }

  disconnected(connection: object): void {
    for (const runner of this.runners) if (runner.connection === connection) this.runners.delete(runner);
  }

  /** The scheduler's clock, which "in 1h" counts from. */
  now(): number {
    return this.deps.clock.now();
  }

  listen(listener: (update: SchedulesUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async list(workspace: string): Promise<SchedulesResponse> {
    this.watch(workspace);
    return { workspace, tasks: (await readTasks(this.file(workspace))).map((t) => this.view(t)) };
  }

  create(workspace: string, draft: ScheduleDraft, author: ScheduleAuthor): Promise<ScheduledTask> {
    this.watch(workspace);
    return this.edit(workspace, (tasks) => {
      if (tasks.length >= SCHEDULE_LIMITS.tasks) throw new ScheduleError(`this workspace has ${tasks.length} scheduled tasks, the most it keeps; delete one first`);
      const made = newTask(scheduleIdOf(this.deps.random, tasks), draft, author, this.deps.clock.now());
      return { tasks: [...tasks, made], result: made };
    });
  }

  /** Changes a task by `change`, applied to the task as the file holds it at that moment. */
  update(workspace: string, id: string, change: (task: ScheduledTask) => ScheduledTask): Promise<ScheduledTask> {
    return this.edit(workspace, (tasks) => {
      const at = found(tasks, id);
      const next = change(tasks[at]!);
      return { tasks: tasks.with(at, next), result: next };
    });
  }

  remove(workspace: string, id: string): Promise<ScheduledTask> {
    return this.edit(workspace, (tasks) => {
      const at = found(tasks, id);
      return { tasks: tasks.toSpliced(at, 1), result: tasks[at]! };
    });
  }

  /** The Tasks list's buttons. Run now leaves the schedule as it was; `runner` is the asking editor's. */
  async act(workspace: string, id: string, action: SchedulePanelAction, runner?: ScheduleRunner): Promise<SchedulesResponse> {
    const now = this.deps.clock.now();
    if (action === 'delete') await this.remove(workspace, id);
    else if (action === 'pause' || action === 'resume') await this.update(workspace, id, (t) => patchTask(t, { paused: action === 'pause' }, now));
    else
      await this.edit(workspace, async (tasks) => {
        const at = found(tasks, id);
        const task = tasks[at]!;
        if (hasOpenRun(task)) throw new ScheduleError(`${task.id} is running already`);
        const by = runner ?? this.runner();
        if (by === undefined) throw new ScheduleError('no editor is connected to run it');
        return { tasks: tasks.with(at, await this.start(workspace, by, task, { dueAt: now, trigger: 'now' })), result: undefined };
      });
    return this.list(workspace);
  }

  private runner(): ScheduleRunner | undefined {
    return [...this.runners][0];
  }

  private file(workspace: string): string {
    if (this.bound === undefined) throw new Error('the scheduler has no home yet');
    return scheduleFile(this.bound.home, workspace);
  }

  private view(task: ScheduledTask): ScheduleView {
    return { ...task, nextAt: task.paused ? null : nextOccurrence(task.when, task.since, this.deps.zone()) };
  }

  private serially<T>(workspace: string, work: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(workspace) ?? Promise.resolve()).then(work, work);
    this.chains.set(
      workspace,
      next.catch(() => {}),
    );
    return next;
  }

  /** One change to the workspace's file, after the ones before it; every editor hears the result, and the timer moves. */
  private edit<T>(workspace: string, change: (tasks: ScheduledTask[]) => { readonly tasks: ScheduledTask[]; readonly result: T } | Promise<{ readonly tasks: ScheduledTask[]; readonly result: T }>): Promise<T> {
    return this.serially(workspace, async () => {
      const file = this.file(workspace);
      const { tasks, result } = await change(await readTasks(file));
      await this.write(workspace, file, tasks);
      return result;
    }).finally(() => this.soon(workspace));
  }

  private async write(workspace: string, file: string, tasks: readonly ScheduledTask[]): Promise<void> {
    await writeAtomically(file, { version: 1, workspace, tasks });
    const update: SchedulesUpdate = { workspace, tasks: tasks.map((t) => this.view(t)) };
    for (const listener of this.listeners) listener(update);
  }

  /** Looks at the workspace's tasks once its pending changes are written. */
  soon(workspace: string): void {
    const bound = this.bound;
    if (bound === undefined) return;
    this.timers.get(workspace)?.();
    this.timers.delete(workspace);
    void this.serially(workspace, () => this.look(workspace)).catch((error: unknown) => bound.err(`schedules: could not look at ${workspace}: ${error instanceof Error ? error.message : String(error)}`));
  }

  private async look(workspace: string): Promise<void> {
    const { clock, policy, zone, pid, alive } = this.deps;
    const file = this.file(workspace);
    const now = clock.now();
    const before = await readTasks(file);
    const runner = this.runner();
    const tasks: ScheduledTask[] = [];
    for (const read of before) {
      // A run an engine that is gone left open never ends by itself.
      const left = read.runs.find((r) => r.kind === 'ran' && r.end === null && r.by !== pid && !alive(r.by));
      const task = left?.kind === 'ran' ? endRun(read, left.sessionId, { kind: 'failed', at: now, costUsd: null, message: INTERRUPTED }) : read;
      const plan = planDue(task, now, zone(), policy, hasOpenRun(task));
      if (plan.kind === 'miss') tasks.push(settled(task, plan.missed.to, missedRun(plan.missed, now)));
      else if (plan.kind === 'run' && runner !== undefined) {
        const due = settled(task, plan.dueAt, ...(plan.skipped === null ? [] : [missedRun(plan.skipped, now)]));
        tasks.push(await this.start(workspace, runner, due, { dueAt: plan.dueAt, trigger: plan.trigger }));
      } else tasks.push(task);
    }
    if (JSON.stringify(tasks) !== JSON.stringify(before)) await this.write(workspace, file, tasks);
    const waits = tasks.flatMap((t) => {
      const plan = planDue(t, now, zone(), policy, hasOpenRun(t));
      return plan.kind === 'wait' ? [plan.at] : [];
    });
    if (waits.length === 0) return;
    this.timers.set(workspace, clock.setTimer(() => this.soon(workspace), Math.min(Math.max(0, Math.min(...waits) - clock.now()), LOOK_EVERY_MS)));
  }

  /** Starts a run of `task` and records it; its end is recorded once its turn is over. A start that fails is recorded too. */
  private async start(workspace: string, runner: ScheduleRunner, task: ScheduledTask, start: ScheduleStart): Promise<ScheduledTask> {
    const at = this.deps.clock.now();
    try {
      const started = await runner.start(workspace, task);
      void started.ended
        .then((end) => this.update(workspace, task.id, (t) => endRun(t, started.sessionId, end)))
        .catch((error: unknown) => error instanceof ScheduleError || this.bound?.err(`schedules: could not record the end of ${task.id}'s run: ${error instanceof Error ? error.message : String(error)}`));
      return withRuns(task, { kind: 'ran', ...start, startedAt: at, sessionId: started.sessionId, workspace: started.workspace, lane: started.lane, by: this.deps.pid, end: null });
    } catch (error) {
      return withRuns(task, { kind: 'not-started', ...start, at, message: error instanceof Error ? error.message : String(error) });
    }
  }
}
