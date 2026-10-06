import * as vscode from 'vscode';
import { z } from 'zod';
import { EDITOR_ACTION_META, type EditorAction, type EditorActionRequest } from '@g-code/core';
import { openCheckpointDiff } from '../review/checkpoint.js';

const position = z.number().int().positive();

const editorAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('open'), path: z.string().min(1), line: position.optional(), column: position.optional() }),
  z.object({ kind: z.literal('diff'), path: z.string().min(1), base: z.object({ sha: z.string().min(1), since: z.enum(['turn', 'session']) }) }),
  z.object({ kind: z.literal('reveal'), path: z.string().min(1) }),
]) satisfies z.ZodType<EditorAction>;

export const editorActionRequest = z.object({ sessionId: z.string(), action: editorAction }) satisfies z.ZodType<EditorActionRequest>;

/** The action a tool call's closing update says it carried out, if any. */
export function editorActionOf(meta: Record<string, unknown> | null | undefined): EditorAction | undefined {
  const parsed = editorAction.safeParse(meta?.[EDITOR_ACTION_META]);
  return parsed.success ? parsed.data : undefined;
}

const RUN: { readonly [K in EditorAction['kind']]: (action: Extract<EditorAction, { kind: K }>) => Thenable<unknown> } = {
  async open({ path, line, column }) {
    const at = new vscode.Position(Math.max(0, (line ?? 1) - 1), Math.max(0, (column ?? 1) - 1));
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: false, selection: new vscode.Range(at, at) });
    editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  },
  diff: ({ path, base }) => openCheckpointDiff(vscode.Uri.file(path), base),
  reveal: ({ path }) => vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(path)),
};

/** Shows what the model pointed at, live from the engine or again from a step. It never changes a file. */
export const runEditorAction = (action: EditorAction): Thenable<unknown> => (RUN[action.kind] as (a: EditorAction) => Thenable<unknown>)(action);
