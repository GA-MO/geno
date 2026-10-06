import * as vscode from 'vscode';
import { changesLine, lenses } from './auto-review.js';
import { check, count, openPanel, screenshots, waitFor } from './lanes-ui.js';

/** After a reload the replayed turns carry the same summaries, Undone where a rewind took them back, and no lens comes back. */
export async function run(): Promise<void> {
  await openPanel();
  await waitFor('the replayed chat', async () => (await count('.transcript .turn')) === 3, 60_000);
  const lines = [await changesLine('.turn:nth-of-type(1)'), await changesLine('.turn:nth-of-type(2)'), await changesLine('.turn:nth-of-type(3)')];
  check(lines.join('|') === '2 files changed · Undone|1 file changed · Undone|1 file changed · Undo', 'each replayed turn has its summary', lines);
  await vscode.window.showTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, 'c.ts'));
  check((await lenses('c.ts')).length === 0, 'auto review restores no lens', await lenses('c.ts'));
  await vscode.commands.executeCommand('gcode.chat.focus');
  await screenshots('auto-replayed');
}
