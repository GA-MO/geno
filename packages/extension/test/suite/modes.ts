import * as vscode from 'vscode';
import { START_BUILDING_PROMPT } from '../../src/chat/chat.js';
import { COMMANDS, FOLLOW_UP, PROMPTS, REASONS, THEMES } from './modes-fixture.js';

const MODES_IN_ORDER = ['plan', 'ask', 'auto'];

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
const click = (selector: string, text?: string) => ui({ do: 'click', selector, ...(text === undefined ? {} : { text }) });
const textOf = (selector: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
const picker = () => panel<{ mode: string; label: string; box: string }>(
  `({ mode: doc.querySelector('.mode-picker').dataset.mode, label: doc.querySelector('.mode-name').textContent, box: doc.querySelector('.input-box').dataset.mode })`,
);
/** The badge and reason under the step that ran `command`. */
const note = (command: string) =>
  panel<string | null>(
    `(() => { const step = [...doc.querySelectorAll('.calls[data-step="bash"]')].find((s) => s.querySelector('.step-target')?.textContent === ${JSON.stringify(command)}); return step?.querySelector('.auto-note')?.textContent ?? null; })()`,
  );

async function showPanel(): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1);
}

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

async function send(prompt: string): Promise<void> {
  await click('textarea');
  await ui({ do: 'type', text: prompt });
  await ui({ do: 'press', key: 'Enter' });
}

export async function run(): Promise<void> {
  check(FOLLOW_UP === START_BUILDING_PROMPT, 'the fixture sends what Start building sends');
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await showPanel();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('gcode.chat.focus');
  for (let i = 0; i < 5; i++) await vscode.commands.executeCommand('workbench.action.decreaseViewWidth');

  check(JSON.stringify(await picker()) === JSON.stringify({ mode: 'auto', label: 'Auto', box: 'auto' }), 'a new chat starts in the mode gcode.approvalMode names', await picker());

  await send(PROMPTS.auto);
  await waitFor('the Auto turn to finish', async () => (await count('.turn-footer')) === 1);
  check((await count('.permission-open')) === 0, 'Auto asks nobody when the classifier will not allow a command');

  check((await note(COMMANDS.removeBuild)) === `Auto-approved${REASONS.allow}`, 'an auto-approved step shows its badge and the classifier\'s reason', await note(COMMANDS.removeBuild));
  check((await note(COMMANDS.script)) === `Auto-denied${REASONS.deny}`, 'an auto-denied step shows the denial reason', await note(COMMANDS.script));
  check((await note(COMMANDS.removeDist)) === `Auto-denied${REASONS.ask}`, 'a step the classifier would not allow is blocked and shows its reason', await note(COMMANDS.removeDist));
  check((await count('.tool-row')) === 0, 'the badges show while the steps are folded');
  await screenshots('auto');

  await click('.mode-picker');
  await waitFor('the mode menu', async () => (await count('.mode-menu:not([hidden]) .mode-option')) === 3);
  const order = await panel<string[]>(`[...doc.querySelectorAll('.mode-option')].map((o) => o.dataset.mode)`);
  check(order.join() === MODES_IN_ORDER.join(), 'the menu lists Plan, Ask and Auto in that order', order);
  check((await panel<string>('doc.activeElement?.dataset.mode ?? ""')) === 'auto', 'the menu opens on the current mode');
  check((await textOf('.mode-option[aria-checked="true"] .mode-option-name')) === 'Auto', 'the menu marks the current mode');
  await screenshots('menu');
  await ui({ do: 'press', key: 'Escape' });
  await waitFor('Escape to close the menu', async () => (await count('.mode-menu[hidden]')) === 1);
  check((await panel<string>('doc.activeElement?.className ?? ""')).includes('mode-picker'), 'closing the menu returns the focus to the picker');

  await click('.mode-picker');
  await waitFor('the mode menu again', async () => (await count('.mode-menu:not([hidden]) .mode-option')) === 3);
  await click('.mode-option[data-mode="ask"]');
  await waitFor('the engine to confirm Ask', async () => (await picker()).mode === 'ask');
  check(JSON.stringify(await picker()) === JSON.stringify({ mode: 'ask', label: 'Ask', box: 'ask' }), 'Ask drops the Auto marker', await picker());
  await screenshots('ask');

  await send(PROMPTS.ask);
  await waitFor('Ask to ask before rm -rf', async () => (await count('.permission-open')) === 1);
  check((await count('.permission-open .permission-classifier')) === 0, 'Ask asks without a classifier');
  await screenshots('ask');
  await click('.permission-open button', 'Deny');
  await waitFor('the Ask turn to finish', async () => (await count('.turn-footer')) === 2);
  check((await count('.start-building')) === 0, 'an Ask turn offers no Start building');

  await click('.mode-picker');
  await waitFor('the mode menu for Plan', async () => (await count('.mode-menu:not([hidden]) .mode-option')) === 3);
  await click('.mode-option[data-mode="plan"]');
  await waitFor('the engine to confirm Plan', async () => (await picker()).mode === 'plan');
  check((await picker()).label === 'Plan', 'the picker names Plan', await picker());
  await send(PROMPTS.plan);
  await waitFor('the Plan turn to finish', async () => (await count('.turn-footer')) === 3);
  check((await textOf('.turn:last-child .turn-mode')) === 'Plan', 'the Plan turn is marked Plan', await textOf('.turn:last-child .turn-mode'));
  check((await count('.turn:not(:last-child) .turn-mode')) === 0, 'turns in Ask and Auto carry no mode marker');
  check((await textOf('.turn:last-child .start-building button')) === 'Start building', 'a finished Plan turn offers Start building');
  await screenshots('plan');

  await click('.start-building button');
  await waitFor('Start building to run the plan', async () => (await count('.turn-footer')) === 4);
  check((await textOf('.turn:last-child .request-bubble')) === FOLLOW_UP, 'Start building sends the follow-up', await textOf('.turn:last-child .request-bubble'));
  check((await picker()).mode === 'auto', 'Start building switches to the default mode, here Auto', await picker());
  check((await count('.start-building')) === 0, 'Start building goes once the session left Plan');
  check((await count('.turn:last-child .turn-mode')) === 0, 'the building turn ran outside Plan');
}
