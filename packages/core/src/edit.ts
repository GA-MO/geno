import { createHash } from 'node:crypto';
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { hunksBetween, type Hunk } from './hunks.js';
import { applyUpdate, parsePatch, type PatchOp } from './patch.js';
import type { SessionId } from './session.js';
import { numberLines, fileLines, strReplace } from './str-replace.js';
import type { ApplyFailure, ApplyOutcome, EditFormat } from './types.js';

/** A file as an edit sees it. `text` is null when the file does not exist. */
export type FileState = { readonly path: string; readonly text: string | null };

/** What the model last read: the base an edit must still match before it is written. */
export type BaseRead = { readonly hash: string | null; readonly mtimeMs: number | null };

export const hashText = (text: string | null): string | null =>
  text === null ? null : createHash('sha256').update(text).digest('hex');

export const baseOf = (text: string | null, mtimeMs: number | null): BaseRead => ({ hash: hashText(text), mtimeMs });

export const staleBaseDetail = (path: string): string => `${path} changed since it was last read; read it again before editing`;

export type ApplyResult = { readonly kind: 'applied' } | { readonly kind: 'failed'; readonly reason: ApplyFailure; readonly detail: string };

/** The edit record. `check` stays null until project checks run after edits. */
export type ProposedChange = {
  readonly turn: { readonly sessionId: SessionId; readonly seq: number } | null;
  readonly path: string;
  readonly base: BaseRead;
  readonly format: EditFormat;
  readonly raw: unknown;
  readonly hunks: readonly Hunk[];
  readonly result: ApplyResult;
  readonly check: null;
};

type Input = Readonly<Record<string, unknown>>;

/** How the model is asked for an edit, and how its tool input becomes new file text. */
export type FormatSpec = {
  readonly tool: Tool;
  readonly instructions: string;
  apply(input: Input, file: FileState): ApplyOutcome;
};

const failed = (reason: ApplyFailure, detail: string): ApplyOutcome => ({ kind: 'failed', reason, detail });

function stringField(input: Input, tool: string, name: string): string | ApplyOutcome {
  const value = input[name];
  return typeof value === 'string' ? value : failed('parse-error', `${tool} needs ${name} as a string`);
}

const wrongPath = (tool: string, path: unknown, file: FileState): ApplyOutcome | undefined =>
  path === file.path ? undefined : failed('wrong-file', `${tool} can only change ${file.path}, not ${String(path)}`);

const missing = (file: FileState): ApplyOutcome => failed('wrong-file', `${file.path} does not exist`);

function strReplaceEdit(input: Input, file: FileState): ApplyOutcome {
  const wrong = wrongPath('edit', input['path'], file);
  if (wrong !== undefined) return wrong;
  const newStr = stringField(input, 'edit', 'new_str');
  if (typeof newStr !== 'string') return newStr;
  // proposeChange has checked that an existing file is still the base the model was shown, so create may replace it.
  if (input['create'] === true) return { kind: 'applied', after: newStr };
  if (file.text === null) return failed('wrong-file', `${file.path} does not exist; pass create: true to make it`);
  const oldStr = stringField(input, 'edit', 'old_str');
  if (typeof oldStr !== 'string') return oldStr;
  return strReplace(file.path, file.text, oldStr, newStr, input['replace_all'] === true);
}

const PATCH_OPS: { [K in PatchOp['kind']]: (op: Extract<PatchOp, { kind: K }>, text: string | null) => ApplyOutcome } = {
  add: (op, text) =>
    text === null ? { kind: 'applied', after: op.content } : failed('wrong-file', `${op.path} already exists; use Update File`),
  // A one-file edit has no way to say "gone", so a deleted file reads as empty.
  delete: (op, text) => (text === null ? missing({ path: op.path, text }) : { kind: 'applied', after: '' }),
  update: (op, text) => (text === null ? missing({ path: op.path, text }) : applyUpdate(op.path, text, op.chunks)),
};

const applyOp = <K extends PatchOp['kind']>(op: Extract<PatchOp, { kind: K }>, text: string | null): ApplyOutcome =>
  (PATCH_OPS[op.kind] as (o: typeof op, t: string | null) => ApplyOutcome)(op, text);

function applyPatchEdit(input: Input, file: FileState): ApplyOutcome {
  const patch = stringField(input, 'apply_patch', 'patch');
  if (typeof patch !== 'string') return patch;
  const parsed = parsePatch(patch);
  if (!parsed.ok) return failed('parse-error', `patch line ${parsed.line}: ${parsed.message}`);
  let text = file.text;
  for (const op of parsed.ops) {
    const wrong = wrongPath('apply_patch', op.path, file);
    if (wrong !== undefined) return wrong;
    const outcome = applyOp(op, text);
    if (outcome.kind === 'failed') return outcome;
    text = outcome.after;
  }
  return { kind: 'applied', after: text ?? '' };
}

function wholeFileEdit(input: Input, file: FileState): ApplyOutcome {
  const wrong = wrongPath('write_file', input['path'], file);
  if (wrong !== undefined) return wrong;
  const content = stringField(input, 'write_file', 'content');
  return typeof content === 'string' ? { kind: 'applied', after: content } : content;
}

const pathProperty = { type: 'string', description: 'File path relative to the workspace root.' } as const;

export const EDIT_FORMAT_SPECS: Readonly<Record<EditFormat, FormatSpec>> = {
  str_replace: {
    tool: {
      name: 'edit',
      description:
        "Change a file by replacing one exact piece of its text. Read the file first: edit refuses a file you have not read in this session, or one that changed since you last read it; read it again and retry. old_str must match the file exactly, including indentation and line breaks, and must appear exactly once; include enough surrounding lines to make it unique, or pass replace_all: true to change every place it appears, as for a rename. Copy old_str from what read showed you, without the line number and the tab before each line. To make a new file, or to replace the whole of a file you have read, pass create: true and the whole content as new_str. Call once per separate change. When the project has a check command, it runs after each successful edit and its result comes back with this one: fix what your change broke before you move on. Failures that were there before your change are not yours to fix unless the task asks.",
      input_schema: {
        type: 'object',
        properties: {
          path: pathProperty,
          old_str: { type: 'string', description: 'The exact text to replace. Omit when create is true.' },
          new_str: { type: 'string', description: 'The text that replaces old_str, or the whole content of the file.' },
          replace_all: { type: 'boolean', description: 'Replace every place old_str appears exactly, not just one. Defaults to false.' },
          create: { type: 'boolean', description: 'Write new_str as the whole file: a new file, or one you have read, which it replaces. Defaults to false.' },
        },
        required: ['path', 'new_str'],
        additionalProperties: false,
      },
    },
    instructions:
      'Make the change with the edit tool, one call per separate change. When every change is made, reply with one short sentence and no tool call.',
    apply: strReplaceEdit,
  },
  apply_patch: {
    tool: {
      name: 'apply_patch',
      description: [
        'Change files with a patch. The patch starts with "*** Begin Patch" and ends with "*** End Patch".',
        'Each file gets a section: "*** Update File: <path>", "*** Add File: <path>" or "*** Delete File: <path>".',
        'In an Update File section, each change starts with a line "@@ <an existing line just above the change>" (or a bare "@@"), followed by about three lines of unchanged context before and after the change.',
        'Context lines start with a space, removed lines with "-", added lines with "+". Copy context and removed lines exactly from the file, without line numbers.',
        'In an Add File section every line starts with "+".',
      ].join('\n'),
      input_schema: {
        type: 'object',
        properties: { patch: { type: 'string', description: 'The whole patch, from *** Begin Patch to *** End Patch.' } },
        required: ['patch'],
        additionalProperties: false,
      },
    },
    instructions:
      'Make the change with one apply_patch call that holds every change to the file. When it applies, reply with one short sentence and no tool call.',
    apply: applyPatchEdit,
  },
  whole_file: {
    tool: {
      name: 'write_file',
      description: 'Replace the whole content of a file, or make a new file. content is the complete new file, without line numbers.',
      input_schema: {
        type: 'object',
        properties: { path: pathProperty, content: { type: 'string', description: 'The complete new content of the file.' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    instructions:
      'Make the change with one write_file call that holds the complete new file. When it is written, reply with one short sentence and no tool call.',
    apply: wholeFileEdit,
  },
};

const isInput = (raw: unknown): raw is Input => typeof raw === 'object' && raw !== null && !Array.isArray(raw);

export type ProposeArgs = {
  readonly format: EditFormat;
  readonly raw: unknown;
  readonly path: string;
  readonly base: BaseRead;
  /** The file as it is now, from disk or an unsaved buffer. */
  readonly current: string | null;
  readonly turn: ProposedChange['turn'];
};

/** Resolves a model's edit against the current text. `after` is what to write, null when nothing may be written. */
export function proposeChange(args: ProposeArgs): { readonly change: ProposedChange; readonly after: string | null } {
  const { format, raw, path, base, current, turn } = args;
  const record = (result: ApplyResult, hunks: readonly Hunk[]): ProposedChange => ({
    turn,
    path,
    base,
    format,
    raw,
    hunks,
    result,
    check: null,
  });
  const fail = (reason: ApplyFailure, detail: string) => ({ change: record({ kind: 'failed', reason, detail }, []), after: null });
  if (hashText(current) !== base.hash) {
    return fail('stale-base', staleBaseDetail(path));
  }
  if (!isInput(raw)) return fail('parse-error', 'the tool input must be a JSON object');
  const outcome = EDIT_FORMAT_SPECS[format].apply(raw, { path, text: current });
  if (outcome.kind === 'failed') return fail(outcome.reason, outcome.detail);
  return { change: record({ kind: 'applied' }, hunksBetween(current ?? '', outcome.after)), after: outcome.after };
}

export function editPrompt(format: EditFormat, path: string, before: string, instruction: string): string {
  const lines = fileLines(before);
  return [
    `Change ${path} to carry out this instruction:`,
    '',
    instruction,
    '',
    `Here is ${path}, every line prefixed with its number and a tab that are not part of the file:`,
    '',
    lines.length === 0 ? '(the file is empty)' : numberLines(lines),
    '',
    `Edit only ${path}. ${EDIT_FORMAT_SPECS[format].instructions}`,
  ].join('\n');
}
