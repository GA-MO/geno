import * as vscode from 'vscode';
import { LONG_COMMAND, LOOK, MANY_LINES, PROMPTS, REMOVE } from './commands-fixture.js';
import { THEMES } from './panel-fixture.js';
import { SHOOTING } from './shooting.js';

const model = () => process.env['GCODE_FAKE_MODEL']!;

function check(ok: boolean, what: string, actual?: unknown): void {
  if (!ok) throw new Error(`${what}${actual === undefined ? '' : `; got ${JSON.stringify(actual)}`}`);
}

async function waitFor(what: string, probe: () => Promise<boolean>, ms = 30_000): Promise<void> {
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
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
const textOf = (selector: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What each command step shows: its title, its IN text, its OUT text, whether the output fades, and its expand button. */
type Shown = { readonly title: string; readonly command: string; readonly output: string | null; readonly truncated: boolean; readonly more: string | null };
const steps = () =>
  panel<Shown[]>(`[...doc.querySelectorAll('.command-step')].map((s) => ({
    title: s.querySelector('.command-title').textContent,
    command: s.querySelector('.command-in').textContent,
    output: s.querySelector('.command-output')?.textContent ?? null,
    truncated: s.querySelector('.command-output')?.classList.contains('truncated') ?? false,
    more: s.querySelector('.show-all')?.textContent ?? null,
  }))`);

/** Whether the long command wraps inside its box, with nothing cut off to the right. */
const longCommandFits = () =>
  panel<{ wraps: boolean; fits: boolean; width: number }>(`(() => {
    const pre = [...doc.querySelectorAll('.command-in')].find((p) => p.textContent === ${JSON.stringify(LONG_COMMAND)});
    const line = parseFloat(getComputedStyle(pre).lineHeight);
    return { wraps: pre.clientHeight > line * 1.5, fits: pre.scrollWidth <= pre.clientWidth, width: doc.body.clientWidth };
  })()`);

async function useTheme(theme: string): Promise<void> {
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
  await sleep(1500);
  await vscode.commands.executeCommand('notifications.clearAll');
  await sleep(300);
}

/** Dark glass, light glass and high contrast, which draws native whatever the setting says: the window and the panel alone. */
async function screenshots(name: string, place: () => Promise<unknown>): Promise<void> {
  if (!SHOOTING) return;
  await ui({ do: 'pointerAway' });
  for (const [slug, theme] of Object.entries(THEMES)) {
    await useTheme(theme);
    await place();
    await sleep(500);
    await ui({ do: 'screenshot', name: `${name}-${slug}` });
    await ui({ do: 'panelshot', name: `${name}-panel-${slug}` });
  }
  await useTheme(THEMES.dark);
}

const scrollTo = (selector: string) => () => panel(`(doc.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'start' }), 1)`);

async function send(prompt: string): Promise<void> {
  await click('textarea');
  await ui({ do: 'type', text: prompt });
  await ui({ do: 'press', key: 'Enter' });
}

const widthNow = () => panel<number>('doc.body.clientWidth');

/** Narrows the side bar a step at a time until the panel is about 300px wide. */
async function narrow(): Promise<number> {
  for (let i = 0; i < 30 && (await widthNow()) > 330; i++) {
    await vscode.commands.executeCommand('gcode.chat.focus');
    await vscode.commands.executeCommand('workbench.action.decreaseViewWidth');
    await sleep(100);
  }
  return widthNow();
}

export async function run(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await vscode.workspace.getConfiguration('gcode').update('chat.detail', 'full', vscode.ConfigurationTarget.Global);
  await waitFor('the panel to show every step', async () => (await panel<string>('doc.body.dataset.detail')) === 'full');
  await send(PROMPTS.look);
  await waitFor('the look turn to finish', async () => (await count('.turn-footer')) === 1);
  await vscode.commands.executeCommand('gcode.chat.focus');
  const shown = await steps();
  check(shown.length === LOOK.length, 'every command is its own step', shown);
  check(
    JSON.stringify(shown.map((s) => s.title)) === JSON.stringify(['List the files in the project root', 'Show the entries in the notes file', 'Show details of the source, notes and build files', 'Ran a command']),
    'each step is titled by its description, and one without by the fallback',
    shown.map((s) => s.title),
  );
  check(JSON.stringify(shown.map((s) => s.command)) === JSON.stringify(LOOK.map((c) => c.input['command'])), 'each step shows its command whole', shown.map((s) => s.command));
  check(shown[0]!.output?.split('\n').includes('a.ts') === true && !shown[0]!.truncated && shown[0]!.more === null, 'a short output shows whole, with no fade', shown[0]);
  check(shown[1]!.output === MANY_LINES.slice(0, 4).join('\n') && shown[1]!.truncated, 'a long output previews its first lines and fades', shown[1]);
  check(shown[1]!.more === `Show all ${MANY_LINES.length} lines`, 'and offers to show them all', shown[1]!.more);
  check(!shown.some((s) => s.output?.includes('[exit code 0]')), 'a clean exit line is left out', shown);
  check((await count('.command-step .step-row, .command-step .tool-row')) === 0, 'a command step is one box, not a row that opens to a list');
  const width = await narrow();
  check(width >= 270 && width <= 330, 'the panel narrows to about 300px', width);
  const fits = await longCommandFits();
  check(fits.wraps && fits.fits, 'the long command wraps in its box at about 300px, nothing cut off', fits);
  await screenshots('steps-narrow', scrollTo('[data-turn="t0"] .request'));

  await click('[data-step="bash"] .show-all');
  await waitFor('the notes output to open', async () => (await steps())[1]!.output === MANY_LINES.join('\n'));
  const opened = (await steps())[1]!;
  check(!opened.truncated && opened.more === null, 'the opened output shows every line without a fade', opened);


  const stuck = await panel<{ gap: number; clipped: boolean }>(
    `(() => { const t = doc.querySelector('.transcript'); t.scrollTop = t.scrollHeight; const r = doc.querySelector('[data-turn="t0"] > .request'); const b = r.querySelector('.request-bubble'); return { gap: Math.round(r.getBoundingClientRect().top - t.getBoundingClientRect().top), clipped: getComputedStyle(b).overflow === 'hidden' }; })()`,
  );
  check(stuck.gap === 0 && stuck.clipped, 'scrolled to the end of a long turn, its request stays at the top, cut to a few lines', stuck);
  await screenshots('sticky-request', () => panel(`(() => { const t = doc.querySelector('.transcript'); t.scrollTop = t.scrollHeight; })()`));

  await send(PROMPTS.remove);
  await waitFor('the permission card', async () => (await count('.permission-open')) === 1);
  check((await textOf('.permission-open .permission-description')) === REMOVE[0]!.input['description'], 'the card shows what the command is for', await textOf('.permission-open .permission-description'));
  check((await textOf('.permission-open .permission-command')) === 'rm -rf build', 'and the full command', await textOf('.permission-open .permission-command'));
  await waitFor('one Noodle while the turn runs: the peek down, even when the window has no focus to play its duck', async () => (await panel<string>(`doc.querySelector('.peek').dataset.state`)) === 'away', 3000);
  await screenshots('permission', scrollTo('.permission-open'));
  await click('.permission-open button', 'Deny');
  await waitFor('the denied turn to finish', async () => (await count('.turn-footer')) === 2);
  const denied = (await steps()).at(-1)!;
  check(denied.title === REMOVE[0]!.input['description'] && denied.output === null, 'the denied step keeps its title and shows no output, since it never ran', denied);
  check((await textOf('[data-turn="t1"] .command-step .step-denied')) === 'Denied by you', 'and says the user denied it', await textOf('[data-turn="t1"] .command-step .step-denied'));
  check((await count('[data-turn="t1"] .command-step .step-failed')) === 0, 'not that it failed');

  await vscode.workspace.getConfiguration('gcode').update('chat.detail', undefined, vscode.ConfigurationTarget.Global);
}
