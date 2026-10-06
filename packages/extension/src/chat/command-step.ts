import type { ToolBlock, ToolStatus } from './messages.js';

/** Output lines a folded command step shows before its fade. */
export const PREVIEW_LINES = 4;

const TITLE_MAX = 100;

/** The engine ends a command's output with its exit line; a clean exit says nothing the step's status does not. */
const CLEAN_EXIT = '[exit code 0]';

/**
 * A bash call as its step draws it: a title in plain words, the command in full, and the first lines of its
 * output. `output` is undefined until the command has any; `truncated` says lines past the preview are hidden.
 */
export type CommandStep = {
  readonly title: string;
  readonly command: string;
  readonly output: readonly string[] | undefined;
  readonly truncated: boolean;
  /** Every output line, for the button that shows them all. */
  readonly lines: number;
  readonly status: ToolStatus;
};

/** The model's description, on one line and short enough for a title, or the plain fallback. */
function titleOf(tool: ToolBlock): string {
  const description = tool.description?.replace(/\s+/g, ' ').trim() ?? '';
  if (description === '') return tool.status === 'running' ? 'Running a command' : 'Ran a command';
  return description.length <= TITLE_MAX ? description : `${description.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

function outputLines(output: string | undefined): readonly string[] | undefined {
  if (output === undefined) return undefined;
  const lines = output.replace(/\s+$/, '').split('\n');
  if (lines.at(-1) === CLEAN_EXIT) lines.pop();
  while (lines.length > 0 && lines.at(-1)!.trim() === '') lines.pop();
  return lines;
}

export function commandStepOf(tool: ToolBlock, expanded: boolean): CommandStep {
  const lines = outputLines(tool.output);
  const truncated = !expanded && lines !== undefined && lines.length > PREVIEW_LINES;
  return {
    title: titleOf(tool),
    command: tool.target,
    output: lines === undefined ? undefined : truncated ? lines.slice(0, PREVIEW_LINES) : lines,
    truncated,
    lines: lines?.length ?? 0,
    status: tool.status,
  };
}
