import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { run as editUnsavedBuffer } from './chat-live.js';
import { completeIn } from './index.js';

function check(ok: boolean, what: string, actual?: unknown): void {
  if (!ok) throw new Error(`${what}${actual === undefined ? '' : `; got ${JSON.stringify(actual)}`}`);
}

/** The chat step: against the fake model a turn that runs one command, against a real one the live smoke's edit. */
const CHATS: Readonly<Record<string, () => Promise<void>>> = {
  fake: async () => {
    const stop = await vscode.commands.executeCommand('gcode.chat.send', 'Write the proof file.');
    check(stop === 'end_turn', 'the turn ends normally', stop);
  },
  live: editUnsavedBuffer,
};

/** The extension as a user has it: installed from the .vsix, no node on PATH, the key set through the command. */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('g-code.g-code');
  const installedIn = process.env['GCODE_TEST_EXTENSIONS_DIR']!;
  check(extension?.extensionPath.startsWith(installedIn) === true, `g-code runs from ${installedIn}`, extension?.extensionPath);
  const dirs = (process.env['PATH'] ?? '').split(path.delimiter);
  const nodes = await Promise.all(dirs.map((dir) => access(path.join(dir, 'node')).then(() => dir, () => undefined)));
  check(nodes.every((dir) => dir === undefined), 'no node on the extension host PATH', process.env['PATH']);
  await extension!.activate();

  const keyFile = process.env['GCODE_TEST_KEY_FILE']!;
  const key = (await readFile(keyFile, 'utf8')).trim();
  await rm(keyFile);
  await vscode.commands.executeCommand('gcode.setApiKey', key);

  await CHATS[process.env['GCODE_TEST_CHAT'] ?? 'fake']!();
  await completeIn('add.ts');
  const screenshot = process.env['GCODE_TEST_SCREENSHOT'];
  if (screenshot !== undefined) check((await fetch(screenshot, { method: 'POST' })).ok, 'screenshot');
}
