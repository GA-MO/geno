import {
  MONITOR_LINE_CHARS,
  nextPrWatch,
  nextWakeId,
  prPollDelayS,
  prWatchOutcomeOf,
  showHidden,
  stripHidden,
  type JobId,
  type PrLookup,
  type PrWatch,
  type PrWatchEnd,
  type TurnEvent,
  type WakeArrival,
  type WakeId,
  type WakeNote,
  type WakeSource,
  type WakeTrigger,
} from '@g-code/core';
import type { BackgroundJobs } from './background.js';

/** A background child that still owes its parent's session a report. `silence` cancels it with no report. */
type ChildWait = { readonly agent: string; readonly toolUseId: string; readonly silence: () => void };

type MonitorWait = {
  readonly job: JobId;
  readonly pattern: string;
  readonly toolUseId: string;
  /** The monitor started the command itself, so cancelling the monitor stops the command too. */
  readonly ownsJob: boolean;
  end(): void;
};

type PrWait = { readonly pr: number; readonly toolUseId: string; end(): void };

type ScheduleWait = { readonly dueAt: number; readonly reason: string; readonly toolUseId: string; readonly timer: ReturnType<typeof setTimeout> };

type SessionWaits = {
  readonly children: Map<string, ChildWait>;
  readonly monitors: Map<WakeId, MonitorWait>;
  readonly schedules: Map<WakeId, ScheduleWait>;
  readonly prs: Map<WakeId, PrWait>;
  /** Commands that run on but no longer wake the session, after the user cancelled its wakes. */
  readonly quiet: Set<JobId>;
};

export type WakeHooks = {
  /** A monitor or a wake-up reported; it goes to the session's inbox. */
  arrive(sessionId: string, arrival: WakeArrival): void;
  /** What the session waits on changed. */
  changed(sessionId: string): void;
};

/**
 * A pull request watch: `look` reads the PR and its checks once, and `report` writes what the model reads when the
 * watch ends, failing logs and all. Delays and the timeout are in seconds of `secondMs`.
 */
export type PrWatchStart = {
  readonly id: WakeId;
  readonly toolUseId: string;
  readonly watch: Extract<PrWatch, { kind: 'watching' }>;
  readonly timeoutS: number;
  readonly secondMs: number;
  look(signal: AbortSignal): Promise<PrLookup>;
  report(end: PrWatchEnd, signal: AbortSignal): Promise<string>;
};

export type MonitorStart = { readonly id: WakeId; readonly job: JobId; readonly pattern: RegExp; readonly toolUseId: string; readonly timeoutMs: number; readonly ownsJob: boolean };

/** Whether a line of output matches, and the line as a note keeps it. */
function matchIn(text: string, pattern: RegExp): string | undefined {
  const line = text.split('\n').find((candidate) => pattern.test(candidate));
  return line === undefined ? undefined : line.slice(0, MONITOR_LINE_CHARS);
}

/**
 * What every session of the engine process waits on to be woken: its background children, monitors and wake-up
 * timers, and the commands the user silenced. Running commands themselves are `BackgroundJobs`'.
 */
export class Wakes {
  private readonly sessions = new Map<string, SessionWaits>();

  constructor(
    private readonly jobs: BackgroundJobs,
    private readonly hooks: WakeHooks,
  ) {}

  private of(sessionId: string): SessionWaits {
    let waits = this.sessions.get(sessionId);
    if (waits === undefined) {
      waits = { children: new Map(), monitors: new Map(), schedules: new Map(), prs: new Map(), quiet: new Set() };
      this.sessions.set(sessionId, waits);
    }
    return waits;
  }

  /**
   * A background child started; the returned function marks its report made. A resumed child waits again under its
   * id, so a report of its earlier run that comes late leaves the newer wait in place.
   */
  child(sessionId: string, childId: string, wait: ChildWait): () => void {
    this.of(sessionId).children.set(childId, wait);
    this.hooks.changed(sessionId);
    return () => {
      const children = this.sessions.get(sessionId)?.children;
      if (children?.get(childId) !== wait) return;
      children.delete(childId);
      this.hooks.changed(sessionId);
    };
  }

  /**
   * Watches a running job's output from now on. A line it already printed that matches, or a job that already ended,
   * sets nothing up: the caller tells the model at once.
   */
  monitor(sessionId: string, start: MonitorStart): { readonly kind: 'watching' } | { readonly kind: 'matched'; readonly line: string } | { readonly kind: 'ended' } {
    const waits = this.of(sessionId);
    let partial = '';
    let done = false;
    const watching = this.jobs.watch(sessionId, start.job, (chunk) => {
      const text = partial + chunk;
      const cut = text.lastIndexOf('\n');
      partial = cut === -1 ? text : text.slice(cut + 1);
      const line = cut === -1 ? undefined : matchIn(text.slice(0, cut), start.pattern);
      if (line !== undefined) finish({ outcome: 'matched', line });
    });
    const already = matchIn(watching.kept, start.pattern);
    if (already !== undefined || watching.job.state.status !== 'running') {
      watching.stop();
      return already === undefined ? { kind: 'ended' } : { kind: 'matched', line: already };
    }
    const timer = setTimeout(() => finish({ outcome: 'timed-out' }), start.timeoutMs);
    const end = () => {
      if (done) return false;
      done = true;
      clearTimeout(timer);
      watching.stop();
      waits.monitors.delete(start.id);
      return true;
    };
    const finish = (result: { readonly outcome: 'matched'; readonly line: string } | { readonly outcome: 'timed-out' }) => {
      if (!end()) return;
      const seen = result.outcome === 'matched' ? { ...result, line: showHidden(result.line) } : result;
      const note: WakeNote = { kind: 'monitor', id: start.id, toolUseId: start.toolUseId, job: start.job, pattern: start.pattern.source, ...seen };
      this.hooks.arrive(sessionId, { kind: 'wake', at: new Date().toISOString(), note });
      this.hooks.changed(sessionId);
    };
    // A command that ends first reports its own end, which wakes the session; the monitor has nothing to add.
    void watching.ended.then(() => {
      if (end()) this.hooks.changed(sessionId);
    });
    waits.monitors.set(start.id, { job: start.job, pattern: start.pattern.source, toolUseId: start.toolUseId, ownsJob: start.ownsJob, end });
    this.hooks.changed(sessionId);
    return { kind: 'watching' };
  }

  /** The watch of a PR the session already runs, so a second watch_pr of it starts nothing. */
  prWatchOf(sessionId: string, pr: number): WakeId | undefined {
    return [...(this.sessions.get(sessionId)?.prs ?? [])].find(([, wait]) => wait.pr === pr)?.[0];
  }

  /** Polls a PR's checks until they settle, the watch ends otherwise, or it is cancelled, then reports once. */
  pr(sessionId: string, start: PrWatchStart): void {
    const waits = this.of(sessionId);
    const controller = new AbortController();
    const startedAt = Date.now();
    const deadline = startedAt + start.timeoutS * start.secondMs;
    let watch = start.watch;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const end = () => {
      if (controller.signal.aborted) return false;
      controller.abort();
      clearTimeout(timer);
      waits.prs.delete(start.id);
      return true;
    };
    const arm = () => {
      const delay = prPollDelayS((Date.now() - startedAt) / start.secondMs) * start.secondMs;
      timer = setTimeout(() => void poll(), Math.max(0, Math.min(delay, deadline - Date.now())));
    };
    const poll = async () => {
      const lookup = await start.look(controller.signal).catch((error: unknown): PrLookup => ({ kind: 'failed', message: String(error) }));
      if (controller.signal.aborted) return;
      const next = nextPrWatch(watch, lookup, Date.now() >= deadline);
      if (next.kind === 'watching') {
        watch = next;
        arm();
        return;
      }
      const text = await start.report(next.end, controller.signal).catch((error: unknown) => `The watch ended, and its report failed: ${String(error)}`);
      if (!end()) return;
      const note: WakeNote = { kind: 'pr', id: start.id, toolUseId: start.toolUseId, pr: watch.pr.number, outcome: prWatchOutcomeOf(next.end), text: stripHidden(text) };
      this.hooks.arrive(sessionId, { kind: 'wake', at: new Date().toISOString(), note });
      this.hooks.changed(sessionId);
    };
    waits.prs.set(start.id, { pr: watch.pr.number, toolUseId: start.toolUseId, end });
    arm();
    this.hooks.changed(sessionId);
  }

  /** Arms a wake-up, once per id: a record logged again after a restart replaces the timer it had. */
  schedule(sessionId: string, note: Extract<WakeNote, { kind: 'scheduled' }>): void {
    const waits = this.of(sessionId);
    clearTimeout(waits.schedules.get(note.id)?.timer);
    const timer = setTimeout(
      () => {
        if (waits.schedules.get(note.id)?.timer !== timer) return;
        waits.schedules.delete(note.id);
        this.hooks.arrive(sessionId, { kind: 'wake', at: new Date().toISOString(), note: { kind: 'due', id: note.id, toolUseId: note.toolUseId, reason: note.reason } });
        this.hooks.changed(sessionId);
      },
      Math.max(0, note.dueAt - Date.now()),
    );
    waits.schedules.set(note.id, { dueAt: note.dueAt, reason: note.reason, toolUseId: note.toolUseId, timer });
    this.hooks.changed(sessionId);
  }

  /** The session's next wake id, past every one its log used and every monitor or wake-up it has now. */
  nextId(sessionId: string, events: readonly TurnEvent[]): WakeId {
    const waits = this.sessions.get(sessionId);
    return nextWakeId(events, waits === undefined ? [] : [...waits.monitors.keys(), ...waits.schedules.keys(), ...waits.prs.keys()]);
  }

  /** What the session waits on, oldest kind first, as the Tasks list names it. */
  waitsFor(sessionId: string): WakeSource[] {
    const waits = this.sessions.get(sessionId);
    const running = this.jobs.running(sessionId).filter((job) => job.preview === undefined && waits?.quiet.has(job.id as JobId) !== true);
    return [
      ...[...(waits?.children ?? [])].map(([child, wait]): WakeSource => ({ kind: 'children', child, agent: wait.agent })),
      ...running.map((job): WakeSource => ({ kind: 'jobs', job: job.id as JobId })),
      ...[...(waits?.monitors ?? [])].map(([id, wait]): WakeSource => ({ kind: 'monitor', id, job: wait.job, pattern: wait.pattern })),
      ...[...(waits?.schedules ?? [])].map(([id, wait]): WakeSource => ({ kind: 'schedule', id, dueAt: wait.dueAt })),
      ...[...(waits?.prs ?? [])].map(([id, wait]): WakeSource => ({ kind: 'pr', id, pr: wait.pr })),
    ];
  }

  /** Whether an arrival may still wake the session: a silenced command's end may not. */
  wakes(sessionId: string): (trigger: WakeTrigger) => boolean {
    const quiet = this.sessions.get(sessionId)?.quiet;
    return (trigger) => !(trigger.kind === 'jobs' && quiet?.has(trigger.job) === true);
  }

  /**
   * Stops what would wake the session: every wait, for the user's Cancel, or those the tool calls in `uses` started,
   * for a rewind that cuts their turns. Children end without a report, monitors and PR watches with no note, and a
   * command a monitor started stops. On Cancel, the session's other commands run on, silenced. True when anything was pending.
   */
  cancel(sessionId: string, uses?: ReadonlySet<string>): boolean {
    // Cancel silences commands a session that never waited on anything else may still run.
    const waits = uses === undefined ? this.of(sessionId) : this.sessions.get(sessionId);
    if (waits === undefined) return false;
    const chosen = (toolUseId: string) => uses === undefined || uses.has(toolUseId);
    let any = false;
    for (const [id, child] of waits.children) {
      if (!chosen(child.toolUseId)) continue;
      waits.children.delete(id);
      child.silence();
      any = true;
    }
    for (const monitor of [...waits.monitors.values()]) {
      if (!chosen(monitor.toolUseId)) continue;
      monitor.end();
      if (monitor.ownsJob) void this.jobs.stop(sessionId, monitor.job, 'user').catch(() => {});
      any = true;
    }
    for (const watch of [...waits.prs.values()]) {
      if (!chosen(watch.toolUseId)) continue;
      watch.end();
      any = true;
    }
    for (const [id, schedule] of waits.schedules) {
      if (!chosen(schedule.toolUseId)) continue;
      clearTimeout(schedule.timer);
      waits.schedules.delete(id);
      any = true;
    }
    if (uses === undefined) {
      for (const job of this.jobs.running(sessionId)) {
        any ||= !waits.quiet.has(job.id as JobId);
        waits.quiet.add(job.id as JobId);
      }
    }
    if (any) this.hooks.changed(sessionId);
    return any;
  }

  /** The session went away, as on delete: nothing of it may wake anything. */
  forget(sessionId: string): void {
    this.cancel(sessionId);
    this.sessions.delete(sessionId);
  }
}
