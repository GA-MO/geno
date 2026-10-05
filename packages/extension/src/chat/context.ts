import type * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { SELECTION_LINES_META, type SelectionLines } from '@g-code/core';
import { mentionsIn, rankFiles, SELECTION, type MentionCompletion } from './mentions.js';

/** A listing of the workspace is reused this long while the user types one mention. */
const FILES_TTL_MS = 10_000;
const MAX_FILES = 20_000;
const MAX_COMPLETIONS = 20;

const folder = (): vscode.Uri | undefined => vscode.workspace.workspaceFolders?.[0]?.uri;

/** The active editor's selection as whole lines, or undefined when nothing in a file is selected. */
function selected(): { readonly document: vscode.TextDocument; readonly lines: SelectionLines } | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.selection.isEmpty || editor.document.uri.scheme !== 'file') return undefined;
  const { start, end } = editor.selection;
  // A selection that ends at the start of a line does not include that line.
  const last = end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
  return { document: editor.document, lines: { startLine: start.line + 1, endLine: last + 1 } };
}

/** Workspace files for `@file` completion, and the prompt blocks a message's mentions become. */
export class Mentions {
  private files: { readonly at: number; readonly list: Promise<string[]> } | undefined;

  private workspaceFiles(): Promise<string[]> {
    if (this.files === undefined || Date.now() - this.files.at > FILES_TTL_MS) {
      const list = Promise.resolve(vscode.workspace.findFiles('**/*', undefined, MAX_FILES)).then((uris) =>
        uris.map((uri) => vscode.workspace.asRelativePath(uri, false)),
      );
      this.files = { at: Date.now(), list };
      return list;
    }
    return this.files.list;
  }

  async completions(query: string): Promise<MentionCompletion[]> {
    const selection = selected();
    const offerSelection = selection !== undefined && SELECTION.startsWith(query.toLowerCase());
    const files = rankFiles(await this.workspaceFiles(), query, MAX_COMPLETIONS);
    return [
      ...(offerSelection
        ? [{ kind: 'selection' as const, label: SELECTION, detail: `${vscode.workspace.asRelativePath(selection.document.uri)}:${selection.lines.startLine}-${selection.lines.endLine}` }]
        : []),
      ...files.map((file) => ({ kind: 'file' as const, label: file, detail: file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '' })),
    ];
  }

  /**
   * The ACP blocks for the mentions in `text`: `@selection` as an embedded resource of the selected lines, and each
   * `@path` that names a workspace file as a resource link. An `@` word that is neither stays plain text.
   */
  async blocks(text: string): Promise<acp.ContentBlock[]> {
    const root = folder();
    const blocks: acp.ContentBlock[] = [];
    for (const label of mentionsIn(text)) {
      if (label === SELECTION) {
        const selection = selected();
        if (selection === undefined) continue;
        const { document, lines } = selection;
        const range = new vscode.Range(lines.startLine - 1, 0, lines.endLine - 1, document.lineAt(lines.endLine - 1).range.end.character);
        blocks.push({ type: 'resource', resource: { uri: document.uri.toString(), text: document.getText(range) }, _meta: { [SELECTION_LINES_META]: lines } });
        continue;
      }
      if (root === undefined) continue;
      const uri = vscode.Uri.joinPath(root, ...label.split('/'));
      const isFile = await vscode.workspace.fs.stat(uri).then((s) => (s.type & vscode.FileType.File) !== 0, () => false);
      if (isFile) blocks.push({ type: 'resource_link', uri: uri.toString(), name: label });
    }
    return blocks;
  }
}
