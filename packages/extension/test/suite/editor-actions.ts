import * as vscode from 'vscode';
import { EDIT, FILES, HELPER_LINE, PROMPT } from './editor-actions-fixture.js';
import { check, click, count, openPanel, panel, panelWidth, screenshots, textOf, waitFor, workbench } from './lanes-ui.js';

const uriOf = (file: string) => vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, file);

/** The label of the row the Explorer has selected. */
const explorerSelection = () => workbench<string | null>(`document.querySelector('.explorer-folders-view .monaco-list-row.selected .label-name')?.textContent ?? null`);

/** What the window shows, for a timeout's message. */
const seen = async () => ({
  active: vscode.window.activeTextEditor?.document.uri.toString(),
  tabs: vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.label)),
  transcript: await textOf('.transcript'),
});

const steps = () => panel<string[]>(`[...doc.querySelectorAll('.editor-step .step-row')].map((row) => row.textContent)`);

async function landedOnHelper(what: string): Promise<void> {
  await waitFor(what, async () => vscode.window.activeTextEditor?.document.uri.fsPath === uriOf('src/util.ts').fsPath, 20_000, seen);
  const editor = vscode.window.activeTextEditor!;
  check(editor.selection.active.line === HELPER_LINE - 1, `${what}: the cursor is on line ${HELPER_LINE}`, editor.selection.active.line + 1);
  check(editor.visibleRanges.some((range) => range.contains(new vscode.Position(HELPER_LINE - 1, 0))), `${what}: line ${HELPER_LINE} is in view`, editor.visibleRanges);
}

const diffTab = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((tab) => tab.input instanceof vscode.TabInputTextDiff)?.input as vscode.TabInputTextDiff | undefined;

async function diffHasTheRightSides(what: string): Promise<void> {
  await waitFor(what, async () => diffTab() !== undefined, 20_000, seen);
  const diff = diffTab()!;
  check(diff.original.scheme === 'gcode-checkpoint' && new URLSearchParams(diff.original.query).has('sha'), `${what}: the left side is a checkpoint`, diff.original.toString());
  check(diff.modified.scheme === 'file' && diff.modified.fsPath === uriOf('a.ts').fsPath, `${what}: the right side is a.ts itself`, diff.modified.toString());
  check((await vscode.workspace.openTextDocument(diff.original)).getText() === FILES['a.ts'], `${what}: the left side is a.ts before the turn`);
  check((await vscode.workspace.openTextDocument(diff.modified)).getText() === FILES['a.ts'].replace(EDIT.old_str, EDIT.new_str), `${what}: the right side holds the edit`);
}

async function backToChat(): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to show the steps', async () => (await count('.editor-step')) === 3);
}

export async function run(): Promise<void> {
  await openPanel();
  await panelWidth(420);

  const stop = await vscode.commands.executeCommand('gcode.chat.send', PROMPT);
  check(stop === 'end_turn', 'the turn ends normally', stop);
  await landedOnHelper('open_file during the turn');
  await diffHasTheRightSides('show_diff during the turn');
  await waitFor('reveal during the turn to select src in the Explorer', async () => (await explorerSelection()) === 'src', 10_000, explorerSelection);

  await backToChat();
  const labels = await steps();
  check(JSON.stringify(labels) === JSON.stringify(['Showed the diff ofa.ts', 'Revealedsrcin the Explorer', `Openedutil.ts:${HELPER_LINE}`]), 'each call shows one small step', labels);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await screenshots('editor-steps');
  const narrow = await panelWidth(300);
  check(Math.abs(narrow - 300) <= 4, 'the panel narrows to about 300px', narrow);
  const fits = await panel<boolean>(
    `[...doc.querySelectorAll('.editor-step')].every((step) => step.scrollWidth <= step.clientWidth && step.getBoundingClientRect().right <= doc.documentElement.clientWidth)`,
  );
  check(fits, 'the steps fit at 300px');
  await screenshots('editor-steps-300');
  await panelWidth(420);

  await click('.editor-step[data-step="open_file"] .step-row');
  await landedOnHelper('clicking the open_file step');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await backToChat();
  await click('.editor-step[data-step="show_diff"] .step-row');
  await diffHasTheRightSides('clicking the show_diff step');
  await vscode.commands.executeCommand('revealInExplorer', uriOf('a.ts'));
  await waitFor('the Explorer to select a.ts first', async () => (await explorerSelection()) === 'a.ts', 10_000, explorerSelection);
  await backToChat();
  await click('.editor-step[data-step="reveal"] .step-row');
  await waitFor('clicking the reveal step to select src again', async () => (await explorerSelection()) === 'src', 10_000, explorerSelection);
}
