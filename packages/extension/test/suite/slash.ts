import * as vscode from 'vscode';
import { EXPANDED, SENT, THEMES } from './slash-fixture.js';

const BUILTINS = ['new', 'history', 'mode', 'model', 'clear', 'compact', 'rules', 'memory', 'init', 'best-of-n', 'schedule'];

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
const click = (selector: string) => ui({ do: 'click', selector });
const type = (text: string) => ui({ do: 'type', text });
const press = (key: string) => ui({ do: 'press', key });
const textOf = (selector: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
const composer = () => panel<string>('doc.querySelector("textarea").value');
const rows = () => panel<string[]>(`[...doc.querySelectorAll('.slash-menu:not([hidden]) .command-option')].map((o) => o.dataset.command)`);
const active = () => panel<string | null>(`doc.querySelector('.slash-menu .command-option.active')?.dataset.command ?? null`);
const view = () => panel<string>('doc.body.dataset.view');
/** The command chip and the arguments in the bubble of turn `n`, counted from 1. */
const bubble = (n: number) =>
  panel<{ command: string | null; route: string | null; args: string | null; text: string }>(
    `(() => { const b = doc.querySelector('.turn:nth-child(${n}) .request-bubble'); const chip = b?.querySelector('.command-chip'); return { command: chip?.dataset.command ?? null, route: chip?.dataset.route ?? null, args: b?.querySelector('.command-args')?.textContent ?? null, text: b?.textContent ?? '' }; })()`,
  );

async function screenshots(name: string): Promise<void> {
  for (const [slug, theme] of Object.entries(THEMES)) {
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
    await new Promise((r) => setTimeout(r, 1500));
    await vscode.commands.executeCommand('notifications.clearAll');
    await new Promise((r) => setTimeout(r, 300));
    await ui({ do: 'screenshot', name: `${name}-${slug}` });
  }
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', THEMES.dark, vscode.ConfigurationTarget.Global);
}

export async function run(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('gcode.chat.focus');
  for (let i = 0; i < 5; i++) await vscode.commands.executeCommand('workbench.action.decreaseViewWidth');

  await click('textarea');
  await type('/');
  await waitFor('the workspace commands to join the built-ins', async () => (await rows()).join() === [...BUILTINS, 'review', 'add-i18n'].join());
  check((await textOf('.command-option[data-command="review"] .command-hint')) === '<file>', 'a command shows its argument hint');
  check((await textOf('.command-option[data-command="review"] .mention-detail')) === 'Review a file for bugs', 'a command shows its description');
  check((await textOf('.command-option[data-command="add-i18n"] .mention-detail')) === 'Add a locale to the site', 'a skill shows its description');
  check((await panel<string>('doc.querySelector("textarea").getAttribute("aria-activedescendant")')) === 'command-0', 'the composer points at the active row');
  await screenshots('picker');

  await type('m');
  await waitFor('typing to filter the list', async () => (await rows()).join() === 'mode,model,memory,compact');
  await press('ArrowDown');
  check((await active()) === 'model', 'ArrowDown moves to the next command', await active());
  await press('ArrowUp');
  await press('ArrowUp');
  check((await active()) === 'compact', 'ArrowUp wraps to the last command', await active());
  await press('Escape');
  check((await rows()).length === 0 && (await composer()) === '/m', 'Escape closes the list and keeps the draft', await composer());
  await type('o');
  await waitFor('typing again to reopen the list', async () => (await rows()).join() === 'mode,model,memory');
  await press('Tab');
  check((await composer()) === '/mode ', 'Tab puts the active command in the draft', await composer());
  check((await rows()).length === 0, 'choosing closes the list');
  await type('plan');
  await press('Enter');
  await waitFor('the engine to run /mode', async () => (await count('.turn-footer')) === 1);
  check(JSON.stringify(await bubble(1)) === JSON.stringify({ command: 'mode', route: 'engine', args: 'plan', text: SENT.mode }), 'an engine built-in shows as a chip and its arguments', await bubble(1));
  check((await textOf('.turn:nth-child(1) .rail'))?.includes('Approval mode: plan.') === true, 'the engine answers /mode itself', await textOf('.turn:nth-child(1) .rail'));
  await waitFor('the picker to follow the engine into Plan', async () => (await panel<string>(`doc.querySelector('.mode-picker').dataset.mode`)) === 'plan');

  await type('/rev');
  await waitFor('the review command alone', async () => (await rows()).join() === 'review');
  await click('.command-option[data-command="review"]');
  check((await composer()) === '/review ', 'a click puts the command in the draft', await composer());
  check((await panel<boolean>(`doc.activeElement === doc.querySelector('textarea')`)), 'the composer keeps the focus after a click');
  await type('a.ts');
  await press('Enter');
  await waitFor('the review turn to finish', async () => (await count('.turn-footer')) === 2);
  check(JSON.stringify(await bubble(2)) === JSON.stringify({ command: 'review', route: 'prompt', args: 'a.ts', text: SENT.review }), 'a prompt command shows as typed, not expanded', await bubble(2));
  check(!(await bubble(2)).text.includes(EXPANDED), 'the bubble leaves out the expansion');

  await type('/add');
  await waitFor('the skill alone', async () => (await rows()).join() === 'add-i18n');
  await press('Enter');
  check((await composer()) === '/add-i18n ', 'Enter on a command that takes arguments only fills it in', await composer());
  await type('th');
  await press('Enter');
  await waitFor('the skill turn to finish', async () => (await count('.turn-footer')) === 3);
  check(JSON.stringify(await bubble(3)) === JSON.stringify({ command: 'add-i18n', route: 'skill', args: 'th', text: SENT.skill }), 'a skill shows its name', await bubble(3));
  await screenshots('chips');

  await type('/histo');
  await waitFor('the history command alone', async () => (await rows()).join() === 'history');
  await press('Enter');
  await waitFor('/history to open the history', async () => (await view()) === 'history');
  check((await count('.turn')) === 3, '/history starts no turn');
  await press('Escape');
  await waitFor('Escape to close the history', async () => (await view()) === 'chat');

  await click('textarea');
  await type('/clear');
  await waitFor('the clear command alone', async () => (await rows()).join() === 'clear');
  await press('Enter');
  await waitFor('/clear to start a new chat', async () => (await count('.turn')) === 0 && (await count('.empty-state')) === 1);
  check((await composer()) === '', 'sending a command empties the composer', await composer());

  await vscode.commands.executeCommand('gcode.chat.history');
  await waitFor('the history to list the older chat', async () => (await count('.history-row:not(.current) .history-open')) === 1);
  await click('.history-row:not(.current) .history-open');
  await waitFor('the older chat to load', async () => (await view()) === 'chat' && (await count('.turn-footer')) === 2);
  check(JSON.stringify(await bubble(1)) === JSON.stringify({ command: 'review', route: 'prompt', args: 'a.ts', text: SENT.review }), 'a replayed command turn shows its chip', await bubble(1));
  check(JSON.stringify(await bubble(2)) === JSON.stringify({ command: 'add-i18n', route: 'skill', args: 'th', text: SENT.skill }), 'a replayed skill turn shows its chip', await bubble(2));

  await click('textarea');
  await type('/model');
  await press('Escape');
  await press('Enter');
  await waitFor('/model to open Models and Keys', async () => (await view()) === 'settings');
  check((await count('.turn')) === 2, '/model starts no turn');
  await press('Escape');
  await waitFor('the chat again', async () => (await view()) === 'chat');

  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await click('textarea');
  await type('/new');
  await press('Escape');
  await press('Enter');
  await waitFor('/new to start a new chat', async () => (await count('.turn')) === 0);
}
