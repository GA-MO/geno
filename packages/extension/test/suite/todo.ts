import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { ANSWERS, PROMPT, RELEASES, THEMES } from './todo-fixture.js';
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
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
const textOf = (selector: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const footers = () => count('.transcript .turn-footer');
const panelWidth = (target: number) => ui<number>({ do: 'resize', width: target });
const release = (file: string) => writeFile(path.join(vscode.workspace.workspaceFolders![0]!.uri.fsPath, file), '');

type Shown = {
  /** The step kinds of the turn's rail, in order. */
  readonly rail: readonly string[];
  readonly pinned: boolean;
  readonly open: boolean;
  readonly line: string | null;
  readonly items: readonly { readonly status: string; readonly text: string; readonly spins: boolean; readonly opacity: number; readonly shown: boolean }[];
};

/** The list on turn `n` as the user sees it: where it stands on the rail, its line, and each item's state. */
const listOf = (n: number) =>
  panel<Shown>(`(() => {
    const turn = doc.querySelector('.transcript .turn:nth-of-type(${n})');
    const todo = turn.querySelector('.todo');
    return {
      rail: [...turn.querySelectorAll(':scope > .rail > .step')].map((s) => [...s.classList].find((c) => c.startsWith('step-')).slice(5)),
      pinned: todo?.dataset.pinned === 'true',
      open: todo?.querySelector('.todo-head')?.getAttribute('aria-expanded') === 'true',
      line: todo?.querySelector('.todo-line')?.textContent ?? null,
      items: [...(todo?.querySelectorAll('.todo-item') ?? [])].map((li) => ({
        status: li.dataset.status,
        text: li.querySelector('.todo-text').textContent,
        spins: li.querySelector('.todo-mark').classList.contains('codicon-modifier-spin'),
        opacity: Number(getComputedStyle(li).opacity),
        shown: li.getClientRects().length > 0,
      })),
    };
  })()`);

async function useTheme(theme: string): Promise<void> {
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
  await sleep(1500);
  await vscode.commands.executeCommand('notifications.clearAll');
  await sleep(300);
}

async function screenshots(name: string): Promise<void> {
  if (!SHOOTING) return;
  await ui({ do: 'pointerAway' });
  for (const [slug, theme] of Object.entries(THEMES)) {
    await useTheme(theme);
    await ui({ do: 'screenshot', name: `${name}-${slug}` });
  }
  await useTheme(THEMES.dark);
}

/** At about 300px the list and its line stay inside the transcript, with no sideways scroll. */
async function narrow(name: string): Promise<void> {
  const width = await panelWidth(300);
  check(Math.abs(width - 300) <= 4, 'the panel narrows to about 300px', width);
  await sleep(300);
  const fits = await panel<{ overflow: number; outside: string[]; lineCut: boolean; items: number }>(
    `(() => {
      const log = doc.querySelector('.transcript');
      const box = log.getBoundingClientRect();
      const parts = [...log.querySelectorAll('.todo, .todo *')].filter((e) => e.getClientRects().length > 0);
      const outside = parts.filter((e) => { const r = e.getBoundingClientRect(); return r.right > box.right + 0.5 || r.left < box.left - 0.5; }).map((e) => e.className || e.tagName);
      const line = log.querySelector('.todo-line');
      return { overflow: log.scrollWidth - log.clientWidth, outside, lineCut: line.scrollWidth > line.clientWidth, items: log.querySelectorAll('.todo-item').length };
    })()`,
  );
  check(fits.overflow <= 0 && fits.outside.length === 0, `the list fits at ${width}px`, fits);
  await screenshots(name);
  await panelWidth(420);
}

async function send(text: string): Promise<void> {
  await click('textarea');
  await ui({ do: 'type', text });
  await press('Enter');
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

  await click('.mode-picker');
  await waitFor('the mode menu', async () => (await count('.mode-menu:not([hidden]) .mode-option')) === 3);
  await click('.mode-option[data-mode="plan"]');
  await waitFor('the engine to confirm Plan', async () => (await panel<string>('doc.querySelector(".mode-picker")?.dataset.mode ?? ""')) === 'plan');
  await send(PROMPT);
  await waitFor('the Plan turn to finish', async () => (await footers()) === 1);
  const plan = await listOf(1);
  check(plan.rail.join() === 'text,todo,text', 'the plan keeps its list where it was set, before the answer', plan.rail);
  check(!plan.pinned && !plan.open && plan.line === '0 of 3 done', 'once the turn ended, the list folds to its line', plan);
  check(plan.items.every((item) => !item.shown), 'folded, no item shows', plan.items);
  const answerOf = () => panel<string | undefined>('[...doc.querySelectorAll(".turn:last-child .markdown")].at(-1)?.textContent');
  check((await answerOf())?.includes(ANSWERS.plan) === true, 'the plan answers', await answerOf());

  await click('.start-building button');
  await waitFor('the building turn to start', async () => (await count('.transcript .turn')) === 2);
  await waitFor('the plan pinned before any call', async () => (await listOf(2)).pinned);
  const carried = await listOf(2);
  check(carried.open && carried.items.length === 3 && carried.items.every((item) => item.status === 'pending'), "Start building pins the plan's own list, open", carried);
  await ui({ do: 'release', name: 'build' });

  await waitFor('the second item in progress', async () => (await listOf(2)).items[1]?.status === 'in_progress');
  await waitFor('the second command to run', async () => (await listOf(2)).rail.at(-1) === 'calls');
  const running = await listOf(2);
  check(running.rail.at(-2) === 'todo' && running.rail.indexOf('todo') === running.rail.length - 2, 'the list stands right above the latest step', running.rail);
  check(running.line === '1 of 3 done · write the tests for beta', 'the line counts and names the item in progress', running.line);
  check(running.items[0]!.status === 'done' && running.items[0]!.opacity < 0.7, 'a done item is dimmed', running.items[0]);
  check(running.items[1]!.spins && !running.items[0]!.spins && !running.items[2]!.spins, 'only the item in progress spins', running.items);
  check((await count('.todo')) === 2, 'the plan keeps its own list in the first turn', await count('.todo'));
  await screenshots('pinned');
  await narrow('narrow-300-pinned');

  await click('.turn:nth-of-type(2) .todo-head');
  await waitFor('the pinned list to fold', async () => !(await listOf(2)).open);
  const folded = await listOf(2);
  check(folded.items.every((item) => !item.shown), 'folded, the pinned list is one line', folded);
  const height = await panel<number>('doc.querySelector(".turn:nth-of-type(2) .todo").getBoundingClientRect().height');
  check(height < 40, 'the folded list is one line high', height);
  await screenshots('pinned-folded');
  await click('.turn:nth-of-type(2) .todo-head');
  await waitFor('the pinned list to open again', async () => (await listOf(2)).open);

  await release(RELEASES.write);
  await waitFor('the building turn to finish', async () => (await footers()) === 2);
  const kept = await listOf(2);
  check(!kept.pinned && kept.rail.at(-2) === 'todo' && kept.rail.at(-1) === 'text', 'the list stays where it last changed, before the answer', kept.rail);
  check(kept.line === '3 of 3 done' && !kept.open, 'the finished list folds to its line', kept);
  await click('.turn:nth-of-type(2) .todo-head');
  await waitFor('the kept list to open', async () => (await listOf(2)).open);
  check((await listOf(2)).items.every((item) => item.status === 'done' && item.shown && !item.spins), 'opened, every item is done', await listOf(2));
  await screenshots('kept');
  await narrow('narrow-300-kept');
}
