import * as vscode from 'vscode';
import { PROMPT, THEMES } from './browser-fixture.js';

const model = () => process.env['GCODE_FAKE_MODEL']!;

function check(ok: boolean, what: string, actual?: unknown): void {
  if (!ok) throw new Error(`${what}${actual === undefined ? '' : `; got ${JSON.stringify(actual)}`}`);
}

async function waitFor(what: string, probe: () => Promise<boolean>, ms = 90_000): Promise<void> {
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
const textOf = (selector: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
const visible = (selector: string) => panel<boolean>(`(() => { const e = doc.querySelector(${JSON.stringify(selector)}); return e !== null && e.offsetParent !== null; })()`);
const ROW = '.mcp-server[data-server="browser"]';
const status = () => panel<string | null>(`doc.querySelector(${JSON.stringify(ROW)})?.dataset.status ?? null`);

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
  for (let i = 0; i < 5; i++) await vscode.commands.executeCommand('workbench.action.decreaseViewWidth');

  check(vscode.workspace.getConfiguration('gcode').get('browser.enabled') === false, 'the browser is off by default');
  await vscode.commands.executeCommand('gcode.chat.mcp');
  await waitFor('the browser row', async () => (await status()) === 'disabled');
  check((await textOf(`${ROW} .mcp-source`)) === 'Built in', 'the browser is built in', await textOf(`${ROW} .mcp-source`));
  check((await count(`${ROW} .mcp-trust`)) === 0, 'the built-in browser needs no trust card');
  check((await textOf(`${ROW} .mcp-state`)) === 'Off', 'it reads off', await textOf(`${ROW} .mcp-state`));

  await click(`${ROW} .mcp-switch`);
  await waitFor('the switch to turn the browser on', async () => (await status()) === 'stopped');
  check(vscode.workspace.getConfiguration('gcode').get('browser.enabled') === true, 'the switch writes the gcode.browser.enabled setting');
  check((await textOf(`${ROW} .mcp-state`)) === 'Starts on first use', 'Chrome waits for the first browser step', await textOf(`${ROW} .mcp-state`));
  check((await panel<string>(`doc.querySelector(${JSON.stringify(`${ROW} .mcp-switch`)}).getAttribute('aria-checked')`)) === 'true', 'the switch reads on');
  await screenshots('pane');

  await ui({ do: 'press', key: 'Escape' });
  await waitFor('the chat again', async () => await visible('textarea'));
  await click('textarea');
  await ui({ do: 'type', text: PROMPT });
  await ui({ do: 'press', key: 'Enter' });
  await waitFor('the turn to finish', async () => (await count('.turn-footer')) === 1);
  const step = '.calls[data-step="mcp__browser__take_screenshot"]';
  check((await textOf(`${step} .mcp-call-server`)) === 'browser', 'the rail names the browser as the server', await textOf(`${step} .mcp-call-server`));
  await waitFor('the screenshot thumbnail to load', () =>
    panel<boolean>(`(() => { const img = doc.querySelector('.step-images .thumb img'); return img !== null && img.complete && img.naturalWidth > 0; })()`),
  );
  await screenshots('rail');

  await vscode.commands.executeCommand('gcode.chat.mcp');
  await waitFor('the browser to read ready after its first step', async () => (await status()) === 'ready');
}
