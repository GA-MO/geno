import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { FILES, LANE, PROMPTS } from './auto-review-fixture.js';
import { check, click, count, openPanel, panel, panelWidth, screenshots, shown, textOf, ui, view, waitFor, workbench } from './lanes-ui.js';

type File = keyof typeof FILES;

const uriOf = (file: File) => vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, file);
const bytes = (file: File) => readFile(uriOf(file).fsPath);
const disk = async (file: File) => (await bytes(file)).toString('utf8');
const sameBytes = async (file: File) => (await bytes(file)).equals(Buffer.from(FILES[file]));
const lane = (inner = '') => `.lane-row[data-lane="${LANE}"] ${inner}`.trim();

/** The review lenses in a file. */
export async function lenses(file: File): Promise<string[]> {
  const found = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uriOf(file));
  return found.flatMap((lens) => (lens.command?.command.startsWith('gcode.review.') === true ? [lens.command.title] : []));
}

/** Decorations an extension put in the shown editors; VS Code names their classes `ced-…`. */
const decorations = () => workbench<number>(`document.querySelectorAll('.monaco-editor .view-overlays [class*="ced-"], .monaco-editor .margin-view-overlays [class*="ced-"]').length`);

const dirty = () => vscode.workspace.textDocuments.filter((d) => d.uri.scheme === 'file' && d.isDirty).map((d) => vscode.workspace.asRelativePath(d.uri));

/** Both files side by side, so their editors draw whatever decorations they have. */
async function showSideBySide(left: File, right: File): Promise<void> {
  await vscode.window.showTextDocument(uriOf(left), { viewColumn: vscode.ViewColumn.One });
  await vscode.window.showTextDocument(uriOf(right), { viewColumn: vscode.ViewColumn.Two, preserveFocus: true });
  await new Promise((r) => setTimeout(r, 1000));
}

export const changesLine = (turn: string) => textOf(`${turn} .turn-changes-line`);

export async function run(): Promise<void> {
  await openPanel();
  await panelWidth(420);
  check((await panel<string>('doc.body.dataset.review')) === 'auto', 'auto review is the default');

  const stop = await vscode.commands.executeCommand('gcode.chat.send', PROMPTS.edit);
  check(stop === 'end_turn', 'the agent turn ends normally', stop);
  const edited = { 'a.ts': FILES['a.ts'].replace('one = 1;', 'one = 10;'), 'b.ts': FILES['b.ts'].replace("'hello'", "'hi'") };
  check((await disk('a.ts')) === edited['a.ts'] && (await disk('b.ts')) === edited['b.ts'], 'both edits are on disk at once', [await disk('a.ts'), await disk('b.ts')]);

  await showSideBySide('a.ts', 'b.ts');
  check((await lenses('a.ts')).length === 0 && (await lenses('b.ts')).length === 0, 'no Keep or Undo lens in either file', [await lenses('a.ts'), await lenses('b.ts')]);
  check((await decorations()) === 0, 'no decoration in either editor', await decorations());
  check(dirty().length === 0, 'no buffer is left dirty', dirty());
  check(vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uriOf('a.ts').fsPath)?.getText() === edited['a.ts'], 'the open buffer holds the edit');

  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the turn summary', async () => (await changesLine('.turn:last-of-type')) === '2 files changed · Undo', 30_000, () => textOf('.transcript'));
  check((await count('.transcript .hunk-actions, .transcript [data-focus="keep-all"]')) === 0, 'the chat offers no Keep', await count('.transcript .hunk-actions'));
  await screenshots('auto-turn');
  const narrow = await panelWidth(300);
  check(Math.abs(narrow - 300) <= 4, 'the panel narrows to about 300px', narrow);
  const fits = await panel<boolean>(`(() => { const r = doc.querySelector('.turn-changes').getBoundingClientRect(); return r.right <= doc.documentElement.clientWidth && doc.querySelector('.turn-changes').scrollWidth <= doc.querySelector('.turn-changes').clientWidth; })()`);
  check(fits, 'the summary line fits at 300px');
  await screenshots('auto-turn-300');
  await panelWidth(420);

  // A file name opens a read-only diff against the checkpoint before the turn.
  await click('.turn:last-of-type .changed-file');
  await waitFor('the diff against the checkpoint', async () => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputTextDiff);
  const diff = vscode.window.tabGroups.activeTabGroup.activeTab!.input as vscode.TabInputTextDiff;
  check(diff.original.scheme === 'gcode-checkpoint' && diff.modified.fsPath === uriOf('a.ts').fsPath, 'the diff is the checkpoint against a.ts', diff.original.toString());
  check((await vscode.workspace.openTextDocument(diff.original)).getText() === FILES['a.ts'], 'its left side is a.ts before the turn');
  await screenshots('auto-diff');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  await vscode.commands.executeCommand('gcode.chat.focus');
  await click('.turn:last-of-type .turn-undo');
  await waitFor('Undo to restore both files', async () => (await sameBytes('a.ts')) && (await sameBytes('b.ts')), 30_000, async () => [await disk('a.ts'), await disk('b.ts')]);
  await waitFor('the turn to read as undone', async () => (await changesLine('.turn:last-of-type')) === '2 files changed · Undone', 30_000, () => changesLine('.turn:last-of-type'));
  check(dirty().length === 0, 'Undo leaves no dirty buffer', dirty());
  await screenshots('auto-undone');

  // A lane's Apply lands whole, with the same summary and Undo.
  await click('textarea');
  await ui({ do: 'type', text: PROMPTS.lane });
  await click('.send-more');
  await waitFor('the send menu', async () => await shown('#send-menu'));
  await click('#send-menu [data-action="lane"]');
  await waitFor('the Lanes pane', async () => (await view()) === 'lanes');
  await waitFor('the lane to finish', async () => (await textOf(lane('.lane-state')))?.trim() === 'Done', 120_000, () => textOf('.lanes:not([hidden])'));
  await vscode.commands.executeCommand('notifications.clearAll');
  await click(lane('[data-action="apply"]'));
  await waitFor('the chat again', async () => (await view()) === 'chat');
  await waitFor('the apply to land', async () => (await disk('a.ts')).includes('export const THREE = 3;'));
  await waitFor('the apply summary', async () => (await changesLine('.turn:last-of-type')) === '1 file changed · Undo', 30_000, () => textOf('.turn:last-of-type'));
  check((await count('.transcript .hunk-actions')) === 0, 'the apply asks no Keep');
  check((await lenses('a.ts')).length === 0, 'the apply leaves no lens in a.ts', await lenses('a.ts'));
  check(dirty().length === 0, 'the apply leaves no dirty buffer', dirty());
  await screenshots('auto-lane-applied');
  await click('.turn:last-of-type .turn-undo');
  await waitFor('Undo to take the apply back', async () => sameBytes('a.ts'), 30_000, () => disk('a.ts'));

  // Review mode, as a control: the same probes see its lenses and decorations.
  await vscode.workspace.getConfiguration('gcode').update('review.mode', 'review', vscode.ConfigurationTarget.Workspace);
  await waitFor('the panel to switch to review', async () => (await panel<string>('doc.body.dataset.review')) === 'review');
  const reviewed = await vscode.commands.executeCommand('gcode.chat.send', PROMPTS.review);
  check(reviewed === 'end_turn', 'the review turn ends normally', reviewed);
  await showSideBySide('c.ts', 'a.ts');
  await waitFor('Keep and Undo above the hunk in c.ts', async () => (await lenses('c.ts')).join() === 'Keep,Undo');
  await waitFor('the hunk decoration in c.ts', async () => (await decorations()) > 0);
  await vscode.commands.executeCommand('gcode.chat.focus');
  check((await count('.turn:last-of-type .turn-changes')) === 0 && (await count('.turn:last-of-type .hunk-actions')) === 0, 'compact review folds the hunk and shows no summary line');
  check((await count('.turn:last-of-type [data-focus="keep-all"]')) === 1, 'review offers Keep all');

  await vscode.workspace.getConfiguration('gcode').update('review.mode', 'auto', vscode.ConfigurationTarget.Workspace);
  await waitFor('the lenses to go with review mode', async () => (await lenses('c.ts')).length === 0);
  await waitFor('the summary under the review turn', async () => (await changesLine('.turn:last-of-type')) === '1 file changed · Undo');
  check((await disk('c.ts')).includes('n * 2'), 'the review turn edit stays on disk');
}
