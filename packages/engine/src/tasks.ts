import { isLive, taskNotice, type TaskNoticeKind, type TaskRecord, type TasksResponse, type TaskStatus, type TaskUpdate, type Waiting } from '@g-code/core';

/** How many ended tasks the list keeps, newest first; running ones always stay. */
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
  private readonly asking = new Map<string, number>();
  private readonly changed = new Set<() => void>();

  /** A turn of the session starts. */
  start(task: Omit<TaskRecord, 'status' | 'endedAt' | 'usage'>): void {
    this.asking.delete(task.sessionId);
    this.put({ ...task, status: 'running', endedAt: null, usage: undefined });
  }

  update(sessionId: string, patch: Partial<Pick<TaskRecord, 'title' | 'usage' | 'lane'>>): void {
    const record = this.records.get(sessionId);
    if (record !== undefined && isLive(record.status)) this.put({ ...record, ...patch });
  }

  /** The turn ended. */
  end(sessionId: string, status: Exclude<TaskStatus, 'running' | 'needs-input' | 'waiting'>, usage: TaskRecord['usage']): void {
    const record = this.records.get(sessionId);
    if (record === undefined) return;
    this.asking.delete(sessionId);
    this.put({ ...record, status, endedAt: Date.now(), usage: usage ?? record.usage, waiting: undefined });
  }

  /** A model call of the turn waits offline or for a limit, or its next try moved; null when it went out. */
  wait(sessionId: string, waiting: Waiting | null): void {
    const record = this.records.get(sessionId);
    if (record === undefined || !isLive(record.status)) return;
    if (waiting !== null) return this.put({ ...record, status: 'waiting', waiting });
    if (record.status === 'waiting') this.put({ ...record, status: this.asking.has(sessionId) ? 'needs-input' : 'running', waiting: undefined });
  }

  /** The turn waits on the user until the returned function runs; several questions at once count as one wait. */
  ask(sessionId: string): () => void {
    this.asking.set(sessionId, (this.asking.get(sessionId) ?? 0) + 1);
    this.status(sessionId, 'needs-input');
    let answered = false;
    return () => {
      if (answered) return;
      answered = true;
      const left = (this.asking.get(sessionId) ?? 1) - 1;
      if (left > 0) return void this.asking.set(sessionId, left);
      this.asking.delete(sessionId);
      this.status(sessionId, 'running');
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

  private status(sessionId: string, status: TaskStatus): void {
    const record = this.records.get(sessionId);
    if (record !== undefined && isLive(record.status)) this.put({ ...record, status });
  }

  private put(task: TaskRecord): void {
    const before = this.records.get(task.sessionId);
    this.records.delete(task.sessionId);
    this.records.set(task.sessionId, task);
    this.prune();
    const notice = taskNotice(before?.status, task.status);
    if (notice !== undefined && this.listeners.size === 0) this.missed.set(task.sessionId, notice.kind);
    const update: TaskUpdate = { task, notice: notice?.kind ?? null };
    for (const listener of this.listeners) listener(update);
    for (const then of this.changed) then();
  }

  private prune(): void {
    const ended = [...this.records.values()].filter((record) => !isLive(record.status)).toSorted((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    for (const record of ended.slice(KEPT_ENDED)) this.records.delete(record.sessionId);
  }
}
