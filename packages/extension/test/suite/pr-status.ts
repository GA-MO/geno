import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { THEMES, TITLE, type StageName } from './pr-status-fixture.js';
import { SHOOTING } from './shooting.js';

const server = () => process.env['GCODE_FAKE_MODEL']!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    await sleep(150);
  }
}

async function ui<T = unknown>(action: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${server()}/ui`, { method: 'POST', body: JSON.stringify(action) });
  const text = await response.text();
  check(response.ok, `ui ${JSON.stringify(action)}`, text);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

const stage = async (name: StageName) => check((await fetch(`${server()}/stage`, { method: 'POST', body: name })).ok, `the fake gh at ${name}`);
const panel = <T>(expression: string): Promise<T> => ui<T>({ do: 'eval', expression });
const click = (selector: string) => ui({ do: 'click', selector });
const textOf = (selector: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const shown = (selector: string) => panel<boolean>(`(() => { const e = doc.querySelector(${JSON.stringify(selector)}); return e !== null && e.getClientRects().length > 0; })()`);
const panelWidth = (target: number) => ui<number>({ do: 'resize', width: target });

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

/** The line fits the panel: nothing past its edge, and the number and the counts are never cut. */
const fits = () =>
  panel<{ overflow: number; outside: string[]; clipped: string[] }>(`(() => {
    const slot = doc.querySelector('.pr-status-slot');
    const box = slot.getBoundingClientRect();
    const all = [...slot.querySelectorAll('*')].filter((e) => e.getClientRects().length > 0);
    const outside = all.filter((e) => { const r = e.getBoundingClientRect(); return r.right > box.right + 0.5 || r.left < box.left - 0.5; }).map((e) => e.className || e.tagName);
    const clipped = [...slot.querySelectorAll('.pr-number, .pr-count')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.className);
    return { overflow: doc.documentElement.scrollWidth - doc.documentElement.clientWidth, outside, clipped };
  })()`);

/** The suite's failure, told to the test that launched it, which prints it: the extension host's console goes nowhere. */
export async function run(): Promise<void> {
  try {
    await steps();
  } catch (error) {
    await fetch(`${server()}/fail`, { method: 'POST', body: error instanceof Error ? (error.stack ?? error.message) : String(error) }).catch(() => {});
    throw error;
  }
}

async function steps(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await panel<number>(`doc.querySelectorAll('.transcript').length`)) === 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await panelWidth(420);

  await waitFor('the status line with the PR', async () => (await textOf('.pr-status .pr-number')) === '#42');
  check((await textOf('.pr-status .pr-title')) === TITLE, 'it shows the title', await textOf('.pr-status .pr-title'));
  check((await textOf('.pr-status .pr-state')) === 'Review required', 'and the state with the review decision', await textOf('.pr-status .pr-state'));
  check((await textOf('.pr-status .pr-pending')) === '1' && (await textOf('.pr-status .pr-pass')) === '1', 'and one pending, one passed', await textOf('.pr-checks'));
  check(!(await shown('.pr-status .pr-fail')), 'and nothing failed yet');
  const label = (await panel<string | null>(`doc.querySelector('.pr-status').getAttribute('aria-label')`)) ?? '';
  check(label.includes('checks 1 pending, 1 passed'), 'a screen reader hears the counts', label);
  await screenshots('pending');

  await stage('failing');
  await waitFor('the line to show the failure by itself while a check was pending', async () => (await textOf('.pr-status .pr-fail')) === '1');
  check(!(await shown('.pr-status .pr-pending')), 'nothing is pending any more');
  const tooltip = (await panel<string | null>(`doc.querySelector('.pr-status').title`)) ?? '';
  check(tooltip.includes('✗ test') && tooltip.includes('✓ lint'), 'the tooltip names each check', tooltip);
  await screenshots('failed');

  const width = await panelWidth(300);
  check(Math.abs(width - 300) <= 4, 'the panel narrows to about 300px', width);
  await sleep(300);
  const narrow = await fits();
  check(narrow.overflow <= 0 && narrow.outside.length === 0 && narrow.clipped.length === 0, `the line fits at ${width}px`, narrow);
  check(!(await shown('.pr-status .pr-state')), 'the state gives way first at a narrow panel');
  await screenshots('failed-300');
  await panelWidth(420);

  await stage('logged-out');
  const head = path.join(vscode.workspace.workspaceFolders![0]!.uri.fsPath, '.git', 'HEAD');
  await writeFile(head, 'ref: refs/heads/cart-total\n');
  await waitFor('the hint to log in, after HEAD moved', async () => (await textOf('.pr-status .pr-help-text')) === "Run gh auth login in a terminal to see this branch's PR here.");
  await screenshots('login-hint');
  await click('.pr-help-close');
  await waitFor('the hint to hide', async () => !(await shown('.pr-status-slot')));
}
