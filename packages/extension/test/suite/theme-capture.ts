import * as vscode from 'vscode';
import { THEMES } from './panel-fixture.js';

const model = () => process.env['GCODE_FAKE_MODEL']!;

async function ui(action: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${model()}/ui`, { method: 'POST', body: JSON.stringify(action) });
  const text = await response.text();
  if (!response.ok) throw new Error(`ui ${JSON.stringify(action)}: ${text}`);
  return text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opens the chat panel at the width the panel suites use, then has the test dump the webview's theme in each theme. */
export async function run(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  for (let tries = 0; (await ui({ do: 'ready' })) !== 'true'; tries++) {
    if (tries > 200) throw new Error('the panel never rendered');
    await sleep(150);
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('gcode.chat.focus');
  for (let i = 0; i < 5; i++) await vscode.commands.executeCommand('workbench.action.decreaseViewWidth');
  for (const [slug, theme] of [...Object.entries(THEMES), ['high-contrast-light', 'Default High Contrast Light']]) {
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
    await sleep(1500);
    await ui({ do: 'dump', slug, theme });
  }
}
