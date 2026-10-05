import * as vscode from 'vscode';
import { FILES, PROMPT, SELECTED, UNSAVED } from './mentions-fixture.js';

const model = () => process.env['GCODE_FAKE_MODEL']!;

function check(ok: boolean, what: string, actual?: unknown): void {
  if (!ok) throw new Error(`${what}${actual === undefined ? '' : `; got ${JSON.stringify(actual)}`}`);
}

async function waitFor(what: string, probe: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      if (await probe()) return;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last === undefined ? '' : `: ${String(last)}`}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function ui<T = unknown>(action: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${model()}/ui`, { method: 'POST', body: JSON.stringify(action) });
  const text = await response.text();
  check(response.ok, `ui ${JSON.stringify(action)}`, text);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

const panel = <T>(expression: string): Promise<T> => ui<T>({ do: 'eval', expression });
const composer = () => panel<string>('doc.querySelector("textarea").value');
const options = () => panel<string[]>(`[...doc.querySelectorAll('.mention')].map((e) => e.dataset.mention)`);
const uriOf = (name: keyof typeof FILES) => vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, name);

export async function run(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');

  const math = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uriOf('math.ts')));
  check(await math.edit((e) => e.insert(math.document.positionAt(math.document.getText().length), UNSAVED)), 'typing into math.ts');
  check(math.document.isDirty, 'math.ts has unsaved text');
  const selected = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uriOf('notes/selected.ts')), vscode.ViewColumn.Beside);
  selected.selection = new vscode.Selection(SELECTED.startLine - 1, 0, SELECTED.endLine, 0);

  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await panel<number>(`doc.querySelectorAll('.transcript').length`)) === 1);
  check(vscode.window.activeTextEditor?.document.uri.toString() === uriOf('notes/selected.ts').toString(), 'the selected file stays the active editor');

  await ui({ do: 'click', selector: 'textarea' });
  await ui({ do: 'type', text: 'Explain @mat' });
  await waitFor('math.ts among the completions', async () => (await options()).includes('math.ts'));
  check((await options())[0] === 'math.ts', 'the closest file comes first', await options());
  await ui({ do: 'press', key: 'Enter' });
  check((await composer()) === 'Explain @math.ts ', 'Enter puts the chosen file in the composer', await composer());
  check(await panel<boolean>('doc.querySelector(".mentions").hidden'), 'choosing closes the list');

  await ui({ do: 'type', text: 'and @sel' });
  await waitFor('the selection among the completions', async () => (await options())[0] === 'selection');
  await ui({ do: 'screenshot', name: 'mentions-open' });
  const detail = await panel<string>(`doc.querySelector('.mention .mention-detail').textContent`);
  check(detail === `notes/selected.ts:${SELECTED.startLine}-${SELECTED.endLine}`, 'the selection row names the file and lines', detail);
  await ui({ do: 'click', selector: '.mention', text: `selection${detail}` });
  check((await composer()) === `${PROMPT} `, 'a click puts the selection in the composer', await composer());

  await ui({ do: 'press', key: 'Enter' });
  await waitFor('the turn to finish', async () => (await panel<number>(`doc.querySelectorAll('.turn-footer').length`)) === 1);
  check(math.document.isDirty, 'the unsaved text is still unsaved');
}
