import * as vscode from 'vscode';
import type { EditorAction } from '@g-code/core';
import { openCheckpointDiff } from '../review/checkpoint.js';
import { editorUri } from './bridge.js';

const RUN: { readonly [K in EditorAction['kind']]: (action: Extract<EditorAction, { kind: K }>) => Thenable<unknown> } = {
  async open({ path, line, column }) {
    const at = new vscode.Position(Math.max(0, (line ?? 1) - 1), Math.max(0, (column ?? 1) - 1));
    const editor = await vscode.window.showTextDocument(await editorUri(path), { preview: false, selection: new vscode.Range(at, at) });
    editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  },
  diff: async ({ path, base }) => openCheckpointDiff(await editorUri(path), base),
  reveal: async ({ path }) => vscode.commands.executeCommand('revealInExplorer', await editorUri(path)),
};

/**
 * Shows what the model pointed at, live from the engine or again from a step. It never changes a file. The engine
 * names real paths, so each goes through the workspace folder's URI to land on the document the user has open.
 */
export const runEditorAction = (action: EditorAction): Thenable<unknown> => (RUN[action.kind] as (a: EditorAction) => Thenable<unknown>)(action);
