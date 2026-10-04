import * as vscode from 'vscode';
import { MAX_HISTORY, recordChange, type EditHistoryEntry } from '@g-code/core/tab';

const tracked = (document: vscode.TextDocument): boolean => document.uri.scheme === 'file';

/**
 * The workspace's recent edits, newest last. A change event carries the new text but not the text it replaced, so
 * each open document's last known text is kept to diff against.
 */
export class EditHistoryTracker implements vscode.Disposable {
  #history: EditHistoryEntry[] = [];
  readonly #snapshots = new Map<string, string>();
  readonly #disposables: vscode.Disposable[];

  constructor(private readonly limit: number = MAX_HISTORY) {
    for (const document of vscode.workspace.textDocuments) this.#remember(document);
    this.#disposables = [
      vscode.workspace.onDidOpenTextDocument((d) => this.#remember(d)),
      vscode.workspace.onDidCloseTextDocument((d) => this.#snapshots.delete(d.uri.toString())),
      vscode.workspace.onDidChangeTextDocument((e) => this.#onChange(e)),
    ];
  }

  get history(): readonly EditHistoryEntry[] {
    return this.#history;
  }

  #remember(document: vscode.TextDocument): void {
    if (tracked(document)) this.#snapshots.set(document.uri.toString(), document.getText());
  }

  #onChange(event: vscode.TextDocumentChangeEvent): void {
    const { document } = event;
    if (!tracked(document) || event.contentChanges.length === 0) return;
    const key = document.uri.toString();
    const before = this.#snapshots.get(key);
    const after = document.getText();
    this.#snapshots.set(key, after);
    if (before === undefined) return;
    const path = vscode.workspace.asRelativePath(document.uri);
    this.#history = recordChange(this.#history, { path, at: new Date().toISOString(), before, after }, this.limit);
  }

  dispose(): void {
    for (const d of this.#disposables) d.dispose();
  }
}
