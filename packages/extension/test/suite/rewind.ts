import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { ANSWERS, FILES, HAND_EDIT, PROMPTS, THEMES } from './rewind-fixture.js';
import { SHOOTING } from './shooting.js';

const model = () => process.env['GCODE_FAKE_MODEL']!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(150);
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
const press = (key: string, modifiers: string[] = []) => ui({ do: 'press', key, modifiers });
const textOf = (selector: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
const shown = (selector: string) => panel<boolean>(`(() => { const e = doc.querySelector(${JSON.stringify(selector)}); return e !== null && e.getClientRects().length > 0; })()`);
const turns = () => count('.transcript .turn');
const footers = () => count('.transcript .turn-footer');
const draft = () => panel<string>('doc.querySelector("textarea").value');
const focused = () => panel<string | null>('doc.activeElement?.dataset.action ?? doc.activeElement?.dataset.focus ?? null');
const panelWidth = (target: number) => ui<number>({ do: 'resize', width: target });

const turn = (n: number) => `.transcript .turn:nth-of-type(${n})`;
const menuOf = (n: number) => `${turn(n)} .rewind-menu`;
const workspaceFile = (file: string) => path.join(vscode.workspace.workspaceFolders![0]!.uri.fsPath, file);
const disk = (file: string) => readFile(workspaceFile(file), 'utf8');

async function useTheme(theme: string): Promise<void> {
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
  await sleep(1500);
  await vscode.commands.executeCommand('notifications.clearAll');
  await sleep(300);
}

/** Each theme's window and panel; `hover` keeps the pointer where it is, so a menu that hover shows stays drawn. */
async function screenshots(name: string, hover = false): Promise<void> {
  if (!SHOOTING) return;
  if (!hover) await ui({ do: 'pointerAway' });
  for (const [slug, theme] of Object.entries(THEMES)) {
    await useTheme(theme);
    await ui({ do: 'screenshot', name: `${name}-${slug}` });
  }
  await useTheme(THEMES.dark);
}

async function narrow(name: string): Promise<void> {
  const width = await panelWidth(300);
  check(Math.abs(width - 300) <= 4, 'the panel narrows to about 300px', width);
  await sleep(300);
  const fits = await panel<{ overflow: number; outside: string[] }>(
    `(() => {
      const log = doc.querySelector('.transcript');
      const box = log.getBoundingClientRect();
      const outside = [...log.querySelectorAll('.rewind-slot *')].filter((e) => e.getClientRects().length > 0).filter((e) => {
        const r = e.getBoundingClientRect();
        return r.right > box.right + 0.5 || r.left < box.left - 0.5;
      }).map((e) => e.className || e.tagName);
      return { overflow: log.scrollWidth - log.clientWidth, outside };
    })()`,
  );
  check(fits.overflow <= 0 && fits.outside.length === 0, `the menu and its card fit at ${width}px`, fits);
  await screenshots(name, true);
  await panelWidth(420);
}

async function send(text: string): Promise<void> {
  await click('textarea');
  await ui({ do: 'type', text });
  await press('Enter');
}

/** Opens a message's menu with the pointer, which also shows its button. */
async function openMenu(n: number): Promise<void> {
  if (!(await shown(menuOf(n)))) await click(`${turn(n)} .rewind-button`);
  await waitFor(`the menu of message ${n}`, () => shown(menuOf(n)));
}

async function choose(n: number, action: string): Promise<void> {
  await openMenu(n);
  await click(`${menuOf(n)} [data-action="${action}"]`);
}

/** The suite's failure, told to the test that launched it, which prints it: the extension host's console goes nowhere. */
export async function run(): Promise<void> {
  try {
    await steps();
  } catch (error) {
    await fetch(`${model()}/fail`, { method: 'POST', body: error instanceof Error ? (error.stack ?? error.message) : String(error) }).catch(() => {});
    throw error;
  }
}

async function steps(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await panelWidth(420);

  await send(PROMPTS.two);
  await waitFor('the first turn to end', async () => (await footers()) === 1);
  await send(PROMPTS.three);
  await waitFor('the second turn to end', async () => (await footers()) === 2);
  check((await disk('a.ts')).includes('"three"'), 'both edits landed', await disk('a.ts'));
  await waitFor('a menu on each message', async () => (await count('.transcript .rewind-button')) === 2);

  // The keyboard reaches the menu: Enter opens it on its first item, arrows move, Escape closes onto the button.
  await panel(`(doc.querySelector(${JSON.stringify(`${turn(2)} .rewind-button`)}).focus(), 1)`);
  await press('Enter');
  await waitFor('the menu to open from the keyboard', () => shown(menuOf(2)));
  check((await focused()) === 'files', 'the first item takes the keyboard', await focused());
  const items = await panel<string[]>(`[...doc.querySelectorAll(${JSON.stringify(`${menuOf(2)} .model-option-name`)})].map((e) => e.textContent)`);
  check(items.join() === 'Restore files,Restore conversation,Restore both,Fork from here,Mark a chapter here,Save as page', 'the menu offers the three rewinds, the fork, a chapter (U58) and Save as page (U66)', items);
  await press('ArrowDown');
  check((await focused()) === 'conversation', 'ArrowDown moves on', await focused());
  await press('Escape');
  await waitFor('Escape to close the menu', async () => !(await shown(menuOf(2))));
  check((await focused())?.startsWith('rewind:') === true, 'the keyboard is back on the button', await focused());

  await openMenu(2);
  await screenshots('menu', true);
  await narrow('narrow-300-menu');
  await click(`${turn(2)} .rewind-button`);
  await waitFor('the button to close its menu', async () => !(await shown(menuOf(2))));

  // Restoring files lists them first, and with an edit no checkpoint holds the keyboard starts on Cancel.
  await writeFile(workspaceFile(HAND_EDIT.file), HAND_EDIT.text);
  await choose(2, 'files');
  await waitFor('the confirm', () => shown(`${turn(2)} .rewind-confirm`));
  // VS Code may write the workspace's .vscode/settings.json meanwhile, which a restore puts back too.
  const title = (await textOf(`${turn(2)} .rewind-confirm-title`)) ?? '';
  check(/^Restore \d files to before this message: .*a\.ts, b\.ts\.$/.test(title), 'it names the files it rewrites', title);
  const loses = (await textOf(`${turn(2)} .rewind-confirm-loses`)) ?? '';
  check(/^Edits to .*b\.ts are in no checkpoint, and restoring loses them\.$/.test(loses), 'and the edit it would lose', loses);
  await waitFor('the keyboard on Cancel', async () => (await focused()) === 'cancel');
  await screenshots('confirm');
  await narrow('narrow-300-confirm');
  await press('Escape');
  await waitFor('Escape to cancel', async () => !(await shown(`${turn(2)} .rewind-confirm`)));
  check((await disk(HAND_EDIT.file)) === HAND_EDIT.text, 'a cancelled restore touches nothing');

  await choose(2, 'files');
  await waitFor('the confirm again', () => shown(`${turn(2)} .rewind-confirm`));
  await click(`${turn(2)} .rewind-confirm [data-action="confirm"]`);
  await waitFor('the restore', async () => /^Restored \d files: .*a\.ts, b\.ts\.$/.test((await textOf(`${turn(2)} .rewind-line`)) ?? ''));
  check((await disk('a.ts')).includes('"two"'), 'a.ts is as it was before the second message', await disk('a.ts'));
  check((await disk(HAND_EDIT.file)) === FILES['b.ts'], 'b.ts too, its hand edit gone', await disk(HAND_EDIT.file));
  check((await turns()) === 2, 'the conversation stays');
  const keeps = await panel<number>(`[...doc.querySelectorAll(${JSON.stringify(`${turn(2)} button`)})].filter((b) => b.textContent.trim() === 'Keep').length`);
  check(keeps === 0, 'the restored edit is no longer offered for review', keeps);
  await screenshots('restored');

  // Restoring the conversation cuts it at the message and puts the message back in the composer.
  await choose(2, 'conversation');
  await waitFor('the conversation to go back to before the message', async () => (await turns()) === 1);
  await waitFor('the message back in the composer', async () => (await draft()) === PROMPTS.three);
  await screenshots('rewound');
  await click('textarea');
  await press('selectAll', [process.platform === 'darwin' ? 'meta' : 'ctrl']);
  await press('Backspace');
  await send(PROMPTS.edited);
  await waitFor('the edited message to run', async () => (await footers()) === 2);
  check((await textOf(`${turn(2)} .request-bubble`)) === PROMPTS.edited, 'it went as edited');
  check((await textOf(`${turn(2)} .markdown`))?.includes(ANSWERS.edited) === true, 'with its answer');

  // Fork from the first message: a new chat with that turn, which takes a turn of its own.
  await choose(1, 'fork');
  await waitFor('the fork to show', async () => (await turns()) === 1 && (await footers()) === 1);
  check((await textOf(`${turn(1)} .request-bubble`)) === PROMPTS.two, 'the fork holds the first message');
  await send(PROMPTS.forked);
  await waitFor('the fork’s own turn', async () => (await footers()) === 2);

  await vscode.commands.executeCommand('gcode.chat.history');
  await waitFor('the fork in the history, linked to its origin', async () => (await count('.history-fork')) === 1);
  check((await textOf('.history-fork')) === `Forked from ${PROMPTS.two}`, 'the link names the origin', await textOf('.history-fork'));
  await screenshots('history');
  await narrow('narrow-300-history');
  await click('.history-fork');
  await waitFor('the origin to load', async () => (await turns()) === 2 && (await textOf(`${turn(2)} .request-bubble`)) === PROMPTS.edited);

  await vscode.commands.executeCommand('gcode.chat.tasks');
  await waitFor('the fork in Tasks, linked to its origin', async () => (await count('.task-fork')) === 1);
  check((await textOf('.task-fork')) === `Forked from ${PROMPTS.two}`, 'the Tasks link names the origin', await textOf('.task-fork'));
  await screenshots('tasks');
}
