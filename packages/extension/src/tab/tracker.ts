import * as vscode from 'vscode';
import { classifyEdit, type CompletionId, type Outcome, type ShownCompletion } from '@g-code/core/tab';
import type { TabLog } from './log.js';

export const ACCEPT_COMMAND = 'gcode.tab.accepted';
const PERSIST_AFTER_MS = 5 * 60 * 1000;

type Pending = { readonly id: CompletionId; readonly shown: ShownCompletion };

/**
 * Settles shown completions from what the stable API lets an extension see: the accept command attached to the
 * item, and the next edit to the document. One completion is tracked per document, the one shown last.
 */
export class OutcomeTracker implements vscode.Disposable {
  readonly #pending = new Map<string, Pending>();
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly #disposables: vscode.Disposable[];

  constructor(
    private readonly log: TabLog,
    private readonly persistAfterMs: number = PERSIST_AFTER_MS,
  ) {
    this.#disposables = [vscode.workspace.onDidChangeTextDocument((e) => this.#onChange(e))];
  }

  /** The completion this document still shows at `offset`, if typing has kept it alive. */
  showing(uri: vscode.Uri, offset: number): Pending | undefined {
    const pending = this.#pending.get(uri.toString());
    return pending?.shown.offset === offset ? pending : undefined;
  }

  shown(uri: vscode.Uri, id: CompletionId, shown: ShownCompletion): void {
    const key = uri.toString();
    const previous = this.#pending.get(key);
    if (previous !== undefined && previous.id !== id) this.#settle(previous.id, { kind: 'rejected' });
    this.#pending.set(key, { id, shown });
  }

  accepted(uri: vscode.Uri, id: CompletionId, text: string): void {
    if (this.#pending.get(uri.toString())?.id === id) this.#pending.delete(uri.toString());
    this.#settle(id, { kind: 'accepted' });
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      void this.#checkPersisted(uri, id, text);
    }, this.persistAfterMs);
    this.#timers.add(timer);
  }

  async #checkPersisted(uri: vscode.Uri, id: CompletionId, text: string): Promise<void> {
    let persisted: boolean;
    try {
      persisted = (await vscode.workspace.openTextDocument(uri)).getText().includes(text);
    } catch {
      persisted = false;
    }
    this.log({ kind: 'persisted', id, at: new Date().toISOString(), persisted });
  }

  #settle(id: CompletionId, outcome: Outcome): void {
    this.log({ kind: 'outcome', id, at: new Date().toISOString(), outcome });
  }

  #onChange(event: vscode.TextDocumentChangeEvent): void {
    const key = event.document.uri.toString();
    const pending = this.#pending.get(key);
    if (pending === undefined || event.contentChanges.length === 0) return;
    const [change, ...more] = event.contentChanges;
    const verdict =
      more.length > 0
        ? ({ kind: 'settled', outcome: 'rejected' } as const)
        : classifyEdit(pending.shown, { offset: change!.rangeOffset, removed: change!.rangeLength, inserted: change!.text });
    if (verdict.kind === 'pending') {
      this.#pending.set(key, { id: pending.id, shown: verdict.shown });
      return;
    }
    this.#pending.delete(key);
    if (verdict.kind === 'settled') this.#settle(pending.id, { kind: verdict.outcome });
  }

  dispose(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    for (const d of this.#disposables) d.dispose();
  }
}
