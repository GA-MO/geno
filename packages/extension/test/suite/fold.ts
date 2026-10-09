import * as vscode from 'vscode';
import { ASKING_SUMMARY, LONG, LONG_ANSWER, LONG_SUMMARY, PROMPTS } from './fold-fixture.js';
import { THEMES } from './panel-fixture.js';
import { SHOOTING } from './shooting.js';

const model = () => process.env['GCODE_FAKE_MODEL']!;
const MODEL_NAME = 'qwen3.8-flash';

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What one turn's rail shows: each step's kind, and the fold line's label and state. */
type Rail = { readonly steps: readonly string[]; readonly fold: string | null; readonly open: string | null };
const railOf = (turn: string) =>
  panel<Rail>(`(() => {
    const t = doc.querySelector('[data-turn="${turn}"]');
    const fold = t.querySelector('.turn-fold');
    return {
      steps: [...t.querySelectorAll(':scope > .rail > .step')].map((s) => [...s.classList].find((c) => c.startsWith('step-')).slice(5)),
      fold: fold?.textContent ?? null,
      open: fold?.getAttribute('aria-expanded') ?? null,
    };
  })()`);

const topOf = (selector: string) => panel<number>(`doc.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().top`);

async function setDetail(detail: 'compact' | 'full'): Promise<void> {
  await vscode.workspace.getConfiguration('gcode').update('chat.detail', detail, vscode.ConfigurationTarget.Global);
  await waitFor(`the panel to switch to ${detail}`, async () => (await panel<string>('doc.body.dataset.detail')) === detail);
}

async function useTheme(theme: string): Promise<void> {
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
  await sleep(1500);
  await vscode.commands.executeCommand('notifications.clearAll');
  await sleep(300);
}

/** Dark glass, light glass and high contrast, which draws native whatever the setting says. */
async function screenshots(name: string, place: () => Promise<unknown>): Promise<void> {
  if (!SHOOTING) return;
  await ui({ do: 'pointerAway' });
  for (const [slug, theme] of Object.entries(THEMES)) {
    await useTheme(theme);
    await place();
    // A window nobody looks at repaints the frosted panes a moment after a long scroll.
    await sleep(500);
    await ui({ do: 'screenshot', name: `${name}-${slug}` });
  }
  await useTheme(THEMES.dark);
}

/** Scrolls the transcript to its top, where the first turn starts, or to its end, where the user follows a running turn. */
const scrollTo = (end: 'top' | 'bottom') => () => panel(`(() => { const log = doc.querySelector('.transcript'); log.scrollTop = ${end === 'top' ? 0 : 'log.scrollHeight'}; return 1; })()`);

async function send(prompt: string): Promise<void> {
  await click('textarea');
  await ui({ do: 'type', text: prompt });
  await ui({ do: 'press', key: 'Enter' });
}

export async function run(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('gcode.chat.focus');
  for (let i = 0; i < 5; i++) await vscode.commands.executeCommand('workbench.action.decreaseViewWidth');
  check((await panel<string>('doc.body.dataset.detail')) === 'compact', 'the panel starts compact, the default');

  await send(PROMPTS.long);
  await waitFor('the long turn to finish', async () => (await count('.turn-footer')) === 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('gcode.chat.focus');
  const folded = await railOf('t0');
  check(
    JSON.stringify(folded) === JSON.stringify({ steps: ['fold', 'text', 'files'], fold: LONG_SUMMARY, open: 'false' }),
    'the 20-step turn folds to its summary line, its answer and the file it changed',
    folded,
  );
  check((await panel<string>(`doc.querySelector('[data-turn="t0"] .step-text').textContent`)) === LONG_ANSWER.replace(/`/g, ''), 'the text shown is the final answer');
  const chips = await panel<string[]>(`[...doc.querySelectorAll('[data-turn="t0"] .changed-file')].map((c) => c.textContent)`);
  check(chips.join() === 'a.ts+1−1', 'the changed file shows as one chip with its line counts', chips);
  check((await count('[data-turn="t0"] .turn-footer .model')) === 0, 'the model, tokens and cost leave the folded turn');
  const tooltip = await panel<string>(`doc.querySelector('[data-turn="t0"] .turn-meta').title`);
  check(tooltip.startsWith(`${MODEL_NAME} · `) && tooltip.includes(' in · ') && tooltip.includes(' out'), 'the cost line is the tooltip of "worked for"', tooltip);
  await screenshots('long-compact', scrollTo('top'));

  // Opening the turn, from the middle of the transcript, keeps the summary line where the user clicked it.
  await panel(`(doc.querySelector('[data-turn="t0"] .turn-fold').scrollIntoView({ block: 'center' }), 1)`);
  const before = await topOf('[data-turn="t0"] .turn-fold');
  await click('[data-turn="t0"] .turn-fold');
  await waitFor('the turn to open', async () => (await railOf('t0')).open === 'true');
  const after = await topOf('[data-turn="t0"] .turn-fold');
  check(Math.abs(after - before) < 1, 'opening the turn does not move the summary line', { before, after });
  const opened = await railOf('t0');
  check(opened.steps.filter((s) => s === 'calls').length === LONG.length && opened.steps.includes('changes'), 'the opened turn shows its full trail', opened);
  check((await count('[data-turn="t0"] .turn-footer .model')) === 1, 'the opened turn shows its model, tokens and cost');
  await screenshots('expanded', scrollTo('top'));
  await click('[data-turn="t0"] .turn-fold');
  await waitFor('the turn to fold again', async () => (await railOf('t0')).open === 'false');
  check(JSON.stringify((await railOf('t0')).steps) === JSON.stringify(['fold', 'text', 'files']), 'clicking the line again folds the turn', await railOf('t0'));

  await setDetail('full');
  const full = await railOf('t0');
  check(full.fold === null && full.steps.filter((s) => s === 'calls').length === LONG.length, 'full detail shows every step, with no summary line', full);
  check((await count('[data-turn="t0"] .turn-footer .model')) === 1, 'full detail shows the model, tokens and cost');
  await screenshots('long-full', scrollTo('top'));
  await setDetail('compact');

  await send(PROMPTS.remove);
  await waitFor('the permission card', async () => (await count('.permission-open')) === 1);
  // The command's own step and its permission card can arrive in either order, so the steps are compared as a set.
  const running = await railOf('t1');
  check(
    JSON.stringify({ ...running, steps: [...running.steps].sort() }) === JSON.stringify({ steps: ['asking', 'calls', 'fold', 'permission', 'text'], fold: '+7 earlier steps', open: 'false' }),
    'the running turn shows its last four steps, the approval card among them, and folds the rest',
    running,
  );
  // Streamed text reveals over a few frames, so the narration is complete a moment after the card shows.
  await waitFor('only the latest narration to show', async () => (await panel<string[]>(`[...doc.querySelectorAll('[data-turn="t1"] .step-text')].map((s) => s.textContent)`)).join() === 'Removing the build output.');
  await screenshots('running', scrollTo('bottom'));
  await click('.permission-open button', 'Deny');
  await waitFor('the denied turn to finish', async () => (await count('.turn-footer')) === 2);
  const denied = await railOf('t1');
  // The user's no ends the turn, so no answer follows it: the summary is all the finished turn shows.
  check(denied.fold === ASKING_SUMMARY && JSON.stringify(denied.steps) === JSON.stringify(['fold']), 'the finished turn counts the denied command in its summary', denied);

  await vscode.workspace.getConfiguration('gcode').update('chat.detail', undefined, vscode.ConfigurationTarget.Global);
}
