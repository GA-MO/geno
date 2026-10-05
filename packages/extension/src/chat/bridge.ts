import { realpath } from 'node:fs/promises';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import {
  BASE_HASH_META,
  changeOf,
  hashText,
  STALE_BASE_ERROR,
  type DiagnosticsResponse,
  type FileChange,
  type Severity,
} from '@g-code/core';

export const realOrSelf = (file: string): Promise<string> => realpath(file).catch(() => file);

/** The open document for an absolute path from the engine, which resolves symlinks (on macOS, /var is /private/var). */
async function openDocument(file: string): Promise<vscode.TextDocument | undefined> {
  for (const document of vscode.workspace.textDocuments) {
    if (document.uri.scheme === 'file' && !document.isClosed && (await realOrSelf(document.uri.fsPath)) === file) return document;
  }
  return undefined;
}

async function diskText(file: string): Promise<string | null> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(file)));
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return null;
    throw error;
  }
}

/** What the engine should see of a file: the open buffer with its unsaved edits, else the disk. */
const currentText = async (file: string): Promise<string | null> => (await openDocument(file))?.getText() ?? diskText(file);

function slice(text: string, line: number | null | undefined, limit: number | null | undefined): string {
  if (line == null && limit == null) return text;
  const start = (line ?? 1) - 1;
  return text
    .split('\n')
    .slice(start, limit == null ? undefined : start + limit)
    .join('\n');
}

export async function readTextFile({ path, line, limit }: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
  const text = await currentText(path);
  if (text === null) throw acp.RequestError.resourceNotFound(path);
  return { content: slice(text, line, limit) };
}

const stale = (path: string) =>
  new acp.RequestError(STALE_BASE_ERROR.code, `${path} changed since the engine read it`, { reason: STALE_BASE_ERROR.reason });

/**
 * The editor's URI for an absolute path from the engine. Inside a workspace folder it is built on the folder's
 * URI, so a file the engine names by its real path opens as the same document the user has open.
 */
export async function editorUri(file: string): Promise<vscode.Uri> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const relative = path.relative(await realOrSelf(folder.uri.fsPath), file);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) return vscode.Uri.joinPath(folder.uri, ...relative.split(path.sep));
  }
  return vscode.Uri.file(file);
}

/**
 * Writes an edit hunk by hunk through a WorkspaceEdit, so the editor can undo it and hunks under review keep
 * their places. An open buffer with unsaved changes stays unsaved; any other file is saved, so the disk, which
 * checkpoints snapshot, holds the agent's edits. A write whose base no longer matches fails.
 */
export async function writeTextFile(
  { path: file, content, _meta }: acp.WriteTextFileRequest,
  onWrite: (document: vscode.TextDocument, change: FileChange) => void,
): Promise<acp.WriteTextFileResponse> {
  const open = await openDocument(file);
  const current = open === undefined ? await diskText(file) : open.getText();
  const base = _meta?.[BASE_HASH_META];
  if (base !== undefined && hashText(current) !== base) throw stale(file);
  const uri = open?.uri ?? (await editorUri(file));
  const change = changeOf(file, current ?? '', content);
  if (current === null) {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
    onWrite(await vscode.workspace.openTextDocument(uri), change);
    return {};
  }
  const document = open ?? (await vscode.workspace.openTextDocument(uri));
  const save = !document.isDirty;
  const edit = new vscode.WorkspaceEdit();
  for (const hunk of change.hunks) {
    const start = hunk.startLine - 1;
    edit.replace(uri, document.validateRange(new vscode.Range(start, 0, start + hunk.lineCount, 0)), hunk.newText);
  }
  // A refused edit most likely met a document the user changed in the meantime, so it is reported as stale.
  if (!(await vscode.workspace.applyEdit(edit))) throw stale(file);
  onWrite(document, change);
  if (save) await document.save();
  return {};
}

const SEVERITY: Readonly<Record<vscode.DiagnosticSeverity, Severity>> = {
  [vscode.DiagnosticSeverity.Error]: 'error',
  [vscode.DiagnosticSeverity.Warning]: 'warning',
  [vscode.DiagnosticSeverity.Information]: 'information',
  [vscode.DiagnosticSeverity.Hint]: 'hint',
};

export async function diagnostics(paths: readonly string[]): Promise<DiagnosticsResponse> {
  const perFile = await Promise.all(
    paths.map(async (path) => {
      const uri = (await openDocument(path))?.uri ?? vscode.Uri.file(path);
      return vscode.languages.getDiagnostics(uri).map((d) => ({
        path,
        line: d.range.start.line + 1,
        character: d.range.start.character + 1,
        severity: SEVERITY[d.severity],
        message: d.message,
        source: d.source ?? null,
      }));
    }),
  );
  return { diagnostics: perFile.flat() };
}
