import { realpath } from 'node:fs/promises';
import * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import {
  BASE_HASH_META,
  hashText,
  STALE_BASE_ERROR,
  type DiagnosticsResponse,
  type Severity,
} from '@g-code/core';

const realOrSelf = (file: string): Promise<string> => realpath(file).catch(() => file);

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
 * Writes into the open buffer through a WorkspaceEdit, so the editor can undo it and the disk keeps its copy
 * until the user saves; a file with no open buffer is written to disk. A write whose base no longer matches fails.
 */
export async function writeTextFile({ path, content, _meta }: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
  const document = await openDocument(path);
  const current = document === undefined ? await diskText(path) : document.getText();
  const base = _meta?.[BASE_HASH_META];
  if (base !== undefined && hashText(current) !== base) throw stale(path);
  if (document === undefined) {
    await vscode.workspace.fs.writeFile(vscode.Uri.file(path), new TextEncoder().encode(content));
    return {};
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, document.validateRange(new vscode.Range(0, 0, document.lineCount, 0)), content);
  // applyEdit refuses an edit made against a document version that the user has since changed.
  if (!(await vscode.workspace.applyEdit(edit))) throw stale(path);
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
