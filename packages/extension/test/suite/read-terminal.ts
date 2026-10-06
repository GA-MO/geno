import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { COMMAND, EXIT_CODE, PROMPT, TERMINAL_NAME } from './read-terminal-fixture.js';
import { check, openPanel, waitFor } from './lanes-ui.js';

/** The shell VS Code injects shell integration into: zsh on macOS, bash elsewhere. A fresh HOME keeps the user's rc files out. */
async function shellTerminal(): Promise<vscode.Terminal> {
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-term-home-'));
  const terminal = vscode.window.createTerminal({ name: TERMINAL_NAME, shellPath: process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash', env: { HOME: home } });
  terminal.show();
  await waitFor('shell integration to start in the terminal', async () => terminal.shellIntegration !== undefined, 30_000);
  return terminal;
}

function ended(terminal: vscode.Terminal): Promise<number | undefined> {
  return new Promise((resolve) => {
    const listener = vscode.window.onDidEndTerminalShellExecution((event) => {
      if (event.terminal !== terminal) return;
      listener.dispose();
      resolve(event.exitCode);
    });
  });
}

export async function run(): Promise<void> {
  await vscode.extensions.getExtension('g-code.g-code')!.activate();
  const terminal = await shellTerminal();
  const exit = ended(terminal);
  terminal.sendText(COMMAND);
  const code = await Promise.race([exit, new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20_000))]);
  check(code === EXIT_CODE, `the typed command ends with exit code ${EXIT_CODE}`, code);

  await openPanel();
  const stop = await vscode.commands.executeCommand('gcode.chat.send', PROMPT);
  check(stop === 'end_turn', 'the turn ends normally', stop);
}
