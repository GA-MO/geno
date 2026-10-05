import * as vscode from 'vscode';
import { THEMES } from './panel-fixture.js';
import { PROMPTS } from './style-fixture.js';

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What carries the rainbow class, each as the turn its reply belongs to or `composer`. */
const rainbows = () =>
  panel<string[]>(`[...doc.querySelectorAll('.rainbow')].map((e) => e.closest('.turn')?.dataset.turn ?? (e.closest('.composer') ? 'composer' : e.className))`);
const lastTurn = () => panel<string>(`[...doc.querySelectorAll('.turn')].at(-1).dataset.turn`);

/** The computed style of `selector` that the glass look sets: its backdrop blur and its rainbow edge. */
const looks = (selector: string) =>
  panel<{ blur: string; edge: string; animation: string; play: string }>(`(() => {
    const e = doc.querySelector(${JSON.stringify(selector)});
    const ring = getComputedStyle(e, '::before');
    return { blur: getComputedStyle(e).backdropFilter, edge: ring.content, animation: ring.animationName, play: ring.animationPlayState };
  })()`);

async function setStyle(style: 'glass' | 'native'): Promise<void> {
  await vscode.workspace.getConfiguration('gcode').update('ui.style', style, vscode.ConfigurationTarget.Global);
  await waitFor(`the panel to switch to ${style}`, async () => (await panel<string>('doc.body.dataset.style')) === style);
}

async function useTheme(theme: string): Promise<void> {
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
  await sleep(1500);
  await vscode.commands.executeCommand('notifications.clearAll');
  await sleep(300);
}

/** Glass in Dark Modern and Light Modern, native in Dark High Contrast, which keeps it whatever the setting says. */
async function screenshots(name: string): Promise<void> {
  for (const [slug, theme] of Object.entries(THEMES)) {
    await useTheme(theme);
    await ui({ do: 'screenshot', name: `${name}-${slug}` });
  }
  await useTheme(THEMES.dark);
}

async function sendWithEnter(prompt: string): Promise<void> {
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

  check((await panel<string>('doc.body.dataset.style')) === 'glass', 'the panel starts in glass, the default style');
  check((await looks('.hero')).blur.includes('blur'), 'the empty state tile is frosted glass', await looks('.hero'));
  check((await panel<string>('getComputedStyle(doc.body).backgroundImage')).includes('radial-gradient'), 'the panel paints its own glowing gradient');
  check((await panel<string>(`getComputedStyle(doc.querySelector('.hero .lid')).animationName`)) === 'blink-eye', 'Noodle still blinks in the empty state');
  // The focus command may have put the cursor in the composer; a click elsewhere takes it out.
  await click('.empty-title');
  await waitFor('nothing to run a rainbow in an idle panel', async () => (await rainbows()).length === 0);

  await click('textarea');
  await waitFor('the focused composer to run the rainbow', async () => (await rainbows()).join() === 'composer');
  check((await looks('.input-box')).animation === 'rainbow-run', 'the composer edge animates', await looks('.input-box'));
  await click('.empty-title');
  await waitFor('the rainbow to stop when the composer loses focus', async () => (await rainbows()).length === 0);
  await screenshots('empty');

  await sendWithEnter(PROMPTS.edit);
  await waitFor('the first turn to finish', async () => (await count('.turn-footer')) === 1);
  await waitFor('the diagram to draw', async () => (await count('.diagram[data-state="rendered"]')) === 1);
  check((await count('.reply.rainbow')) === 0, 'a finished turn has no rainbow');
  await click('.calls[data-step="read"] .step-row');
  await waitFor('the read step to open', async () => (await count('.call-list')) === 1);
  check((await looks('.call-list')).blur.includes('blur'), 'an opened step lists its calls on glass');
  await panel(`(doc.querySelector('.empty-title, .turn').scrollIntoView(), 1)`);
  await screenshots('finished');
  await panel(`(doc.querySelector('.diagram').previousElementSibling.scrollIntoView({ block: 'start' }), 1)`);
  await screenshots('diagram');

  await sendWithEnter(PROMPTS.remove);
  await waitFor('the permission card', async () => (await count('.permission-open')) === 1);
  await waitFor('Allow to take the focus from the composer', async () => (await panel<string>('doc.activeElement?.textContent ?? ""')) === 'Allow');
  check((await rainbows()).join() === (await lastTurn()), 'the turn waiting on the user runs the rainbow, and only it', await rainbows());
  await screenshots('permission');
  await click('.permission-open button', 'Allow');
  await waitFor('the allowed turn to finish', async () => (await count('.turn-footer')) === 2);
  check((await count('.reply.rainbow')) === 0, 'the rainbow stops when the turn finishes');

  await sendWithEnter(PROMPTS.essay);
  await waitFor('the stalled answer to stream', async () => (await panel<string | null>(`[...doc.querySelectorAll('.turn')].at(-1).querySelector('.markdown')?.textContent ?? null`))?.startsWith('Once') === true);
  await click('textarea');
  await waitFor('the live turn and the focused composer to run the rainbow', async () => (await rainbows()).join() === `${await lastTurn()},composer`);
  check((await looks('.turn:last-child .reply')).play === 'running', 'the live turn edge runs', await looks('.turn:last-child .reply'));
  await ui({ do: 'motion', value: 'reduce' });
  check((await looks('.turn:last-child .reply')).play === 'paused', 'the rainbow holds still under reduced motion', await looks('.turn:last-child .reply'));
  check((await looks('.input-box')).play === 'paused', 'the composer rainbow holds still under reduced motion', await looks('.input-box'));
  check((await looks('.turn:last-child .reply')).edge !== 'none', 'a held rainbow is still drawn');
  await ui({ do: 'motion', value: '' });
  check((await looks('.turn:last-child .reply')).play === 'running', 'the rainbow runs again without reduced motion');
  await ui({ do: 'media' });
  await screenshots('streaming');

  await setStyle('native');
  check((await looks('.request-bubble')).blur === 'none', 'native has no blur', await looks('.request-bubble'));
  check((await looks('.turn:last-child .reply')).edge === 'none', 'native draws no rainbow', await looks('.turn:last-child .reply'));
  check(!(await panel<string>('getComputedStyle(doc.body).backgroundImage')).includes('gradient'), 'native leaves the side bar background to the theme');
  await ui({ do: 'perf', label: 'native, streaming' });
  await setStyle('glass');
  check((await looks('.request-bubble')).blur.includes('blur'), 'glass comes back without a reload');

  await useTheme(THEMES['high-contrast']);
  check(await panel<boolean>(`doc.body.classList.contains('vscode-high-contrast')`), 'the theme is high contrast');
  check((await looks('.request-bubble')).blur === 'none', 'high contrast has no blur', await looks('.request-bubble'));
  check((await looks('.turn:last-child .reply')).edge === 'none', 'high contrast draws no rainbow', await looks('.turn:last-child .reply'));
  check((await looks('.input-box')).edge === 'none', 'high contrast draws no composer rainbow');
  await useTheme(THEMES.dark);

  await click('button.stop');
  await waitFor('Stop to end the turn', async () => (await count('.turn-footer')) === 3);
  await vscode.workspace.getConfiguration('gcode').update('ui.style', undefined, vscode.ConfigurationTarget.Global);
}
