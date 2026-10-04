import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';

const logFile = () => path.join(process.env['GCODE_HOME']!, 'tab-events.jsonl');

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const logLines = async (): Promise<{ kind: string; request?: { outcome: { kind: string }; text: string } }[]> => {
  try {
    return (await readFile(logFile(), 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders![0]!.uri;
  const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, 'math.ts'));
  const editor = await vscode.window.showTextDocument(document);
  const line = document.lineAt(1);
  editor.selection = new vscode.Selection(line.range.end, line.range.end);

  const shown = await waitFor('a shown completion in the log', async () => {
    await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    await new Promise((r) => setTimeout(r, 300));
    return (await logLines()).find((e) => e.kind === 'request' && e.request?.outcome.kind === 'shown')?.request;
  });

  await vscode.commands.executeCommand('editor.action.inlineSuggest.commit');
  await waitFor('the ghost text to be inserted', async () =>
    document.lineAt(1).text.endsWith(shown.text) ? true : undefined,
  );
  await waitFor('the accepted outcome in the log', async () =>
    (await logLines()).some((e) => e.kind === 'outcome') ? true : undefined,
  );
}
