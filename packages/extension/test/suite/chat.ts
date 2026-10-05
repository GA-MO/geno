import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { ORIGINAL, TYPED_MEANWHILE, UNSAVED } from './chat-fixture.js';

const model = () => process.env['GCODE_FAKE_MODEL']!;

function check(ok: boolean, what: string, actual?: unknown): void {
  if (!ok) throw new Error(`${what}${actual === undefined ? '' : `; got ${JSON.stringify(actual)}`}`);
}

async function waitFor(what: string, probe: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** VS Code can open its chat panel at startup and move focus into its input box, so put focus back first. */
async function focus(document: vscode.TextDocument): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.window.showTextDocument(document, { preserveFocus: false });
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
}

async function type(editor: vscode.TextEditor, text: string): Promise<void> {
  const end = editor.document.positionAt(editor.document.getText().length);
  check(await editor.edit((e) => e.insert(end, text)), `typing ${JSON.stringify(text)}`);
}

export async function run(): Promise<void> {
  const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, 'math.ts');
  const disk = async () => readFile(uri.fsPath, 'utf8');
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);
  await type(editor, UNSAVED);
  const problems = vscode.languages.createDiagnosticCollection('gcode-test');
  problems.set(uri, [new vscode.Diagnostic(new vscode.Range(1, 13, 1, 20), 'unsaved is never read', vscode.DiagnosticSeverity.Warning)]);

  const first = await vscode.commands.executeCommand('gcode.chat.send', 'Set unsaved to 2');
  check(first === 'end_turn', 'the first turn ends normally', first);
  const edited = `${ORIGINAL}export const unsaved = 2;\n`;
  check(document.getText() === edited, 'the edit landed in the buffer, on top of the unsaved text', document.getText());
  check(document.isDirty, 'the edited buffer is unsaved');
  check((await disk()) === ORIGINAL, 'the disk copy is untouched before save', await disk());

  await focus(document);
  await vscode.commands.executeCommand('undo');
  check(document.getText() === `${ORIGINAL}${UNSAVED}`, 'undo takes back the agent edit', document.getText());
  await vscode.commands.executeCommand('redo');
  check(document.getText() === edited, 'redo puts it back', document.getText());

  check(await document.save(), 'save');
  check((await disk()) === edited, 'save writes the edit to disk', await disk());

  const second = vscode.commands.executeCommand('gcode.chat.send', 'Set unsaved to 3');
  await waitFor('the fake model to hold the edit until the buffer changes', async () => (await (await fetch(`${model()}/held`)).text()) === 'yes');
  await type(editor, TYPED_MEANWHILE);
  await fetch(`${model()}/go`, { method: 'POST' });
  const stop = await second;
  check(stop === 'end_turn', 'the second turn ends normally', stop);
  check(document.getText() === `${edited}${TYPED_MEANWHILE}`, 'the stale edit wrote nothing and the typing survived', document.getText());
}
