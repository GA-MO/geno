import * as vscode from 'vscode';
import { HUNK_STATUSES, type HunkStatus } from '@g-code/core';
import type { ReviewController, Tracked } from './controller.js';
import { anchorLine } from './editor.js';

export const CHANGES_VIEW = 'gcode.changes';
export const REVEAL_COMMAND = 'gcode.review.reveal';

/** A changed file, or one hunk of it. */
export type ChangeNode = vscode.Uri | Tracked;

const isFile = (node: ChangeNode): node is vscode.Uri => node instanceof vscode.Uri;

const STATUS_ICONS: Readonly<Record<HunkStatus, vscode.ThemeIcon>> = {
  pending: new vscode.ThemeIcon('circle-outline'),
  kept: new vscode.ThemeIcon('check'),
  undone: new vscode.ThemeIcon('discard'),
};

const firstLine = (text: string): string => text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';

function counts(hunks: readonly Tracked[]): string {
  return HUNK_STATUSES.flatMap((status) => {
    const n = hunks.filter((h) => h.status === status).length;
    return n === 0 ? [] : [`${n} ${status}`];
  }).join(' · ');
}

/** Every file the session's edits touched, with its hunks and what was decided about them. */
export class ChangesView implements vscode.TreeDataProvider<ChangeNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly review: ReviewController) {
    this.subscription = review.onDidChange(() => this.changed.fire());
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }

  /** The files in the order the session first changed them. */
  files(): vscode.Uri[] {
    const seen = new Map<string, vscode.Uri>();
    for (const hunk of this.review.all()) if (!seen.has(hunk.uri.toString())) seen.set(hunk.uri.toString(), hunk.uri);
    return [...seen.values()];
  }

  private hunksOf(uri: vscode.Uri): Tracked[] {
    return this.review.all().filter((h) => h.uri.toString() === uri.toString());
  }

  getChildren(node?: ChangeNode): ChangeNode[] {
    if (node === undefined) return this.files();
    return isFile(node) ? this.hunksOf(node) : [];
  }

  getTreeItem(node: ChangeNode): vscode.TreeItem {
    if (isFile(node)) {
      const hunks = this.hunksOf(node);
      const pending = hunks.some((h) => h.status === 'pending');
      const item = new vscode.TreeItem(node, pending ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.description = counts(hunks);
      item.contextValue = pending ? 'file-pending' : 'file';
      item.command = { title: 'Open', command: 'vscode.open', arguments: [node] };
      return item;
    }
    const removed = node.newText === '';
    const item = new vscode.TreeItem(removed ? `− ${firstLine(node.oldText)}` : `+ ${firstLine(node.newText)}`);
    const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === node.uri.toString());
    item.description = node.status === 'pending' && document !== undefined ? `line ${anchorLine(document, node) + 1}` : node.status;
    item.iconPath = STATUS_ICONS[node.status];
    item.contextValue = `hunk-${node.status}`;
    item.command = { title: 'Show', command: REVEAL_COMMAND, arguments: [node.id] };
    return item;
  }
}
