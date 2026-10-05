import * as vscode from 'vscode';
import { KEEP_COMMAND, UNDO_COMMAND, type ReviewController, type Tracked } from './controller.js';

/** Review controls appear only in files on disk: agent edits never land anywhere else. */
export const REVIEW_DOCUMENTS: vscode.DocumentSelector = [{ scheme: 'file' }];

/** The whole lines a hunk's new text covers, or undefined for a pure deletion. */
function addedLines(document: vscode.TextDocument, hunk: Tracked): vscode.Range | undefined {
  if (hunk.span.end === hunk.span.start) return undefined;
  const start = document.positionAt(hunk.span.start);
  const end = document.positionAt(hunk.span.end);
  const last = end.character === 0 ? end.line - 1 : end.line;
  return new vscode.Range(start.line, 0, Math.max(start.line, last), 0);
}

/** The line that carries the hunk's controls and its removed-lines marker. */
export const anchorLine = (document: vscode.TextDocument, hunk: Tracked): number =>
  Math.min(document.positionAt(hunk.span.start).line, document.lineCount - 1);

const removedHover = (hunk: Tracked): vscode.MarkdownString =>
  new vscode.MarkdownString().appendMarkdown('**Removed by Geno**').appendCodeblock(hunk.oldText.replace(/\n$/, ''));

/** Background on added lines and a gutter marker where lines were removed, for every pending hunk in view. */
export class ReviewDecorations implements vscode.Disposable {
  private readonly added: vscode.TextEditorDecorationType;
  private readonly removed: vscode.TextEditorDecorationType;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly review: ReviewController,
    extensionUri: vscode.Uri,
  ) {
    this.added = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.removed = vscode.window.createTextEditorDecorationType({
      gutterIconPath: vscode.Uri.joinPath(extensionUri, 'media', 'removed.svg'),
      gutterIconSize: 'contain',
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
    this.subscriptions = [
      this.added,
      this.removed,
      review.onDidChange(() => this.refresh()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
    ];
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  private refresh(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const hunks = this.review.pendingIn(editor.document.uri);
      editor.setDecorations(
        this.added,
        hunks.flatMap((h) => addedLines(editor.document, h) ?? []),
      );
      editor.setDecorations(
        this.removed,
        hunks
          .filter((h) => h.oldText !== '')
          .map((h) => ({ range: new vscode.Range(anchorLine(editor.document, h), 0, anchorLine(editor.document, h), 0), hoverMessage: removedHover(h) })),
      );
    }
  }
}

/** `Keep` and `Undo` above each pending hunk. */
export class ReviewLenses implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly review: ReviewController) {
    this.subscription = review.onDidChange(() => this.changed.fire());
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    return this.review.pendingIn(document.uri).flatMap((hunk) => {
      const range = new vscode.Range(anchorLine(document, hunk), 0, anchorLine(document, hunk), 0);
      return [
        new vscode.CodeLens(range, { title: 'Keep', command: KEEP_COMMAND, arguments: [hunk.id] }),
        new vscode.CodeLens(range, { title: 'Undo', command: UNDO_COMMAND, arguments: [hunk.id] }),
      ];
    });
  }
}
