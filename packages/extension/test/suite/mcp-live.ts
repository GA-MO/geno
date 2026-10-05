import * as vscode from 'vscode';

const SERVER = 'chrome-devtools';
const host = () => process.env['GCODE_FAKE_MODEL']!;

async function ui<T = unknown>(action: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${host()}/ui`, { method: 'POST', body: JSON.stringify(action) });
  const text = await response.text();
  if (!response.ok) throw new Error(`ui ${JSON.stringify(action)}: ${text}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

const panel = <T>(expression: string): Promise<T> => ui<T>({ do: 'eval', expression });
const status = () => panel<string | null>(`doc.querySelector('.mcp-server[data-server="${SERVER}"]')?.dataset.status ?? null`);

async function waitFor(what: string, probe: () => Promise<boolean>, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await probe().catch(() => false)) return;
    if (Date.now() > deadline) {
      const note = await panel<string>(`doc.querySelector('.mcp-note')?.textContent ?? ''`).catch(() => '');
      throw new Error(`timed out waiting for ${what}; ${SERVER} is ${await status().catch(() => 'unknown')}; the panel says: ${note}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Trusts chrome-devtools from the copied .mcp.json in the panel, and waits for it to start for real. */
export async function run(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('gcode.chat.mcp');
  await waitFor(`${SERVER} to wait for approval`, async () => (await status()) === 'untrusted', 60_000);
  const shown = await panel<string>(`doc.querySelector('.mcp-trust[data-trust="${SERVER}"] .mcp-trust-command').textContent`);
  console.log(`[mcp-live] the trust card shows: ${shown}`);
  await ui({ do: 'screenshot', name: 'live-trust' });
  await ui({ do: 'click', selector: `.mcp-trust[data-trust="${SERVER}"] .button`, text: 'Allow' });
  const started = Date.now();
  await waitFor(`${SERVER} to be ready`, async () => (await status()) === 'ready', 240_000);
  const tools = await panel<string>(`doc.querySelector('.mcp-server[data-server="${SERVER}"] .mcp-state').textContent`);
  console.log(`[mcp-live] ${SERVER} ready after ${Math.round((Date.now() - started) / 1000)}s: ${tools}`);
  await vscode.commands.executeCommand('notifications.clearAll');
  await ui({ do: 'screenshot', name: 'live-ready' });
}
