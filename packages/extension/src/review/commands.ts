import * as vscode from 'vscode';
import type { HunkId, InlineEditTarget } from '@g-code/core';
import { realOrSelf } from '../chat/bridge.js';
import type { Chat } from '../chat/chat.js';
import { CheckpointDocuments, CHECKPOINT_SCHEME, openDiff } from './checkpoint.js';
import { KEEP_COMMAND, ReviewController, UNDO_COMMAND, type Tracked } from './controller.js';
import { REVIEW_DOCUMENTS, ReviewDecorations, ReviewLenses } from './editor.js';
import { CHANGES_VIEW, ChangesView, REVEAL_COMMAND } from './tree.js';

export const KEEP_FILE_COMMAND = 'gcode.review.keepFile';
export const UNDO_FILE_COMMAND = 'gcode.review.undoFile';
export const UNDO_SESSION_COMMAND = 'gcode.review.undoSession';
export const OPEN_DIFF_COMMAND = 'gcode.review.openDiff';
export const INLINE_EDIT_COMMAND = 'gcode.inlineEdit';

const idOf = (node: HunkId | Tracked): HunkId => (typeof node === 'string' ? node : node.id);

/** Whole lines, counted from 1: a selection that ends at the start of a line does not take that line. */
export async function selectionTarget(editor: vscode.TextEditor): Promise<InlineEditTarget> {
  const { start, end } = editor.selection;
  const endLine = end.character === 0 && end.line > start.line ? end.line : end.line + 1;
  return { path: await realOrSelf(editor.document.uri.fsPath), startLine: start.line + 1, endLine };
}

function fileOf(uri: vscode.Uri | undefined): vscode.Uri {
  const file = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (file === undefined) throw new Error('open a file with changes to review first');
  return file;
}

/** The review surfaces over the chat's session: hunk controls in the editor, the changed-files view, diffs against the checkpoint, and Cmd-K. */
export function registerReview(context: vscode.ExtensionContext, chat: Chat, review: ReviewController, output: vscode.OutputChannel): void {
  const view = new ChangesView(review);
  const lenses = new ReviewLenses(review);
  context.subscriptions.push(
    review,
    view,
    lenses,
    new ReviewDecorations(review, context.extensionUri),
    vscode.languages.registerCodeLensProvider(REVIEW_DOCUMENTS, lenses),
    vscode.window.createTreeView(CHANGES_VIEW, { treeDataProvider: view, showCollapseAll: true }),
    vscode.workspace.registerTextDocumentContentProvider(CHECKPOINT_SCHEME, new CheckpointDocuments(() => chat.link())),
    vscode.commands.registerCommand(KEEP_COMMAND, (node: HunkId | Tracked) => review.keep([idOf(node)])),
    vscode.commands.registerCommand(UNDO_COMMAND, (node: HunkId | Tracked) => review.undo([idOf(node)])),
    vscode.commands.registerCommand(KEEP_FILE_COMMAND, (uri?: vscode.Uri) => review.keep(review.pendingIn(fileOf(uri)).map((h) => h.id))),
    vscode.commands.registerCommand(UNDO_FILE_COMMAND, (uri?: vscode.Uri) => review.undo(review.pendingIn(fileOf(uri)).map((h) => h.id))),
    vscode.commands.registerCommand(UNDO_SESSION_COMMAND, () => review.undoSession()),
    vscode.commands.registerCommand(OPEN_DIFF_COMMAND, (uri?: vscode.Uri) => openDiff(fileOf(uri))),
    vscode.commands.registerCommand(REVEAL_COMMAND, async (id: HunkId) => {
      const hunk = review.get(id);
      if (hunk === undefined) return;
      const editor = await vscode.window.showTextDocument(hunk.uri);
      if (hunk.status !== 'pending') return;
      const start = editor.document.positionAt(hunk.span.start);
      editor.selection = new vscode.Selection(start, start);
      editor.revealRange(new vscode.Range(start, editor.document.positionAt(hunk.span.end)), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }),
    vscode.commands.registerCommand(INLINE_EDIT_COMMAND, async (given?: string) => {
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined || editor.document.uri.scheme !== 'file') throw new Error('Cmd-K edits a selection in a file on disk');
      const target = await selectionTarget(editor);
      const instruction = given ?? (await vscode.window.showInputBox({ prompt: 'Edit the selection', placeHolder: 'What should change?' }));
      return instruction === undefined || instruction.trim() === '' ? undefined : chat.inlineEdit(target, instruction.trim(), editor.document.uri);
    }),
  );
  void chat
    .storedSession()
    .then((stored) => (stored === undefined ? undefined : review.restore()))
    .catch((error: unknown) => output.appendLine(`review: could not restore the last session: ${String(error)}`));
}
