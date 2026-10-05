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
export const SHOW_CHANGES_SETTING = 'gcode.ui.showChanges';

/** The CodeLens and the Changes view pass one hunk; the chat panel passes a list. */
const idsOf = (node: HunkId | Tracked | readonly HunkId[]): HunkId[] => (typeof node === 'string' ? [node] : Array.isArray(node) ? [...node] : [(node as Tracked).id]);

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

/** The review surfaces over the chat's session: hunk controls in the editor, the changed-files view when shown, diffs against the checkpoint, and Cmd-K. */
/**
 * The Changes view, kept for later behind `gcode.ui.showChanges`: Source Control already lists changed files.
 * It exists only while the setting is on, and comes and goes as the setting changes.
 */
function registerChangesView(context: vscode.ExtensionContext, review: ReviewController): void {
  let shown: vscode.Disposable | undefined;
  const sync = () => {
    const on = vscode.workspace.getConfiguration('gcode').get<boolean>('ui.showChanges') === true;
    if (on && shown === undefined) {
      const view = new ChangesView(review);
      shown = vscode.Disposable.from(view, vscode.window.createTreeView(CHANGES_VIEW, { treeDataProvider: view, showCollapseAll: true }));
    } else if (!on && shown !== undefined) {
      shown.dispose();
      shown = undefined;
    }
  };
  sync();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(SHOW_CHANGES_SETTING)) sync();
    }),
    { dispose: () => shown?.dispose() },
  );
}

export function registerReview(context: vscode.ExtensionContext, chat: Chat, review: ReviewController, output: vscode.OutputChannel): void {
  const lenses = new ReviewLenses(review);
  registerChangesView(context, review);
  context.subscriptions.push(
    review,
    lenses,
    new ReviewDecorations(review, context.extensionUri),
    vscode.languages.registerCodeLensProvider(REVIEW_DOCUMENTS, lenses),
    vscode.workspace.registerTextDocumentContentProvider(CHECKPOINT_SCHEME, new CheckpointDocuments(() => chat.link())),
    vscode.commands.registerCommand(KEEP_COMMAND, (node: HunkId | Tracked | readonly HunkId[]) => review.keep(idsOf(node))),
    vscode.commands.registerCommand(UNDO_COMMAND, (node: HunkId | Tracked | readonly HunkId[]) => review.undo(idsOf(node))),
    vscode.commands.registerCommand(KEEP_FILE_COMMAND, (uri?: vscode.Uri) => review.keep(review.pendingIn(fileOf(uri)).map((h) => h.id))),
    vscode.commands.registerCommand(UNDO_FILE_COMMAND, (uri?: vscode.Uri) => review.undo(review.pendingIn(fileOf(uri)).map((h) => h.id))),
    vscode.commands.registerCommand(UNDO_SESSION_COMMAND, async (confirmed?: boolean) => {
      // The rewind restores the whole workspace, including files the user changed or created by hand since the session began.
      const answer = confirmed === true ? 'Undo All' : await vscode.window.showWarningMessage(
        'Undo every change since this Geno session began?',
        { modal: true, detail: 'Every file in the workspace goes back to the session\'s first checkpoint, your own edits included, and files created since are deleted.' },
        'Undo All',
      );
      return answer === 'Undo All' ? review.undoSession() : undefined;
    }),
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
