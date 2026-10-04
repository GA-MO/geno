import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';

type Line = { kind: string; id?: string; outcome?: { kind: string }; request?: { id: string; kind: string; outcome: { kind: string } } };

const logLines = async (): Promise<Line[]> => {
  try {
    const text = await readFile(path.join(process.env['GCODE_HOME']!, 'tab-events.jsonl'), 'utf8');
    return text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** VS Code can open its chat panel at startup and move focus into its input box, so put focus back each time. */
async function focus(document: vscode.TextDocument): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.window.showTextDocument(document, { preserveFocus: false });
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
}

export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders![0]!.uri;
  const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, 'stats.ts'));
  const editor = await vscode.window.showTextDocument(document);
  const name = new vscode.Range(0, 'export function '.length, 0, 'export function total'.length);

  await editor.edit((e) => e.delete(name));
  await editor.edit((e) => e.insert(name.start, 'sumOf'));
  const cursor = name.start.translate(0, 'sumOf'.length);
  editor.selection = new vscode.Selection(cursor, cursor);

  await waitFor('a shown next edit in the log', async () => {
    await focus(document);
    await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    await new Promise((r) => setTimeout(r, 300));
    return (await logLines()).find((e) => e.request?.kind === 'next-edit' && e.request.outcome.kind === 'shown')?.request;
  });

  // An edit away from the cursor takes two accepts: the first jumps to it, the second applies it.
  await waitFor('the inline edit applied at the call site', async () => {
    if (document.lineAt(6).text.includes('sumOf(items)')) return true;
    await focus(document);
    await vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
    await new Promise((r) => setTimeout(r, 300));
    return undefined;
  });
  if (document.lineAt(0).text !== 'export function sumOf(items: number[]): number {') {
    throw new Error(`the edit landed in the wrong place: ${document.getText()}`);
  }
  await waitFor('an accepted outcome in the log', async () =>
    (await logLines()).some((e) => e.kind === 'outcome' && e.outcome?.kind === 'accepted')
      ? true
      : undefined,
  );
}
