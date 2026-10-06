import * as vscode from 'vscode';
import {
  hunkIdOf,
  locateSpan,
  REVIEW_METHOD,
  REWIND_METHOD,
  shiftSpan,
  spansIn,
  type FileChange,
  type HunkId,
  type HunkStatus,
  type ReviewDecision,
  type ReviewHunk,
  type ReviewRequest,
  type ReviewResponse,
  type RewindRequest,
  type RewindResponse,
  type Span,
  type CheckpointRef,
} from '@g-code/core';
import { editorUri } from '../chat/bridge.js';
import type { SessionLink } from '../chat/chat.js';
import type { ReviewMode } from './mode.js';

export const KEEP_COMMAND = 'gcode.review.keep';
export const UNDO_COMMAND = 'gcode.review.undo';
export const UNDO_TURN_COMMAND = 'gcode.review.undoTurn';
export const OPEN_CHANGE_COMMAND = 'gcode.review.openChange';

/**
 * A hunk under review. A pending hunk has a span: where its new text sits in the document, moved along with
 * every edit to the document, and `version`, the document version that span describes.
 */
export type Tracked = {
  readonly id: HunkId;
  readonly uri: vscode.Uri;
  readonly oldText: string;
  readonly newText: string;
  status: HunkStatus;
  span: Span;
  version: number;
};

/**
 * The review state of the session's edits: which hunks are pending, kept or undone, and where each pending one
 * is. Keep and undo apply here at once; the decision is then logged by the engine. In auto review it holds no
 * hunks, so no lens, decoration or Changes row shows, and a turn is undone whole from its checkpoint.
 */
export class ReviewController implements vscode.Disposable {
  private readonly hunks = new Map<HunkId, Tracked>();
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires whenever a hunk is added, moves, or changes status. */
  readonly onDidChange = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly link: () => Promise<SessionLink>,
    private readonly output: vscode.OutputChannel,
    private readonly mode: () => ReviewMode,
  ) {
    this.subscriptions = [this.changed, vscode.workspace.onDidChangeTextDocument((event) => this.moved(event))];
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  all(): readonly Tracked[] {
    return [...this.hunks.values()];
  }

  get(id: HunkId): Tracked | undefined {
    return this.hunks.get(id);
  }

  pendingIn(uri: vscode.Uri): Tracked[] {
    const key = uri.toString();
    return this.all()
      .filter((h) => h.status === 'pending' && h.uri.toString() === key)
      .sort((a, b) => a.span.start - b.span.start);
  }

  /** Puts an edit the engine just wrote under review. `document` already holds the change's result. */
  track(document: vscode.TextDocument, change: FileChange): void {
    if (this.mode() === 'auto') return;
    const spans = spansIn(document.getText(), change);
    change.hunks.forEach((hunk, i) => {
      const id = hunkIdOf(change, i);
      this.hunks.set(id, { id, uri: document.uri, oldText: hunk.oldText, newText: hunk.newText, status: 'pending', span: spans[i]!, version: document.version });
    });
    this.changed.fire();
  }

  /** Drops the review of the session the chat left, and rebuilds it for the one it moved to. */
  async reset(): Promise<void> {
    this.hunks.clear();
    this.changed.fire();
    await this.restore();
  }

  /** Rebuilds the review after a reload from the decisions the engine logged, finding each pending hunk's text again. */
  async restore(): Promise<void> {
    if (this.mode() === 'auto') return;
    const { hunks } = await this.request<ReviewResponse>(REVIEW_METHOD, (sessionId): ReviewRequest => ({ sessionId, decisions: [] }));
    for (const hunk of hunks) await this.restoreOne(hunk);
    this.changed.fire();
  }

  private async restoreOne(hunk: ReviewHunk): Promise<void> {
    const uri = await editorUri(hunk.path);
    const base = { id: hunk.id, uri, oldText: hunk.oldText, newText: hunk.newText, span: { start: 0, end: 0 }, version: 0 };
    if (hunk.status !== 'pending') {
      this.hunks.set(hunk.id, { ...base, status: hunk.status });
      return;
    }
    const document = await vscode.workspace.openTextDocument(uri).then(
      (d) => d,
      () => undefined,
    );
    const span = document === undefined ? undefined : locateSpan(document.getText(), hunk.newText, hunk.afterLine);
    if (document === undefined || span === undefined) {
      this.output.appendLine(`review: hunk ${hunk.id} in ${hunk.path} is no longer in the file; showing it as kept`);
      this.hunks.set(hunk.id, { ...base, status: 'kept' });
      return;
    }
    this.hunks.set(hunk.id, { ...base, status: 'pending', span, version: document.version });
  }

  async keep(ids: readonly HunkId[]): Promise<void> {
    const pending = ids.flatMap((id) => (this.hunks.get(id)?.status === 'pending' ? [this.hunks.get(id)!] : []));
    for (const hunk of pending) hunk.status = 'kept';
    await this.decided(pending);
  }

  /** Puts each hunk's old text back in its document, in one edit per document. */
  async undo(ids: readonly HunkId[]): Promise<void> {
    const pending = ids.flatMap((id) => (this.hunks.get(id)?.status === 'pending' ? [this.hunks.get(id)!] : []));
    const byDocument = new Map<string, Tracked[]>();
    for (const hunk of pending) byDocument.set(hunk.uri.toString(), [...(byDocument.get(hunk.uri.toString()) ?? []), hunk]);
    const undone: Tracked[] = [];
    try {
      for (const hunks of byDocument.values()) {
        const document = await vscode.workspace.openTextDocument(hunks[0]!.uri);
        const save = !document.isDirty;
        const edit = new vscode.WorkspaceEdit();
        for (const hunk of hunks) {
          edit.replace(document.uri, new vscode.Range(document.positionAt(hunk.span.start), document.positionAt(hunk.span.end)), hunk.oldText);
          hunk.status = 'undone';
        }
        if (!(await vscode.workspace.applyEdit(edit))) {
          for (const hunk of hunks) hunk.status = 'pending';
          throw new Error(`could not undo the hunk in ${vscode.workspace.asRelativePath(document.uri)}`);
        }
        undone.push(...hunks);
        if (save) await document.save();
      }
    } finally {
      // Files already undone stay undone in the log even when a later file fails.
      await this.decided(undone);
    }
  }

  /**
   * Undo all: restores the session's first checkpoint through the engine's rewind. Agent edits waiting unsaved
   * in a buffer are saved first, so the rewind sees them and the buffers reload from the restored disk.
   */
  async undoSession(): Promise<readonly string[]> {
    const touched = new Set(this.all().map((h) => h.uri.toString()));
    for (const document of vscode.workspace.textDocuments) {
      if (document.isDirty && touched.has(document.uri.toString())) await document.save();
    }
    const { files } = await this.request<RewindResponse>(REWIND_METHOD, (sessionId): RewindRequest => ({ sessionId }));
    for (const hunk of this.hunks.values()) hunk.status = 'undone';
    this.changed.fire();
    return files;
  }

  /** Restores the checkpoint before a turn through the engine's rewind, and returns every hunk with its status after it. */
  async undoTurn(checkpoint: CheckpointRef): Promise<readonly ReviewHunk[]> {
    await this.request<RewindResponse>(REWIND_METHOD, (sessionId): RewindRequest => ({ sessionId, ...checkpoint }));
    const { hunks } = await this.request<ReviewResponse>(REVIEW_METHOD, (sessionId): ReviewRequest => ({ sessionId, decisions: [] }));
    return hunks;
  }

  private async decided(hunks: readonly Tracked[]): Promise<void> {
    if (hunks.length === 0) return;
    this.changed.fire();
    const decisions: ReviewDecision[] = hunks.map((h) => ({ hunk: h.id, status: h.status }));
    await this.request<ReviewResponse>(REVIEW_METHOD, (sessionId): ReviewRequest => ({ sessionId, decisions }));
  }

  private async request<R>(method: string, params: (sessionId: string) => unknown): Promise<R> {
    const { connection, sessionId } = await this.link();
    return connection.agent.request<R, unknown>(method, params(sessionId));
  }

  private moved(event: vscode.TextDocumentChangeEvent): void {
    const key = event.document.uri.toString();
    const hunks = this.all().filter((h) => h.status === 'pending' && h.uri.toString() === key && h.version < event.document.version);
    if (hunks.length === 0 || event.contentChanges.length === 0) return;
    // Every change's offset is in the text before the event; applying the last first keeps the earlier offsets true.
    const changes = event.contentChanges.toSorted((a, b) => b.rangeOffset - a.rangeOffset);
    for (const hunk of hunks) {
      hunk.span = changes.reduce((span, c) => shiftSpan(span, { offset: c.rangeOffset, length: c.rangeLength, text: c.text }), hunk.span);
      hunk.version = event.document.version;
    }
    this.changed.fire();
  }
}
