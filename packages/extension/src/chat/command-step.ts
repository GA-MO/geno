import { jobEndText, type JobState } from '@g-code/core/background';
import type { BackgroundStep, ToolBlock, ToolStatus } from './messages.js';

/** Output lines a folded command step shows before its fade. */
export const PREVIEW_LINES = 4;

const TITLE_MAX = 100;

/** The engine ends a command's output with how it exited, for the model; the step shows a failed exit as a badge. */
const EXIT_LINE = /^\[(?:exit code (\S+)|killed after (\d+) seconds)\]$/;

/** A failed command's output also starts with its exit, for the model. */
const FAILURE_HEAD = /^(?:Exit code \S+|Killed after \d+ seconds)$/;

/** Lines the engine adds for the model, not the command's own output: Geno's notes and where the shell's cwd went back to. */
const MODEL_NOTE = /^(?:\[Geno\] |Shell cwd was reset to )/;

/**
 * A bash call as its step draws it: a title in plain words, the command in full, and the first lines of its
 * output. `output` is undefined until the command has any; `truncated` says lines past the preview are hidden.
 * `fromEnd`: the preview keeps the last lines instead, as a live tail does and where a failed command says why.
 */
export type CommandStep = {
  readonly title: string;
  readonly command: string;
  readonly output: readonly string[] | undefined;
  readonly truncated: boolean;
  readonly fromEnd: boolean;
  /** How a command that did not exit cleanly ended, as its badge says it: `exit 1`, `killed after 30s`. */
  readonly exit: string | undefined;
  /** What the engine told the model besides the output, which the step keeps behind Show details. */
  readonly notes: readonly string[];
  /** Every output line, for the button that shows them all. */
  readonly lines: number;
  readonly status: ToolStatus;
  /** The background command the call started; its output is then the end of what the command printed so far. */
  readonly job?: CommandJob | undefined;
};

/** A background command on its step. `running` offers Stop; once it ended, `line` is the notice of how it ended. */
export type CommandJob = { readonly id: string; readonly running: boolean; readonly line: string; readonly tone: JobTone };

export type JobTone = 'running' | 'ended' | 'failed' | 'stopped';

const toneOf = (state: JobState): JobTone =>
  state.status === 'running' ? 'running' : state.status === 'exited' ? (state.exitCode === 0 ? 'ended' : 'failed') : 'stopped';

function jobOf(job: BackgroundStep): CommandJob {
  const { state } = job;
  const running = state.status === 'running';
  const runs = job.preview === undefined ? `Running in background as ${job.id}` : `Serving ${job.preview.url} as ${job.id}`;
  const line = running ? (state.ending === undefined ? runs : `Stopping ${job.id}…`) : `${job.id} ${jobEndText(state)}`;
  return { id: job.id, running, line, tone: toneOf(state) };
}

/** The model's description, on one line and short enough for a title, or the plain fallback. */
function titleOf(tool: ToolBlock): string {
  const preview = tool.background?.preview;
  if (preview !== undefined) return `Dev server ${preview.name}`;
  const description = tool.description?.replace(/\s+/g, ' ').trim() ?? '';
  if (description === '') return tool.status === 'running' ? 'Running a command' : 'Ran a command';
  return description.length <= TITLE_MAX ? description : `${description.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

type Output = { readonly lines: readonly string[] | undefined; readonly exit: string | undefined; readonly notes: readonly string[] };

const NO_OUTPUT: Output = { lines: undefined, exit: undefined, notes: [] };

/** A command's own output, split from the lines the engine wrote for the model. A refused command never ran, so it has none. */
function outputOf(output: string | undefined, status: ToolStatus): Output {
  if (output === undefined || status === 'denied') return NO_OUTPUT;
  const all = output.replace(/\s+$/, '').split('\n');
  const notes = all.filter((line) => MODEL_NOTE.test(line));
  const lines = all.filter((line) => !MODEL_NOTE.test(line));
  if (status === 'failed' && lines.length > 1 && FAILURE_HEAD.test(lines[0]!)) lines.shift();
  const ended = EXIT_LINE.exec(lines.at(-1) ?? '');
  if (ended !== null) lines.pop();
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop();
  const exit = ended === null ? undefined : ended[2] !== undefined ? `killed after ${ended[2]}s` : ended[1] === '0' ? undefined : `exit ${ended[1]}`;
  return { lines, exit, notes };
}

export function commandStepOf(tool: ToolBlock, expanded: boolean): CommandStep {
  const { background } = tool;
  const { lines, exit, notes } = background === undefined ? outputOf(tool.output, tool.status) : { ...NO_OUTPUT, lines: background.tail === '' ? [] : background.tail.split('\n') };
  const truncated = !expanded && lines !== undefined && lines.length > PREVIEW_LINES;
  const fromEnd = background !== undefined || tool.status === 'failed';
  const shown = lines === undefined || !truncated ? lines : fromEnd ? lines.slice(-PREVIEW_LINES) : lines.slice(0, PREVIEW_LINES);
  return {
    title: titleOf(tool),
    command: background?.command ?? tool.target,
    output: shown,
    truncated,
    fromEnd,
    exit,
    notes,
    lines: lines?.length ?? 0,
    status: tool.status,
    job: background === undefined ? undefined : jobOf(background),
  };
}
