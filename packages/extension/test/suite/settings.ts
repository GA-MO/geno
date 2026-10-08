import * as vscode from 'vscode';
import { ANSWER, ENV, MODEL, OPENAI_KEY, PROMPT, SEARCH_KEY, THEMES } from './settings-fixture.js';
import { SHOOTING } from './shooting.js';

const fake = () => process.env['GCODE_FAKE_MODEL']!;

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
  const response = await fetch(`${fake()}/ui`, { method: 'POST', body: JSON.stringify(action) });
  const text = await response.text();
  check(response.ok, `ui ${JSON.stringify(action)}`, text);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

const panel = <T>(expression: string): Promise<T> => ui<T>({ do: 'eval', expression });
const click = (selector: string, text?: string) => ui({ do: 'click', selector, ...(text === undefined ? {} : { text }) });
const press = (key: string) => ui({ do: 'press', key });
const type = (text: string) => ui({ do: 'type', text });
const textOf = (selector: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.textContent?.trim() ?? null`);
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
const visible = (selector: string) => panel<boolean>(`(() => { const e = doc.querySelector(${JSON.stringify(selector)}); return e !== null && e.offsetParent !== null; })()`);
const card = (provider: string) => `.provider-card[data-provider="${provider}"]`;
const field = (provider: string, id: string) => `${card(provider)} .provider-field[data-field="${id}"] input`;
const stateOf = (provider: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(card(provider))})?.dataset.state ?? null`);
const userValue = <T>(section: string) => vscode.workspace.getConfiguration('gcode').inspect<T>(section)?.globalValue;

/** Picks an option of a native select the way its change reaches the page; CDP cannot open the native menu. */
const choose = (selector: string, value: string) =>
  panel(`(() => { const s = doc.querySelector(${JSON.stringify(selector)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);

async function fill(selector: string, text: string): Promise<void> {
  await click(selector);
  await type(text);
  await press('Enter');
}

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

export async function run(): Promise<void> {
  const openaiUrl = process.env[ENV.openaiUrl]!;
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  await vscode.commands.executeCommand('gcode.chat.settings');
  await waitFor('the settings page', () => visible('.settings'));
  check((await count('.provider-card[data-provider]')) === 15, 'every provider has a card', await count('.provider-card[data-provider]'));
  check((await stateOf('modelstudio')) === 'ready', 'Model Studio, the chat provider, is ready on the key in the environment', await stateOf('modelstudio'));
  check(await visible(field('modelstudio', 'apiKey')), 'the chat provider starts open');
  check((await panel<string>(`doc.querySelector(${JSON.stringify(field('modelstudio', 'apiKey'))}).placeholder`)) === 'Set in the environment', 'a key from the environment reads as set, never shown');
  check((await stateOf('openai')) === 'needs', 'OpenAI waits for its key', await stateOf('openai'));
  check((await stateOf('ollama')) === 'ready', 'a local server needs no key', await stateOf('ollama'));
  check((await panel<string>(`doc.querySelector(${JSON.stringify(field('modelstudio', 'apiKey'))}).type`)) === 'password', 'the key field is a password field');
  await screenshots('settings');

  const search = '.search-card[data-search="brave"]';
  check((await panel<string | null>(`doc.querySelector(${JSON.stringify(search)})?.dataset.state ?? null`)) === 'needs', 'Brave Search waits for its key');
  await panel(`doc.querySelector(${JSON.stringify(search)}).scrollIntoView({ block: 'center' })`);
  await fill(`${search} input`, SEARCH_KEY);
  await waitFor('Brave Search to be ready once its key is set', async () => (await panel<string | null>(`doc.querySelector(${JSON.stringify(search)})?.dataset.state ?? null`)) === 'ready');
  check((await panel<string>(`doc.querySelector(${JSON.stringify(`${search} input`)}).placeholder`)) === 'Set', 'the search key reads only “Set”');
  check(!(await panel<string>('doc.documentElement.outerHTML')).includes(SEARCH_KEY), 'the search key is nowhere in the page');
  await screenshots('settings-search');
  await panel(`doc.querySelector('.settings').scrollTop = 0`);

  await click(`${card('openai')} .provider-head`);
  await waitFor('the OpenAI card to open', () => visible(field('openai', 'apiKey')));
  check(
    (await panel<string>(`doc.querySelector(${JSON.stringify(field('openai', 'baseUrl'))}).value`)) === '',
    'a base URL in the workspace settings is not shown, since it is never used',
  );
  await fill(field('openai', 'baseUrl'), openaiUrl);
  await waitFor('the base URL in the user settings', async () => userValue<Record<string, Record<string, string>>>('providers')?.['openai']?.['baseUrl'] === openaiUrl);

  await fill(field('openai', 'apiKey'), OPENAI_KEY);
  await waitFor('OpenAI to be ready once its key is set', async () => (await stateOf('openai')) === 'ready');
  check((await panel<string>(`doc.querySelector(${JSON.stringify(field('openai', 'apiKey'))}).value`)) === '', 'the field empties once the key is stored');
  check((await panel<string>(`doc.querySelector(${JSON.stringify(field('openai', 'apiKey'))}).placeholder`)) === 'Set', 'and reads only “Set”');
  check(!(await panel<string>('doc.documentElement.outerHTML')).includes(OPENAI_KEY), 'the key is nowhere in the page');
  check(JSON.stringify(vscode.workspace.getConfiguration('gcode').inspect('providers')).includes(OPENAI_KEY) === false, 'nor in the settings');

  await click(`${card('openai')} .provider-actions button`, 'List models');
  await waitFor('the models', async () => (await count(`${card('openai')} .provider-model`)) === 2);
  check((await textOf(`${card('openai')} .provider-model`)) === MODEL, 'the listed models come from the server', await textOf(`${card('openai')} .provider-model`));
  await choose('.role-row[data-role="classifier"] .role-provider', 'openai');
  await fill('.role-row[data-role="classifier"] .role-model', MODEL);
  await waitFor('the classifier role in the user settings', async () => JSON.stringify(userValue('roles')) === JSON.stringify({ classifier: { provider: 'openai', model: MODEL } }));
  check((await textOf('.role-row[data-role="tab"] .role-fixed')) === 'Local llama-server (gcode.tab.endpoint)', 'Tab names the server it runs on', await textOf('.role-row[data-role="tab"] .role-fixed'));

  await click(`${card('openai')} .provider-actions button`, 'Test connection');
  await waitFor('the test to answer', async () => (await textOf(`${card('openai')} .provider-test`))?.startsWith('Connected') === true);
  check(/^Connected to gpt-fake in \d+ ms: “OK”$/.test((await textOf(`${card('openai')} .provider-test`)) ?? ''), 'the test calls the model the classifier role runs on', await textOf(`${card('openai')} .provider-test`));
  check((await panel<string>(`doc.querySelector('${card('openai')} .provider-test').dataset.tone`)) === 'ok', 'a passing test reads as ok');
  await panel(`doc.querySelector('${card('openai')} .provider-head').scrollIntoView({ block: 'start' })`);
  await screenshots('settings-openai');

  await choose('.role-row[data-role="chat"] .role-provider', 'openai');
  await fill('.role-row[data-role="chat"] .role-model', MODEL);
  await waitFor('chat on OpenAI', async () => userValue('provider') === 'openai' && userValue('model') === MODEL);

  await press('Escape');
  await waitFor('the chat again', () => visible('textarea'));
  await click('textarea');
  await type(PROMPT);
  await press('Enter');
  await waitFor('the answer from the OpenAI adapter', async () => (await panel<string>('doc.querySelector(".transcript").textContent')).includes(ANSWER));
  check(!(await panel<string>('doc.documentElement.outerHTML')).includes(OPENAI_KEY), 'the key is nowhere in the chat either');
}
