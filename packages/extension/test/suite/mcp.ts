import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { ENV, PROMPTS, THEMES, USER_SERVER, WORKSPACE_SERVER } from './mcp-fixture.js';
import { SHOOTING } from './shooting.js';

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
const row = (name: string) => `.mcp-server[data-server="${name}"]`;
const status = (name: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(row(name))})?.dataset.status ?? null`);

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
  await click('textarea');
  await ui({ do: 'type', text: prompt });
  await ui({ do: 'press', key: 'Enter' });
}

export async function run(): Promise<void> {
  const marker = process.env[ENV.workspaceMarker]!;
  const command = process.env[ENV.workspaceCommand]!;
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  for (let i = 0; i < 5; i++) await vscode.commands.executeCommand('workbench.action.decreaseViewWidth');

  await vscode.commands.executeCommand('gcode.chat.mcp');
  await waitFor('the user server to be ready', async () => (await status(USER_SERVER)) === 'ready');
  check((await textOf(`${row(USER_SERVER)} .mcp-source`)) === 'VS Code user settings', 'the user server comes from the user mcp.json, forwarded', await textOf(`${row(USER_SERVER)} .mcp-source`));
  check((await status(WORKSPACE_SERVER)) === 'untrusted', 'the workspace server is not forwarded: it waits for approval', await status(WORKSPACE_SERVER));
  check((await textOf(`${row(WORKSPACE_SERVER)} .mcp-source`)) === '.vscode/mcp.json', 'the workspace server is named by its file', await textOf(`${row(WORKSPACE_SERVER)} .mcp-source`));
  const shown = await textOf(`.mcp-trust[data-trust="${WORKSPACE_SERVER}"] .mcp-trust-command`);
  check(shown === command, 'the trust card shows the exact command it would run', { shown, command });
  check((await textOf(`.mcp-trust[data-trust="${WORKSPACE_SERVER}"] .mcp-field-value`)) === `MARKER=${marker}`, 'the trust card shows the env it sets', await textOf(`.mcp-trust .mcp-field-value`));
  check((await count(`${row(USER_SERVER)} .mcp-trust`)) === 0, 'a server the user owns asks for nothing');
  await screenshots('trust');

  await ui({ do: 'press', key: 'Escape' });
  await waitFor('Escape to close the servers', async () => !(await visible('.mcp')) && (await visible('textarea')));
  check(await visible('.mcp-notice'), 'the chat says a workspace server waits for approval');
  check((await count('.mcp-trust')) === 1, 'the trust card stays until the user decides');
  check((await textOf('.mcp-notice-text')) === '1 MCP server in this workspace waits for your approval.', 'the notice counts the waiting server', await textOf('.mcp-notice-text'));
  await send(PROMPTS.first);
  await waitFor('the first turn to finish', async () => (await count('.turn-footer')) === 1);
  check(!existsSync(marker), 'the untrusted workspace server never ran');
  await screenshots('notice');

  await click('.mcp-notice .link-button', 'Review');
  await waitFor('the servers again', async () => (await visible(`.mcp-trust[data-trust="${WORKSPACE_SERVER}"]`)));
  await click(`.mcp-trust[data-trust="${WORKSPACE_SERVER}"] .button`, 'Allow');
  await waitFor('the workspace server to be ready after Allow', async () => (await status(WORKSPACE_SERVER)) === 'ready');
  check(existsSync(marker), 'once allowed, the workspace server runs');
  check((await count('.mcp-trust')) === 0, 'Allow takes the trust card away');
  check(!(await panel<boolean>(`!doc.querySelector('.mcp-notice').hidden`)), 'and the notice');
  await screenshots('ready');

  await click(`${row(USER_SERVER)} .mcp-switch`);
  await waitFor('the user server to turn off', async () => (await status(USER_SERVER)) === 'disabled');
  check((await panel<string>(`doc.querySelector(${JSON.stringify(`${row(USER_SERVER)} .mcp-switch`)}).getAttribute('aria-checked')`)) === 'false', 'the switch reads off');
  await screenshots('off');
  await click(`${row(USER_SERVER)} .mcp-switch`);
  await waitFor('the user server to come back', async () => (await status(USER_SERVER)) === 'ready');

  await ui({ do: 'press', key: 'Escape' });
  await waitFor('the chat again', async () => await visible('textarea'));
  await send(PROMPTS.second);
  await waitFor('the second turn to finish', async () => (await count('.turn-footer')) === 2);
  const step = `.calls[data-step="mcp__${USER_SERVER}__echo"]`;
  check((await textOf(`${step} .mcp-call-server`)) === USER_SERVER, 'the rail names the MCP server of the call', await textOf(`${step} .mcp-call-server`));
  check((await textOf(`${step} .step-verb`)) === 'echo', 'and the tool by its own name', await textOf(`${step} .step-verb`));
  await screenshots('rail');
}
