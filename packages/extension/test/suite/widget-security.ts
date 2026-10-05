import * as vscode from 'vscode';

/** The security test drives the panel over CDP from the launcher; this only opens the panel and keeps the host alive. */
async function ui(action: Record<string, unknown>): Promise<void> {
  await fetch(`${process.env['GCODE_FAKE_MODEL']!}/ui`, { method: 'POST', body: JSON.stringify(action) });
}

export async function run(): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await new Promise((r) => setTimeout(r, 2000));
  await ui({ do: 'drive' });
}
