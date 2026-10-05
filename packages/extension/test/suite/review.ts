import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { EDITS, FILES, INSTRUCTION, TYPED_ABOVE } from './review-fixture.js';

const model = () => process.env['GCODE_FAKE_MODEL']!;

function check(ok: boolean, what: string, actual?: unknown): void {
  if (!ok) throw new Error(`${what}${actual === undefined ? '' : `; got ${JSON.stringify(actual)}`}`);
}

async function waitFor(what: string, probe: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const folder = () => vscode.workspace.workspaceFolders![0]!.uri;
const uriOf = (name: keyof typeof FILES) => vscode.Uri.joinPath(folder(), name);
const disk = (name: keyof typeof FILES) => readFile(uriOf(name).fsPath, 'utf8');
const replaced = (text: string, edit: { old_str: string; new_str: string }) => text.replace(edit.old_str, edit.new_str);

/** The Keep and Undo lenses in a file, as the line each sits on and the hunk id each acts on. */
async function lenses(name: keyof typeof FILES): Promise<{ line: number; title: string; id: string }[]> {
  const found = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uriOf(name));
  return found
    .filter((lens) => lens.command?.command.startsWith('gcode.review.'))
    .map((lens) => ({ line: lens.range.start.line, title: lens.command!.title, id: lens.command!.arguments![0] as string }))
    .sort((a, b) => a.line - b.line || a.title.localeCompare(b.title));
}

/** Asks the test for a screenshot of the window, after the workbench has had a moment to paint. */
async function screenshot(name: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 1500));
  const response = await fetch(`${model()}/screenshot?name=${name}`, { method: 'POST' });
  check(response.ok, `screenshot ${name}`, await response.text());
}

/** VS Code can open its chat panel at startup and move focus into its input box, so put focus back first. */
async function show(name: keyof typeof FILES): Promise<vscode.TextEditor> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  const editor = await vscode.window.showTextDocument(uriOf(name), { preserveFocus: false });
  await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  return editor;
}

export async function run(): Promise<void> {
  const editedA = replaced(replaced(FILES['a.ts'], EDITS.addOrder), EDITS.three);
  const stop = await vscode.commands.executeCommand('gcode.chat.send', 'Swap the addition and raise three');
  check(stop === 'end_turn', 'the agent turn ends normally', stop);
  check((await disk('a.ts')) === editedA, 'both edits to a.ts are on disk', await disk('a.ts'));
  check((await disk('b.ts')) === replaced(FILES['b.ts'], EDITS.greeting), 'the edit to b.ts is on disk', await disk('b.ts'));

  const editor = await show('a.ts');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.changes.focus');
  await waitFor('Keep and Undo above both hunks of a.ts', async () => (await lenses('a.ts')).length === 4);
  const [addOrder, , three] = await lenses('a.ts');
  check(addOrder!.line === 1 && three!.line === 6, 'the controls sit on the first line of each hunk', await lenses('a.ts'));
  await show('a.ts');
  await screenshot('hunks');

  await vscode.commands.executeCommand('gcode.review.keep', addOrder!.id);
  const [greeting] = await lenses('b.ts');
  await vscode.commands.executeCommand('gcode.review.undo', greeting!.id);
  check((await lenses('b.ts')).length === 0, 'an undone hunk loses its controls', await lenses('b.ts'));
  check((await lenses('a.ts')).map((l) => l.line).join() === '6,6', 'a kept hunk loses its controls; the other keeps them', await lenses('a.ts'));

  await show('a.ts');
  check(await editor.edit((e) => e.insert(new vscode.Position(4, 0), TYPED_ABOVE)), 'typing a line above the pending hunk');
  await waitFor('the pending hunk controls to move down a line', async () => (await lenses('a.ts')).map((l) => l.line).join() === '7,7');
  check(await editor.document.save(), 'save a.ts');
  const typedA = editedA.replace('export const one = 1;\n', `${TYPED_ABOVE}export const one = 1;\n`);
  check((await disk('a.ts')) === typedA, 'a.ts on disk holds the kept hunk, the pending hunk and the typed line', await disk('a.ts'));
  check((await disk('b.ts')) === FILES['b.ts'], 'b.ts on disk is back to its original bytes', await disk('b.ts'));
  await screenshot('changes');

  await vscode.commands.executeCommand('gcode.review.openDiff', uriOf('a.ts'));
  await waitFor('the diff against the checkpoint', async () =>
    vscode.window.visibleTextEditors.some((e) => e.document.uri.scheme === 'gcode-checkpoint' && e.document.getText() === FILES['a.ts']),
  );
  await screenshot('diff');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  await vscode.commands.executeCommand('gcode.review.undoSession');
  for (const name of ['a.ts', 'b.ts', 'c.ts'] as const) {
    check((await disk(name)) === FILES[name], `Undo all restores ${name} byte for byte`, await disk(name));
  }
  const reopened = await vscode.workspace.openTextDocument(uriOf('a.ts'));
  await waitFor('the open a.ts to reload the restored text', async () => reopened.getText() === FILES['a.ts']);
  check((await lenses('a.ts')).length === 0, 'Undo all leaves nothing to review', await lenses('a.ts'));

  const c = await show('c.ts');
  c.selection = new vscode.Selection(0, 0, 3, 0);
  const inline = await vscode.commands.executeCommand('gcode.inlineEdit', INSTRUCTION);
  check(inline === 'end_turn', 'the inline edit ends normally', inline);
  check((await disk('c.ts')) === replaced(FILES['c.ts'], EDITS.double), 'the inline edit is on disk', await disk('c.ts'));
  await waitFor('Keep and Undo above the inline edit', async () => (await lenses('c.ts')).map((l) => `${l.line} ${l.title}`).join() === '1 Keep,1 Undo');
  await show('c.ts');
  await screenshot('inline-edit');
}
