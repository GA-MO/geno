import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ApprovalMode } from './approval.js';
import type { TurnEvent } from './session.js';
import { startsTurn } from './steer.js';

/**
 * Tools that point the user at something in the editor: open a file at a line, show a file's diff against a
 * checkpoint, reveal a path in the Explorer. They change what the user sees and never a file, so every interactive
 * mode offers them without asking, and only a client that advertises EDITOR_ACTIONS_CAPABILITY gets them.
 */
export const EDITOR_ACTION_TOOLS = ['open_file', 'reveal', 'show_diff'] as const;
export type EditorActionTool = (typeof EDITOR_ACTION_TOOLS)[number];

/** Key in the client's capabilities `_meta`: true when it carries out editor actions. */
export const EDITOR_ACTIONS_CAPABILITY = 'gcode/editor-actions';
/** Extension method, sent by the engine: carry out one EditorAction in the editor showing the session. */
export const EDITOR_ACTION_METHOD = '_gcode/editorAction';
/** Key in a tool_call_update's `_meta`: the EditorAction the call carried out, so its step can repeat it. */
export const EDITOR_ACTION_META = 'gcode/editor-action';

/** Which checkpoint a diff's left side is: the one before the current turn, or the session's first. */
export type DiffBase = { readonly sha: string; readonly since: 'turn' | 'session' };

/** What the editor is asked to do. Paths are absolute and real; lines and columns count from 1. */
export type EditorAction =
  | { readonly kind: 'open'; readonly path: string; readonly line?: number | undefined; readonly column?: number | undefined }
  | { readonly kind: 'diff'; readonly path: string; readonly base: DiffBase }
  | { readonly kind: 'reveal'; readonly path: string };

export type EditorActionRequest = { readonly sessionId: string; readonly action: EditorAction };

export const EDITOR_ACTION_MODES: Readonly<Record<ApprovalMode, boolean>> = { plan: true, ask: true, auto: true, 'non-interactive': false };

const PATH = { type: 'string', description: 'Relative to the workspace root, or absolute inside it.' } as const;

export const EDITOR_ACTION_SPECS: Readonly<Record<EditorActionTool, Tool>> = {
  open_file: {
    name: 'open_file',
    description:
      'Open a file in the user\'s editor and scroll to a line, to point them at the code you are talking about, such as where something is defined. It changes nothing. Pass the line as read shows it, counting from 1.',
    input_schema: {
      type: 'object',
      properties: {
        path: PATH,
        line: { type: 'integer', minimum: 1, description: 'The line to put the cursor on, from 1.' },
        column: { type: 'integer', minimum: 1, description: 'The column on that line, from 1.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  reveal: {
    name: 'reveal',
    description: 'Select a file or folder in the user\'s Explorer, to show them where it is. It changes nothing.',
    input_schema: { type: 'object', properties: { path: PATH }, required: ['path'], additionalProperties: false },
  },
  show_diff: {
    name: 'show_diff',
    description:
      'Open the editor\'s diff view of a file: as it was before this turn on the left, as it is now on the right. If this turn did not change the file, the left side is the file when the session began. It changes nothing.',
    input_schema: { type: 'object', properties: { path: PATH }, required: ['path'], additionalProperties: false },
  },
};

/** The editor tools a run offers: none unless the mode allows them and an editor carries them out. Sorted, for a stable prefix. */
export const editorActionToolDefinitions = (mode: ApprovalMode, attached: boolean): readonly Tool[] =>
  attached && EDITOR_ACTION_MODES[mode] ? EDITOR_ACTION_TOOLS.map((name) => EDITOR_ACTION_SPECS[name]) : [];

type CheckpointEvent = Extract<TurnEvent, { kind: 'checkpoint' }>;
const isCheckpoint = (event: TurnEvent): event is CheckpointEvent => event.kind === 'checkpoint';

/** The checkpoints a diff can start from: the first one after the latest prompt, and the session's first. */
export function diffBases(events: readonly TurnEvent[]): { readonly turn: CheckpointEvent | undefined; readonly session: CheckpointEvent | undefined } {
  return { turn: events.slice(events.findLastIndex(startsTurn) + 1).find(isCheckpoint), session: events.find(isCheckpoint) };
}
