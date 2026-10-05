import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { ORIGINAL, UNSAVED } from './chat-fixture.js';

function check(ok: boolean, what: string, actual?: unknown): void {
  if (!ok) throw new Error(`${what}${actual === undefined ? '' : `; got ${JSON.stringify(actual)}`}`);
}

/** The chat flow against a real model: it must find the unsaved line, which is only in the buffer, and edit it there. */
export async function run(): Promise<void> {
  const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, 'math.ts');
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);
  const end = document.positionAt(document.getText().length);
  check(await editor.edit((e) => e.insert(end, UNSAVED)), 'typing the unsaved line');

  const stop = await vscode.commands.executeCommand(
    'gcode.chat.send',
    'In math.ts, change the value of the exported constant `unsaved` from 1 to 2. Edit only that line, do not run any commands, and reply in one sentence.',
  );
  check(stop === 'end_turn', 'the turn ends normally', stop);
  check(document.getText() === `${ORIGINAL}export const unsaved = 2;\n`, 'the edit landed in the buffer', document.getText());
  check(document.isDirty, 'the buffer is still unsaved');
  const disk = await readFile(uri.fsPath, 'utf8');
  check(disk === ORIGINAL, 'the disk copy is untouched', disk);
}
