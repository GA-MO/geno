import * as vscode from 'vscode';
import { EXPIRE_ROUTE, PROMPTS, SERVER } from './mcp-sign-in-fixture.js';

const model = () => process.env['GCODE_FAKE_MODEL']!;

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
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
const visible = (selector: string) => panel<boolean>(`(() => { const e = doc.querySelector(${JSON.stringify(selector)}); return e !== null && e.offsetParent !== null; })()`);
const row = `.mcp-server[data-server="${SERVER}"]`;
const status = () => panel<string | null>(`doc.querySelector(${JSON.stringify(row)})?.dataset.status ?? null`);
const badge = () => textOf(`${row} .mcp-state`);

async function send(prompt: string, turns: number): Promise<void> {
  await ui({ do: 'press', key: 'Escape' });
  await waitFor('the chat', async () => await visible('textarea'));
  await click('textarea');
  await ui({ do: 'type', text: prompt });
  await ui({ do: 'press', key: 'Enter' });
  await waitFor(`turn ${turns} to finish`, async () => (await count('.turn-footer')) === turns);
  await vscode.commands.executeCommand('gcode.chat.mcp');
}

export async function run(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  await vscode.commands.executeCommand('gcode.chat.mcp');
  await waitFor('the workspace server to wait for approval', async () => (await status()) === 'untrusted');
  check((await count(`${row} .mcp-sign-in`)) === 0, 'an untrusted server offers no sign-in: approval comes first');
  await click(`.mcp-trust[data-trust="${SERVER}"] .button`, 'Allow');
  await waitFor('the server to need sign-in after Allow', async () => (await badge()) === 'Needs sign-in');
  check((await textOf(`${row} .mcp-sign-in .button`)) === 'Sign in', 'the row offers Sign in', await textOf(`${row} .mcp-sign-in`));
  check((await count(`${row} .mcp-tools`)) === 0, 'and no tools');

  await send(PROMPTS.unsigned, 1);

  await waitFor('the Sign in button', async () => (await count(`${row} .mcp-sign-in .button`)) === 1);
  await click(`${row} .mcp-sign-in .button`, 'Sign in');
  await waitFor('the server to be ready after sign-in', async () => (await status()) === 'ready', 90_000);
  check((await textOf(`${row} .mcp-sign-in .link-button`)) === 'Sign out', 'a signed-in server offers Sign out', await textOf(`${row} .mcp-sign-in`));
  check((await textOf(`${row} .mcp-tools`)) !== null, 'its tools are listed');

  await send(PROMPTS.signedIn, 2);

  const expired = await fetch(`${model()}${EXPIRE_ROUTE}`, { method: 'POST' });
  check(expired.ok, 'the fake authorization server expired its tokens');
  await send(PROMPTS.expired, 3);
  check((await status()) === 'ready', 'a refreshed token keeps the server ready', await status());

  await click(`${row} .mcp-sign-in .link-button`, 'Sign out');
  await waitFor('the server to need sign-in after sign-out', async () => (await badge()) === 'Needs sign-in');
  check((await textOf(`${row} .mcp-sign-in .button`)) === 'Sign in', 'Sign in is offered again', await textOf(`${row} .mcp-sign-in`));

  await send(PROMPTS.signedOut, 4);
}
