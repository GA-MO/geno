import { existsSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import { ANSWER, EDITED, NOTE, PROMPTS, QUESTION, THEMES } from './context-fixture.js';
import { SHOOTING } from './shooting.js';

const model = () => process.env['GCODE_FAKE_MODEL']!;
const home = () => process.env['GCODE_HOME']!;

function check(ok: boolean, what: string, actual?: unknown): void {
  if (!ok) throw new Error(`${what}${actual === undefined ? '' : `; got ${JSON.stringify(actual)}`}`);
}

async function waitFor(what: string, probe: () => Promise<boolean>, ms = 60_000): Promise<void> {
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
const click = (selector: string, text?: string) => ui({ do: 'click', selector, ...(text === undefined ? {} : { text }) });
const textOf = (selector: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const textsOf = (selector: string) => panel<string[]>(`[...doc.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent)`);
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
const visible = (selector: string) => panel<boolean>(`(() => { const e = doc.querySelector(${JSON.stringify(selector)}); return e !== null && e.offsetParent !== null; })()`);
/** Real paths, since the workspace may sit behind a symlink such as macOS's /var. */
const real = (file: string | undefined) => (file === undefined || !existsSync(file) ? file : realpathSync(file));
const activeFile = () => real(vscode.window.activeTextEditor?.document.uri.fsPath);

async function screenshots(name: string): Promise<void> {
  if (!SHOOTING) return;
  for (const [slug, theme] of Object.entries(THEMES)) {
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
    await new Promise((r) => setTimeout(r, 1500));
    await vscode.commands.executeCommand('notifications.clearAll');
    await new Promise((r) => setTimeout(r, 300));
    await ui({ do: 'screenshot', name: `${name}-${slug}` });
  }
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', THEMES.dark, vscode.ConfigurationTarget.Global);
}

async function send(prompt: string): Promise<void> {
  await click('textarea[data-focus="composer"]');
  await ui({ do: 'type', text: prompt });
  await ui({ do: 'press', key: 'Enter' });
}

async function backToChat(): Promise<void> {
  await click('.context-pane:not([hidden]) .history-back');
  await waitFor('the chat again', () => visible('textarea[data-focus="composer"]'));
}

export async function run(): Promise<void> {
  const workspace = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  for (let i = 0; i < 5; i++) await vscode.commands.executeCommand('workbench.action.decreaseViewWidth');

  // /rules lists what the session loaded, in load order, and each row opens its file.
  await send('/rules');
  await waitFor('the rules pane', async () => (await count('.rules-row')) === 2);
  check(!(await visible('textarea[data-focus="composer"]')), 'the pane takes the composer\'s place');
  const rows = await textsOf('.rules-path');
  check(JSON.stringify(rows) === JSON.stringify(['AGENTS.md', '.cursor/rules/react.mdc']), 'the instruction file, then the cursor rule', rows);
  const triggers = await textsOf('.rules-trigger');
  check(JSON.stringify(triggers) === JSON.stringify(['Always on', 'When a file matches *.tsx']), 'each row says when it applies', triggers);
  await screenshots('rules');
  await click('.rules-row[data-rule=".cursor/rules/react.mdc"] .rules-open');
  await waitFor('the rule to open in an editor', async () => activeFile() === real(path.join(workspace, '.cursor', 'rules', 'react.mdc')));
  const globalFile = path.join(home(), 'AGENTS.md');
  check(!existsSync(globalFile), 'no global rules yet');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await click('.rules-edit-global');
  await waitFor('Edit global rules to create and open the file', async () => activeFile() === real(globalFile));
  check(existsSync(globalFile), 'the global rules file exists now');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await backToChat();

  // remember: the card quotes the exact note, and only Remember keeps it.
  await send(PROMPTS.remember);
  await waitFor('the remember card', () => visible('.permission-open.permission-ask-memory'));
  check((await textOf('.permission-ask-memory .memory-text')) === NOTE, 'the card shows the exact note', await textOf('.permission-ask-memory .memory-text'));
  check((await textOf('.permission-ask-memory .permission-title')) === 'Remember this?', 'it asks to remember', await textOf('.permission-ask-memory .permission-title'));
  const buttons = await textsOf('.permission-ask-memory .permission-actions button');
  check(JSON.stringify(buttons) === JSON.stringify(['Remember', "Don't remember"]), 'with Remember and Don\'t remember', buttons);
  await screenshots('remember');
  await click('.permission-ask-memory .permission-actions button', 'Remember');
  await waitFor('the remember turn to finish', async () => (await count('.turn-footer')) === 1);
  check((await textOf('.permission-ask-memory .permission-outcome')) === 'Remembered', 'the card says it was remembered', await textOf('.permission-ask-memory .permission-outcome'));

  // ask_user: a question card with the options and a free-text answer.
  await send(PROMPTS.ask);
  await waitFor('the question card', () => visible('.permission-open.permission-ask-question'));
  check((await textOf('.permission-ask-question .question-text')) === QUESTION.question, 'the card asks the question', await textOf('.permission-ask-question .question-text'));
  const options = await textsOf('.permission-ask-question .question-option');
  check(JSON.stringify(options) === JSON.stringify(QUESTION.options), 'the options are buttons', options);
  check(await visible('.permission-ask-question .question-input'), 'and the user can answer in their own words');
  await screenshots('question');
  await click('.permission-ask-question .question-option', ANSWER);
  await waitFor('the question turn to finish', async () => (await count('.turn-footer')) === 2);
  check((await textOf('.permission-ask-question .permission-outcome')) === `Answered: ${ANSWER}`, 'the card shows the answer', await textOf('.permission-ask-question .permission-outcome'));

  // /memory lists the note, edits it, and deletes it into the trash.
  await send('/memory');
  await waitFor('the memory pane', async () => (await count('.memory-row')) === 1);
  check((await textOf('.memory-list[data-scope="project"] .memory-entry-text')) === NOTE, 'the note is in this project\'s memory', await textOf('.memory-entry-text'));
  await screenshots('memory');
  await click('.memory-row .memory-edit');
  await waitFor('the note to be editable', () => visible('.memory-input'));
  await panel(`(() => { const f = doc.querySelector('.memory-input'); f.value = ${JSON.stringify(EDITED)}; f.dispatchEvent(new Event('input')); })()`);
  await click('.memory-actions .button', 'Save');
  await waitFor('the edited note', async () => (await textOf('.memory-entry-text')) === EDITED);
  const id = await panel<string>(`doc.querySelector('.memory-row').dataset.memory`);
  await click('.memory-row .memory-delete');
  await waitFor('the note to go', async () => (await count('.memory-row')) === 0);
  check((await textOf('.memory .history-note')) !== null, 'the pane says memory is empty');
  const trash = path.join(home(), 'trash', 'memory');
  check(existsSync(trash) && readdirSync(trash).includes(`${id}.json`), 'the deleted note is in the trash', existsSync(trash) ? readdirSync(trash) : []);
  await backToChat();
}
