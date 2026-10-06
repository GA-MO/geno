import path from 'node:path';
import {
  BACKGROUND_TAIL_CHARS,
  BACKGROUND_TAIL_LINES,
  backgroundStartText,
  isJobId,
  MAX_BACKGROUND_JOBS,
  nextJobState,
  STOP_GRACE_MS,
  type BackgroundEndEvent,
  type BackgroundJob,
  type EndedJobState,
  type JobId,
  type JobInput,
  type JobView,
  type KillCause,
  type StopBy,
  type TaskJob,
  type TurnEvent,
} from '@g-code/core';
import { CappedOutput } from './background-output.js';
import type { SpawnedShell } from './process.js';
import type { Sandbox } from './sandbox.js';
import { ToolError } from './tools/context.js';

/** How often a running job's step hears of new output, at most. */
const OUTPUT_UPDATE_MS = 250;

/** Ended jobs a session keeps for bash_output, newest first; older ones are forgotten. */
const KEPT_ENDED = 8;

/** A job ended, as the session hears of it: the end event without the number its log gives it. */
export type JobEnd = Omit<BackgroundEndEvent, 'seq'>;

export type JobHooks = {
  /** A job started, printed something, or ended. Output changes come at most every OUTPUT_UPDATE_MS. */
  changed(job: BackgroundJob, view: JobView): void;
  ended(end: JobEnd, job: BackgroundJob): void;
};

/** Where and how a command starts. The job holds the sandbox open until it ends, past the turn that started it. */
export type JobStart = {
  readonly sessionId: string;
  readonly toolUseId: string;
  readonly command: string;
  readonly description?: string | undefined;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** The session's spill folder; the output goes in a folder under it. */
  readonly spillDir: string;
  /** The session so far, so a job started after an engine restart takes a fresh id. */
  readonly events: readonly TurnEvent[];
  readonly sandbox: Pick<Sandbox, 'spawn' | 'retain'>;
};

type Entry = {
  job: BackgroundJob;
  readonly cwd: string;
  readonly output: CappedOutput;
  readonly shell: SpawnedShell;
  readonly done: Promise<BackgroundJob>;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Monitors on the job's output, each fed every chunk as it arrives. */
  readonly watchers: Set<(chunk: string) => void>;
};

const STARTED = /^Started background command (bg-\d+)\./;

/** The ids a session's log already used, by the start lines and end events it holds. */
export function jobIdsIn(events: readonly TurnEvent[]): JobId[] {
  return events.flatMap((event): JobId[] => {
    if (event.kind === 'background-end') return [event.job.id];
    const id = event.kind === 'tool-result' && (event.name === 'bash' || event.name === 'monitor') && 'output' in event ? STARTED.exec(event.output)?.[1] : undefined;
    return id !== undefined && isJobId(id) ? [id] : [];
  });
}

const numberOf = (id: JobId): number => Number(id.slice(3));

export const tailOf = (output: CappedOutput): string => {
  const tail = output.tail(BACKGROUND_TAIL_LINES);
  return tail.length > BACKGROUND_TAIL_CHARS ? tail.slice(-BACKGROUND_TAIL_CHARS) : tail;
};

const viewOf = (entry: Entry): JobView => ({
  id: entry.job.id,
  toolUseId: entry.job.toolUseId,
  command: entry.job.command,
  ...(entry.job.description === undefined ? {} : { description: entry.job.description }),
  state: entry.job.state,
  tail: tailOf(entry.output),
});

/** The background commands of every session in this engine process. */
export class BackgroundJobs {
  private readonly sessions = new Map<string, Map<JobId, Entry>>();

  constructor(private readonly hooks: JobHooks) {}

  /** Starts a command, or refuses past the session's limit. Returns the line the bash call answers with. */
  async start(start: JobStart): Promise<{ readonly job: BackgroundJob; readonly text: string }> {
    const jobs = this.sessions.get(start.sessionId) ?? this.sessions.set(start.sessionId, new Map()).get(start.sessionId)!;
    const running = [...jobs.values()].filter((entry) => entry.job.state.status === 'running');
    if (running.length >= MAX_BACKGROUND_JOBS) {
      throw new ToolError(
        `${MAX_BACKGROUND_JOBS} background commands already run in this session (${running.map((entry) => entry.job.id).join(', ')}). Stop one with bash_stop before you start another.`,
      );
    }
    const used = [...jobs.keys(), ...jobIdsIn(start.events)].map(numberOf);
    const id: JobId = `bg-${Math.max(0, ...used) + 1}`;
    const output = new CappedOutput(path.join(start.spillDir, 'background', `${id}.log`));
    const release = start.sandbox.retain();
    let entry: Entry | undefined;
    let shell: SpawnedShell;
    try {
      shell = await start.sandbox.spawn(start.command, {
        cwd: start.cwd,
        env: start.env,
        onOutput: (chunk) => {
          output.append(chunk);
          if (entry === undefined) return;
          this.printed(entry);
          for (const watcher of entry.watchers) watcher(chunk.toString('utf8'));
        },
      });
    } catch (error) {
      await release();
      throw error;
    }
    const job: BackgroundJob = {
      id,
      sessionId: start.sessionId,
      toolUseId: start.toolUseId,
      command: start.command,
      ...(start.description === undefined ? {} : { description: start.description }),
      pid: shell.pid,
      state: { status: 'running' },
      startedAt: Date.now(),
      endedAt: null,
      outputFile: output.file,
    };
    const done = shell.exited.then(async ({ code, signal }) => {
      const ended = this.step(entry!, { kind: 'exit', exitCode: code, signal });
      clearTimeout(entry!.timer);
      await output.flushed();
      await release();
      this.hooks.changed(entry!.job, viewOf(entry!));
      this.hooks.ended({ kind: 'background-end', at: new Date().toISOString(), job: { id, toolUseId: job.toolUseId, command: job.command, state: ended.state as EndedJobState }, tail: tailOf(output) }, ended);
      this.forgetOld(jobs);
      return ended;
    });
    entry = { job, cwd: start.cwd, output, shell, done, timer: undefined, watchers: new Set() };
    jobs.set(id, entry);
    this.hooks.changed(entry.job, viewOf(entry));
    return { job, text: backgroundStartText(id) };
  }

  /** The session's jobs that run now, oldest first. */
  running(sessionId: string): TaskJob[] {
    return [...(this.sessions.get(sessionId)?.values() ?? [])]
      .filter((entry) => entry.job.state.status === 'running')
      .map(({ job }) => ({ id: job.id, command: job.command, description: job.description, startedAt: job.startedAt }));
  }

  /** Every job of the session the engine still knows, as the panel shows it. */
  views(sessionId: string): JobView[] {
    return [...(this.sessions.get(sessionId)?.values() ?? [])].map(viewOf);
  }

  /** bash_output: the job's status, then its last `tail` lines, or what it printed since the last read. */
  output(sessionId: string, id: string, tail: number | undefined): string {
    const entry = this.entry(sessionId, id);
    const { state } = entry.job;
    const status =
      state.status === 'running'
        ? `${id} is running (pid ${entry.job.pid}).`
        : state.status === 'exited'
          ? `${id} exited${state.exitCode === null ? ` on ${state.signal ?? 'a signal'}` : ` with code ${state.exitCode}`}.`
          : `${id} was ${state.status}.`;
    if (tail !== undefined) {
      const lines = entry.output.tail(tail);
      return `${status}\n${lines === '' ? '(no output yet)' : `Its last ${tail} lines:\n${lines}`}`;
    }
    const { text, dropped } = entry.output.unread();
    const skipped = dropped > 0 ? `[${dropped} bytes of output were dropped before this read]\n` : '';
    return `${status}\n${text === '' ? '(no new output since the last read)' : `${skipped}New output:\n${text.replace(/\n$/, '')}`}`;
  }

  /**
   * Feeds `chunk` everything the job prints from now on, until the returned `stop`. `kept` is what it printed before
   * that and still keeps; `ended` settles as the job ends.
   */
  watch(sessionId: string, id: string, chunk: (text: string) => void): { readonly job: BackgroundJob; readonly kept: string; readonly ended: Promise<BackgroundJob>; stop(): void } {
    const entry = this.entry(sessionId, id);
    entry.watchers.add(chunk);
    return { job: entry.job, kept: entry.output.tail(Number.MAX_SAFE_INTEGER), ended: entry.done, stop: () => entry.watchers.delete(chunk) };
  }

  /** bash_stop and the step's Stop button: SIGTERM, then SIGKILL after the grace period. Settles once it ended. */
  async stop(sessionId: string, id: string, by: StopBy): Promise<BackgroundJob> {
    const entry = this.entry(sessionId, id);
    this.end(entry, { kind: 'stop', by });
    return entry.done;
  }

  /** Kills a session's running jobs, or those that run in a folder, as a deleted session or a discarded lane needs. */
  async kill(cause: KillCause, which: { readonly sessionId: string } | { readonly cwd: string } | 'all'): Promise<void> {
    const entries = [...this.sessions.values()].flatMap((jobs) => [...jobs.values()]);
    const chosen = entries.filter((entry) => which === 'all' || ('sessionId' in which ? entry.job.sessionId === which.sessionId : isInside(entry.cwd, which.cwd)));
    for (const entry of chosen) this.end(entry, { kind: 'kill', cause });
    await Promise.all(chosen.map((entry) => entry.done));
  }

  /** Kills every running job at once, for an engine on its way out, which cannot wait for a grace period. */
  killAllNow(): void {
    for (const jobs of this.sessions.values()) {
      for (const entry of jobs.values()) {
        if (entry.job.state.status !== 'running') continue;
        entry.job = { ...entry.job, state: nextJobState(entry.job.state, { kind: 'kill', cause: 'engine-exit' }) };
        entry.shell.signal('SIGKILL');
      }
    }
  }

  /** Settles once every job that runs now has ended. */
  async settled(): Promise<void> {
    await Promise.all([...this.sessions.values()].flatMap((jobs) => [...jobs.values()].map((entry) => entry.done)));
  }

  private entry(sessionId: string, id: string): Entry {
    const entry = isJobId(id) ? this.sessions.get(sessionId)?.get(id) : undefined;
    if (entry === undefined) throw new ToolError(`no background command ${id} in this session${isJobId(id) ? '; it may have ended before the engine restarted' : ''}`);
    return entry;
  }

  private step(entry: Entry, input: JobInput): BackgroundJob {
    const state = nextJobState(entry.job.state, input);
    if (state !== entry.job.state) entry.job = { ...entry.job, state, endedAt: state.status === 'running' ? null : Date.now() };
    return entry.job;
  }

  private end(entry: Entry, input: Extract<JobInput, { kind: 'stop' | 'kill' }>): void {
    if (entry.job.state.status !== 'running') return;
    const first = entry.job.state.ending === undefined;
    this.step(entry, input);
    if (!first) return;
    this.hooks.changed(entry.job, viewOf(entry));
    entry.shell.signal('SIGTERM');
    const force = setTimeout(() => entry.shell.signal('SIGKILL'), STOP_GRACE_MS);
    void entry.done.then(() => clearTimeout(force));
  }

  private printed(entry: Entry): void {
    if (entry.timer !== undefined || entry.job.state.status !== 'running') return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (entry.job.state.status === 'running') this.hooks.changed(entry.job, viewOf(entry));
    }, OUTPUT_UPDATE_MS);
  }

  private forgetOld(jobs: Map<JobId, Entry>): void {
    const ended = [...jobs.values()].filter((entry) => entry.job.state.status !== 'running').toSorted((a, b) => (b.job.endedAt ?? 0) - (a.job.endedAt ?? 0));
    for (const entry of ended.slice(KEPT_ENDED)) jobs.delete(entry.job.id);
  }
}

const isInside = (file: string, folder: string): boolean => {
  const relative = path.relative(folder, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
