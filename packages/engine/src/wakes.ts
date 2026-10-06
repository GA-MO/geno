import { MONITOR_LINE_CHARS, nextWakeId, type JobId, type TurnEvent, type WakeArrival, type WakeId, type WakeNote, type WakeSource, type WakeTrigger } from '@g-code/core';
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

type ScheduleWait = { readonly dueAt: number; readonly reason: string; readonly toolUseId: string; readonly timer: ReturnType<typeof setTimeout> };

type SessionWaits = {
  readonly children: Map<string, ChildWait>;
  readonly monitors: Map<WakeId, MonitorWait>;
  readonly schedules: Map<WakeId, ScheduleWait>;
  /** Commands that run on but no longer wake the session, after the user cancelled its wakes. */
  readonly quiet: Set<JobId>;
};

export type WakeHooks = {
  /** A monitor or a wake-up reported; it goes to the session's inbox. */
  arrive(sessionId: string, arrival: WakeArrival): void;
  /** What the session waits on changed. */
  changed(sessionId: string): void;
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
      waits = { children: new Map(), monitors: new Map(), schedules: new Map(), quiet: new Set() };
      this.sessions.set(sessionId, waits);
    }
    return waits;
  }

  /** A background child started; the returned function marks its report made. */
  child(sessionId: string, childId: string, wait: ChildWait): () => void {
    this.of(sessionId).children.set(childId, wait);
    this.hooks.changed(sessionId);
    return () => {
      if (this.sessions.get(sessionId)?.children.delete(childId) === true) this.hooks.changed(sessionId);
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
      const note: WakeNote = { kind: 'monitor', id: start.id, toolUseId: start.toolUseId, job: start.job, pattern: start.pattern.source, ...result };
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
    return nextWakeId(events, waits === undefined ? [] : [...waits.monitors.keys(), ...waits.schedules.keys()]);
  }

  /** What the session waits on, oldest kind first, as the Tasks list names it. */
  waitsFor(sessionId: string): WakeSource[] {
    const waits = this.sessions.get(sessionId);
    const running = this.jobs.running(sessionId).filter((job) => waits?.quiet.has(job.id as JobId) !== true);
    return [
      ...[...(waits?.children ?? [])].map(([child, wait]): WakeSource => ({ kind: 'children', child, agent: wait.agent })),
      ...running.map((job): WakeSource => ({ kind: 'jobs', job: job.id as JobId })),
      ...[...(waits?.monitors ?? [])].map(([id, wait]): WakeSource => ({ kind: 'monitor', id, job: wait.job, pattern: wait.pattern })),
      ...[...(waits?.schedules ?? [])].map(([id, wait]): WakeSource => ({ kind: 'schedule', id, dueAt: wait.dueAt })),
    ];
  }

  /** Whether an arrival may still wake the session: a silenced command's end may not. */
  wakes(sessionId: string): (trigger: WakeTrigger) => boolean {
    const quiet = this.sessions.get(sessionId)?.quiet;
    return (trigger) => !(trigger.kind === 'jobs' && quiet?.has(trigger.job) === true);
  }

  /**
   * Stops what would wake the session: every wait, for the user's Cancel, or those the tool calls in `uses` started,
   * for a rewind that cuts their turns. Children end without a report and monitors with no note, and a command a
   * monitor started stops. On Cancel, the session's other commands run on, silenced. True when anything was pending.
   */
  cancel(sessionId: string, uses?: ReadonlySet<string>): boolean {
    const waits = this.sessions.get(sessionId);
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
