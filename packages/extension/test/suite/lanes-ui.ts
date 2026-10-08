import * as vscode from 'vscode';
import { THEMES } from './lanes-fixture.js';
import { SHOOTING } from './shooting.js';

const model = () => process.env['GCODE_FAKE_MODEL']!;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function check(ok: boolean, what: string, actual?: unknown): void {
  if (!ok) throw new Error(`${what}${actual === undefined ? '' : `; got ${JSON.stringify(actual)}`}`);
}

/** `explain` adds what the panel and VS Code showed to a timeout's message. */
export async function waitFor(what: string, probe: () => Promise<boolean>, ms = 90_000, explain: () => Promise<unknown> = async () => undefined): Promise<void> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      if (await probe()) return;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      const seen = await explain().catch((error: unknown) => String(error));
      throw new Error(`timed out waiting for ${what}${last === undefined ? '' : `: ${String(last)}`}${seen === undefined ? '' : `; saw ${JSON.stringify(seen)}`}`);
    }
    await sleep(150);
  }
}

export async function ui<T = unknown>(action: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${model()}/ui`, { method: 'POST', body: JSON.stringify(action) });
  const text = await response.text();
  check(response.ok, `ui ${JSON.stringify(action)}`, text);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

export const panel = <T>(expression: string): Promise<T> => ui<T>({ do: 'eval', expression });
/** An expression evaluated in VS Code's own window, outside the webview. */
export const workbench = <T>(expression: string): Promise<T> => ui<T>({ do: 'workbench', expression });
export const click = (selector: string) => ui({ do: 'click', selector });
export const press = (key: string) => ui({ do: 'press', key });
export const textOf = (selector: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
export const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
export const shown = (selector: string) => panel<boolean>(`(() => { const e = doc.querySelector(${JSON.stringify(selector)}); return e !== null && e.getClientRects().length > 0; })()`);
export const view = () => panel<string>('doc.body.dataset.view');
export const focused = () => panel<string | null>('doc.activeElement?.dataset.focus ?? null');

async function useTheme(theme: string): Promise<void> {
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
  await sleep(1500);
}

/** The window and the panel in dark glass, light glass and high contrast. `keep` leaves VS Code's notifications up. */
export async function screenshots(name: string, keep = false): Promise<void> {
  if (!SHOOTING) return;
  await ui({ do: 'pointerAway' });
  for (const [slug, theme] of Object.entries(THEMES)) {
    await useTheme(theme);
    if (!keep) await vscode.commands.executeCommand('notifications.clearAll');
    await ui({ do: 'screenshot', name: `${name}-${slug}` });
  }
  await useTheme(THEMES.dark);
}

/** Drags the side bar's edge until the panel is `target` px wide; the width it got. */
export const panelWidth = (target: number) => ui<number>({ do: 'resize', width: target });

/**
 * Whether the composer's bottom row fits: every shown control stays inside the row, the row scrolls nothing, and no two
 * controls draw over each other. A control's box takes in its shown descendants, so text that spills out of a shrunken
 * button counts as that button's.
 */
export const rowFits = () =>
  panel<{ fits: boolean; scroll: number; client: number; outside: string[]; overlaps: string[][] }>(
    `(() => {
      const bar = doc.querySelector('.input-toolbar');
      const box = bar.getBoundingClientRect();
      const visible = (e) => e.getClientRects().length > 0;
      const outside = [...bar.querySelectorAll('*')].filter(visible).filter((e) => {
        const r = e.getBoundingClientRect();
        return r.right > box.right + 0.5 || r.left < box.left - 0.5;
      }).map((e) => e.className || e.tagName);
      const controls = [...bar.querySelectorAll('.toolbar-left > *, .toolbar-right > *')].filter(visible)
        .flatMap((e) => (e.matches('.run-status, .run-activity') ? [...e.children].filter(visible) : [e]));
      const ink = (e) => [e, ...e.querySelectorAll('*')].filter(visible).map((d) => d.getBoundingClientRect())
        .reduce((a, r) => ({ left: Math.min(a.left, r.left), right: Math.max(a.right, r.right), top: Math.min(a.top, r.top), bottom: Math.max(a.bottom, r.bottom) }));
      const boxes = controls.map((e) => ({ name: e.className.split(' ').at(-1) || e.tagName, box: ink(e) }));
      const overlaps = [];
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i].box, b = boxes[j].box;
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) overlaps.push([boxes[i].name, boxes[j].name]);
        }
      return { fits: outside.length === 0 && overlaps.length === 0 && bar.scrollWidth <= bar.clientWidth, scroll: bar.scrollWidth, client: bar.clientWidth, outside, overlaps };
    })()`,
  );

export async function openPanel(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

/** The text of VS Code's notification toasts on screen. */
export const toasts = () => workbench<string[]>(`[...document.querySelectorAll('.notifications-toasts .notification-list-item-message')].map((e) => e.textContent)`);
