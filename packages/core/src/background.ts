import { neutralize } from './fence.js';
import type { PreviewTag } from './preview.js';

/**
 * Background commands (U45). A `bash` call with `run_in_background` returns at once with a job id; the command runs
 * on in the engine process, its output kept in a capped file, and the session hears when it ends.
 */

/** At most this many of a session's background commands run at once. */
export const MAX_BACKGROUND_JOBS = 4;

/** Bytes of a command's output kept, in memory and in its output file; older bytes are dropped. */
export const BACKGROUND_OUTPUT_CAP = 1024 * 1024;

/** How long a stopped command has after SIGTERM before SIGKILL. */
export const STOP_GRACE_MS = 3000;

/** Lines of output an end notice carries, and that `bash_output` gives with no `tail`. */
export const BACKGROUND_TAIL_LINES = 20;

/** Characters of output an end notice carries at most. */
export const BACKGROUND_TAIL_CHARS = 2000;

/** Numbered per session, so the model reads `bg-1`, `bg-2`. */
export type JobId = `bg-${number}`;

export const isJobId = (raw: string): raw is JobId => /^bg-[1-9]\d*$/.test(raw);

/** Who stopped a command: the model with `bash_stop`, or the user with the step's Stop button. */
export type StopBy = 'model' | 'user';

/** Why the engine killed a command without anyone asking for it. */
export type KillCause = 'session-deleted' | 'lane-discarded' | 'engine-exit';

/**
 * A job's state. A running job that was asked to end remembers why in `ending`, so its exit reads as a stop or a kill
 * rather than as the command's own exit.
 */
export type JobState =
  | { readonly status: 'running'; readonly ending?: { readonly kind: 'stop'; readonly by: StopBy } | { readonly kind: 'kill'; readonly cause: KillCause } | undefined }
  | { readonly status: 'exited'; readonly exitCode: number | null; readonly signal: string | null }
  | { readonly status: 'stopped'; readonly by: StopBy }
  | { readonly status: 'killed'; readonly cause: KillCause };

export type JobStatus = JobState['status'];

export type EndedJobState = Exclude<JobState, { readonly status: 'running' }>;

export type JobInput =
  | { readonly kind: 'stop'; readonly by: StopBy }
  | { readonly kind: 'kill'; readonly cause: KillCause }
  | { readonly kind: 'exit'; readonly exitCode: number | null; readonly signal: string | null };

/** The job state machine. An ended job stays as it ended; a second stop or kill keeps the first reason. */
export function nextJobState(state: JobState, input: JobInput): JobState {
  if (state.status !== 'running') return state;
  if (input.kind !== 'exit') return state.ending === undefined ? { status: 'running', ending: input } : state;
  const { ending } = state;
  if (ending?.kind === 'stop') return { status: 'stopped', by: ending.by };
  if (ending?.kind === 'kill') return { status: 'killed', cause: ending.cause };
  return { status: 'exited', exitCode: input.exitCode, signal: input.signal };
}

/**
 * Whether the model hears of the end at its next request. It started the command, so it hears of its own exit and of
 * a stop the user made; it already knows of its own stop, and a kill comes with the session or engine going away.
 */
export const TELLS_MODEL = (state: EndedJobState): boolean => state.status === 'exited' || (state.status === 'stopped' && state.by === 'user');

/** A background command as the engine keeps it. Times are ms since the epoch. */
export type BackgroundJob = {
  readonly id: JobId;
  readonly sessionId: string;
  /** The bash call that started it, which its step in the panel follows. */
  readonly toolUseId: string;
  readonly command: string;
  readonly description?: string | undefined;
  /** Set when preview_start ran it: the dev server it is. */
  readonly preview?: PreviewTag | undefined;
  readonly pid: number;
  readonly state: JobState;
  readonly startedAt: number;
  readonly endedAt: number | null;
  /** Where its output is kept, under the app home, capped at BACKGROUND_OUTPUT_CAP. */
  readonly outputFile: string;
};

/** What the panel and the Tasks pane show of a job. `tail` is the end of its output. */
export type JobView = Pick<BackgroundJob, 'id' | 'toolUseId' | 'command' | 'state'> & {
  readonly description?: string | undefined;
  readonly preview?: PreviewTag | undefined;
  readonly tail: string;
};

/** In a `tool_call_update`'s `_meta` for the bash call that started a job: the job as it is now. */
export const BACKGROUND_META = 'gcode/background';

/** Stops a running background command, as the step's Stop button does. */
export const BACKGROUND_STOP_METHOD = '_gcode/backgroundStop';
export type BackgroundStopRequest = { readonly sessionId: string; readonly id: string };

/**
 * A job ended: logged in its session at the next safe point, after a tool batch and before the next model call, or at
 * once while no turn runs. The loop steps over it; the next request carries its text after any tool results.
 */
export type BackgroundEndEvent = {
  readonly kind: 'background-end';
  readonly seq: number;
  readonly at: string;
  readonly job: Pick<BackgroundJob, 'id' | 'toolUseId' | 'command' | 'preview'> & { readonly state: EndedJobState };
  readonly tail: string;
};

/** How an ended job reads, after its id. */
export function jobEndText(state: EndedJobState): string {
  switch (state.status) {
    case 'exited':
      return state.exitCode === null ? `was killed by ${state.signal ?? 'a signal'}` : `exited with code ${state.exitCode}`;
    case 'stopped':
      return state.by === 'user' ? 'was stopped by the user' : 'was stopped';
    case 'killed':
      return `was killed because ${KILL_WORDS[state.cause]}`;
  }
}

const KILL_WORDS: Readonly<Record<KillCause, string>> = {
  'session-deleted': 'its session was deleted',
  'lane-discarded': 'its lane was discarded',
  'engine-exit': 'the engine exited',
};

export const backgroundEndNotice = ({ job, tail }: Pick<BackgroundEndEvent, 'job' | 'tail'>): string =>
  `[Background command ${job.id} (\`${job.command}\`) ${jobEndText(job.state)}. ${
    tail === '' ? 'It printed nothing.' : `The end of its output:\n${neutralize(tail)}\n`
  }]`;

/** The line `bash` returns for a command it started in the background. */
export const backgroundStartText = (id: JobId): string =>
  `Started background command ${id}. It keeps running while you work; you will be told when it ends. Read its output with bash_output and end it with bash_stop.`;
