import type { EditorDiagnostic } from './acp.js';
import { EDIT_FORMAT_SPECS } from './edit.js';
import { AGENT_EDIT_FORMAT } from './agent.js';
import { MAX_EDIT_RETRIES } from './model-applier.js';
import { fileLines, numberLines } from './str-replace.js';

/** Model calls for one inline edit: the edit, its retries, and the closing sentence. */
export const INLINE_EDIT_MAX_TURNS = MAX_EDIT_RETRIES + 2;

export type SelectionEdit = {
  /** As the model should name the file: relative to the workspace. */
  readonly path: string;
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly instruction: string;
  readonly diagnostics: readonly EditorDiagnostic[];
};

/** The one message of a Cmd-K edit: the instruction, the file with the selection marked by line numbers, and its problems. */
export function selectionEditPrompt(edit: SelectionEdit): string {
  const { path, text, startLine, endLine, instruction, diagnostics } = edit;
  const lines = fileLines(text);
  const range = startLine === endLine ? `line ${startLine}` : `lines ${startLine} to ${endLine}`;
  const problems = diagnostics.map((d) => `${path}:${d.line}:${d.character} ${d.severity}: ${d.message}`);
  return [
    `Change ${range} of ${path}, the user's selection, to carry out this instruction:`,
    '',
    instruction,
    '',
    `Here is ${path}, every line prefixed with its number and a tab that are not part of the file:`,
    '',
    lines.length === 0 ? '(the file is empty)' : numberLines(lines),
    ...(problems.length === 0 ? [] : ['', `The editor reports these problems in ${path}:`, ...problems]),
    '',
    `Change only the selection unless the instruction needs more. Edit only ${path}. ${EDIT_FORMAT_SPECS[AGENT_EDIT_FORMAT].instructions}`,
  ].join('\n');
}
