import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { TAB_DOCUMENTS } from '../../src/tab/documents.js';

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

// Editors that are not files, such as the chat input box, must never get Tab completions.
async function assertTabSkipsNonFileEditors(fileDocument: vscode.TextDocument): Promise<void> {
  const scheme = 'gcode-test';
  const registration = vscode.workspace.registerTextDocumentContentProvider(scheme, { provideTextDocumentContent: () => 'x' });
  try {
    const virtual = await vscode.workspace.openTextDocument(vscode.Uri.parse(`${scheme}:/virtual.ts`));
    if (vscode.languages.match(TAB_DOCUMENTS, virtual) > 0) throw new Error(`Tab matches a ${scheme}: document`);
    if (vscode.languages.match(TAB_DOCUMENTS, fileDocument) === 0) throw new Error('Tab does not match a file document');
  } finally {
    registration.dispose();
  }
}

export function run(): Promise<void> {
  return completeIn('math.ts');
}

/** Opens `file`, whose second line ends where the completion goes, and accepts the ghost text shown there. */
export async function completeIn(file: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders![0]!.uri;
  const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, file));
  await assertTabSkipsNonFileEditors(document);
  const editor = await vscode.window.showTextDocument(document);
  const line = document.lineAt(1);
  editor.selection = new vscode.Selection(line.range.end, line.range.end);

  const shown = await waitFor('a shown completion in the log', async () => {
    // VS Code can open its chat panel at startup and move focus into its input box, so put focus back each time.
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.window.showTextDocument(document, { preserveFocus: false });
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
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
