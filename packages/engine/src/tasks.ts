import { isLive, isWaking, returnedAtOf, taskNotice, type Asking, type WakeView, type TaskNoticeKind, type TaskRecord, type TasksResponse, type TaskJob, type TaskEnd, type TaskUpdate, type Waiting, type WorkflowProgress } from '@g-code/core';

const emptyless = (wake: WakeView | undefined): WakeView | undefined => (wake === undefined || (wake.waitsFor.length === 0 && wake.paused === undefined) ? undefined : wake);

/** How many ended top-level tasks the list keeps, newest first; running ones always stay. */
const KEPT_ENDED = 20;

/**
 * Every session that ran a turn in this engine process, with its latest turn's status. It tells each listener (one
 * per editor connection) about every change, with the trigger table's notice; a notice no editor was there to hear
 * is kept for the next one that lists the tasks.
 */
export class Tasks {
  private readonly records = new Map<string, TaskRecord>();
  private readonly listeners = new Set<(update: TaskUpdate) => void>();
  private readonly missed = new Map<string, TaskNoticeKind>();
  private readonly asking = new Map<string, { readonly count: number; readonly card: Asking }>();
  private readonly changed = new Set<() => void>();
  private readonly parents = new Map<string, string>();

  /** A turn of the session starts. A session that ran before keeps its parent, its running background commands and when it last came back. */
  start(task: Omit<TaskRecord, 'status' | 'endedAt' | 'usage' | 'returnedAt'>): void {
    this.asking.delete(task.sessionId);
    const before = this.records.get(task.sessionId);
    this.put({ parent: before?.parent, kind: before?.kind, jobs: before?.jobs, ...task, status: 'running', endedAt: null, usage: undefined, asking: undefined, wake: undefined });
  }

  /** The session's task rolls up into `parent`'s, from its next start on if it has not started yet. */
  adopt(sessionId: string, parent: string): void {
    this.parents.set(sessionId, parent);
    const record = this.records.get(sessionId);
    if (record !== undefined && record.parent !== parent) this.put({ ...record, parent });
  }

  update(sessionId: string, patch: Partial<Pick<TaskRecord, 'title' | 'usage' | 'lane'>>): void {
    const record = this.records.get(sessionId);
    if (record !== undefined && isLive(record.status)) this.put({ ...record, ...patch });
  }

  /** The session's background commands that run now, which outlive its turn. */
  jobs(sessionId: string, jobs: readonly TaskJob[]): void {
    const record = this.records.get(sessionId);
    if (record !== undefined) this.put({ ...record, jobs: jobs.length === 0 ? undefined : jobs });
  }

  /** The turn ended; a task ends once. `wake` is what will wake the session again, given with the end so no notice says it finished. */
  end(sessionId: string, status: TaskEnd, usage: TaskRecord['usage'], wake?: WakeView): void {
    const record = this.records.get(sessionId);
    if (record === undefined || !isLive(record.status)) return;
    this.asking.delete(sessionId);
    this.put({ ...record, status, endedAt: Date.now(), usage: usage ?? record.usage, waiting: undefined, asking: undefined, wake: emptyless(wake) });
  }

  /** How far the session's workflow got; it keeps its last progress after its turn ends. */
  workflow(sessionId: string, progress: WorkflowProgress): void {
    const record = this.records.get(sessionId);
    if (record !== undefined && JSON.stringify(record.workflow) !== JSON.stringify(progress)) this.put({ ...record, workflow: progress });
  }

  /** What will wake the session after its turn, or why its wakes wait for the user; a running turn shows none. */
  wake(sessionId: string, wake: WakeView | undefined): void {
    const record = this.records.get(sessionId);
    const next = emptyless(wake);
    if (record === undefined || isLive(record.status) || JSON.stringify(record.wake) === JSON.stringify(next)) return;
    this.put({ ...record, wake: next });
  }

  /** A card of the session's, or of one of its subagents', waits for the user. */
  asks(sessionId: string): boolean {
    return [...this.records.values()].some((record) => (record.sessionId === sessionId || record.parent === sessionId) && record.status === 'needs-input');
  }

  /** A model call of the turn waits offline or for a limit, or its next try moved; null when it went out. */
  wait(sessionId: string, waiting: Waiting | null): void {
    const record = this.records.get(sessionId);
    if (record === undefined || !isLive(record.status)) return;
    if (waiting !== null) return this.put({ ...record, status: 'waiting', waiting, asking: undefined });
    if (record.status !== 'waiting') return;
    const asking = this.asking.get(sessionId);
    this.put({ ...record, status: asking === undefined ? 'running' : 'needs-input', asking: asking?.card, waiting: undefined });
  }

  /**
   * The turn waits on the user's answer to `card` until the returned function runs. Several cards at once count as
   * one wait, which shows the first.
   */
  ask(sessionId: string, card: Asking): () => void {
    const before = this.asking.get(sessionId);
    this.asking.set(sessionId, { count: (before?.count ?? 0) + 1, card: before?.card ?? card });
    const record = this.records.get(sessionId);
    if (record !== undefined && isLive(record.status)) this.put({ ...record, status: 'needs-input', asking: before?.card ?? card, waiting: undefined });
    let answered = false;
    return () => {
      if (answered) return;
      answered = true;
      const left = this.asking.get(sessionId);
      if (left !== undefined && left.count > 1) return void this.asking.set(sessionId, { ...left, count: left.count - 1 });
      this.asking.delete(sessionId);
      const now = this.records.get(sessionId);
      if (now !== undefined && isLive(now.status)) this.put({ ...now, status: 'running', asking: undefined });
    };
  }

  get(sessionId: string): TaskRecord | undefined {
    return this.records.get(sessionId);
  }

  anyLive(): boolean {
    return [...this.records.values()].some((record) => isLive(record.status));
  }

  /** The list for an editor that just connected; the notices it missed are its to show, once. */
  list(): TasksResponse {
    const missed = [...this.missed].map(([sessionId, kind]) => ({ sessionId, kind }));
    this.missed.clear();
    return { tasks: [...this.records.values()].toSorted((a, b) => b.startedAt - a.startedAt), missed };
  }

  listen(listener: (update: TaskUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Runs `then` after every change, such as for the process to see whether it is idle. */
  onChange(then: () => void): void {
    this.changed.add(then);
  }

  private put(next: TaskRecord): void {
    const before = this.records.get(next.sessionId);
    const parent = next.parent ?? this.parents.get(next.sessionId) ?? null;
    const task: TaskRecord = { ...next, parent, returnedAt: returnedAtOf(before, next, Date.now()) };
    this.records.delete(task.sessionId);
    this.records.set(task.sessionId, task);
    this.prune();
    // A turn that ended while its background work will wake the session has not finished yet.
    const notice = isWaking(task.wake) ? undefined : taskNotice(before?.status, task.status);
    if (notice !== undefined && this.listeners.size === 0) this.missed.set(task.sessionId, notice.kind);
    const update: TaskUpdate = { task, notice: notice?.kind ?? null };
    for (const listener of this.listeners) listener(update);
    for (const then of this.changed) then();
  }

  /**
   * A subagent that ended goes once its end is told: its parent's own record holds the outcome. An Arena run's lanes
   * stay with the run, and go with it.
   */
  private prune(): void {
    const records = [...this.records.values()];
    const drop = (id: string) => (this.records.delete(id), this.parents.delete(id));
    for (const record of records) if (record.kind === 'subagent' && !isLive(record.status)) drop(record.sessionId);
    const ended = records.filter((record) => record.parent === null && !isLive(record.status)).toSorted((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    for (const root of ended.slice(KEPT_ENDED)) {
      drop(root.sessionId);
      for (const record of records) if (record.parent === root.sessionId && !isLive(record.status)) drop(record.sessionId);
    }
  }
}
