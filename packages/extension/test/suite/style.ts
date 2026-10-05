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

/** What carries the rainbow class, each as `composer` or the class of whatever else does. */
const rainbows = () => panel<string[]>(`[...doc.querySelectorAll('.rainbow')].map((e) => (e.closest('.composer') ? 'composer' : e.className))`);

/** The composer's rainbow ring as drawn: whether it shows, and the state of each rainbow animation on the page. */
const ring = () =>
  panel<{ display: string; plays: string[] }>(`({
    display: getComputedStyle(doc.querySelector('.ring')).display,
    plays: doc.getAnimations().filter((a) => a.animationName === 'rainbow-run').map((a) => a.playState),
  })`);
const isRunning = (r: { display: string; plays: string[] }) => r.display !== 'none' && r.plays.join() === 'running';

/** The primary buttons' white fill in the glass style. */
const WHITE = 'rgb(242, 242, 242)';
const fillOf = (selector: string) => panel<string>(`getComputedStyle(doc.querySelector(${JSON.stringify(selector)})).backgroundColor`);

const blurOf = (selector: string) => panel<string>(`getComputedStyle(doc.querySelector(${JSON.stringify(selector)})).backdropFilter`);

/** The rail segment leading into the step waiting on the user: its image and its animation. */
const waitingSegment = () =>
  panel<{ image: string; animation: string }>(`(() => {
    const s = getComputedStyle(doc.querySelector('.turn:last-child .node-wait'), '::before');
    return { image: s.backgroundImage, animation: s.animationName };
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
  await ui({ do: 'pointerAway' });
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

  const views = await ui<string[]>({ do: 'evalPage', expression: `[...document.querySelectorAll('.sidebar .pane-header .title')].map((t) => t.textContent)` });
  check(views.includes('Chat') && !views.includes('Changes'), 'the Changes view is hidden by default, so the chat fills the side bar', views);
  check((await panel<string>('doc.body.dataset.style')) === 'glass', 'the panel starts in glass, the default style');
  const framed = () =>
    panel<string[]>(
      `[...doc.querySelectorAll('.dino')].map((e) => getComputedStyle(e)).filter((c) => c.backgroundColor !== 'rgba(0, 0, 0, 0)' || c.backgroundImage !== 'none' || c.borderTopStyle !== 'none' || c.boxShadow !== 'none' || c.outlineStyle !== 'none').map((c) => c.cssText || 'framed')`,
    );
  check((await count('.dino')) > 0 && (await framed()).length === 0, 'Noodle stands on the glass with no tile, border or shadow', await framed());
  const surface = await panel<{ image: string; color: string }>(`({ image: getComputedStyle(doc.body).backgroundImage, color: getComputedStyle(doc.body).backgroundColor })`);
  check(surface.image === 'none' && surface.color === 'rgb(30, 30, 32)', 'the panel is a plain dark surface, with no gradient or glow', surface);
  const motion = await panel<string>(`doc.querySelector('.start-page').dataset.motion`);
  check(motion === (vscode.window.state.focused ? 'moving' : 'paused'), 'Noodle wanders the start page in glass while the window is focused', motion);

  // The rainbow does not depend on focus: it runs with the composer focused and without.
  await click('.start-name');
  check((await rainbows()).join() === 'composer', 'only the composer carries the rainbow', await rainbows());
  check(isRunning(await ring()), 'the composer rainbow runs while the composer is not focused', await ring());
  await click('textarea');
  check(isRunning(await ring()), 'the composer rainbow runs while the composer is focused', await ring());
  await screenshots('empty');

  await sendWithEnter(PROMPTS.edit);
  await waitFor('the first turn to finish', async () => (await count('.turn-footer')) === 1);
  await waitFor('the diagram to draw', async () => (await count('.diagram[data-state="rendered"]')) === 1);
  check((await rainbows()).join() === 'composer', 'a finished turn has no rainbow; the composer keeps it', await rainbows());
  await click('.calls[data-step="read"] .step-row');
  await waitFor('the read step to open', async () => (await count('.call-list')) === 1);
  check((await blurOf('.call-list')).includes('blur'), 'an opened step lists its calls on glass');
  const bubble = await panel<{ fill: string; blur: string }>(`(() => { const s = getComputedStyle(doc.querySelector('.request-bubble')); return { fill: s.backgroundColor, blur: s.backdropFilter }; })()`);
  check(bubble.fill === 'rgba(255, 255, 255, 0.07)' && bubble.blur.includes('blur'), 'the user message is neutral glass, with no accent tint', bubble);
  await panel(`(doc.querySelector('.turn').scrollIntoView(), 1)`);
  await screenshots('finished');
  await ui({ do: 'hover', selector: '.transcript' });
  await ui({ do: 'panelshot', name: 'scrollbar-dark' });
  await ui({ do: 'media', label: 'idle', gif: true });
  await panel(`(doc.querySelector('.diagram').previousElementSibling.scrollIntoView({ block: 'start' }), 1)`);
  await screenshots('diagram');

  await sendWithEnter(PROMPTS.remove);
  await waitFor('the permission card', async () => (await count('.permission-open')) === 1);
  check((await rainbows()).join() === 'composer', 'the turn waiting on the user has no rainbow; the composer keeps it', await rainbows());
  check(isRunning(await ring()), 'the composer rainbow runs while a turn works', await ring());
  const allow = await panel<{ fill: string; ink: string }>(`(() => { const s = getComputedStyle(doc.querySelector('.permission-open .button')); return { fill: s.backgroundColor, ink: s.color }; })()`);
  check(allow.fill === WHITE && allow.ink === 'rgb(10, 10, 10)', 'Allow, a primary action, is white with dark text', allow);
  check((await fillOf('.permission-open .button.secondary')) !== WHITE, 'Deny, a secondary action, stays quiet', await fillOf('.permission-open .button.secondary'));
  await useTheme(THEMES.light);
  const light = await panel<{ surface: string; allow: string; ink: string }>(`(() => {
    const allow = getComputedStyle(doc.querySelector('.permission-open .button'));
    return { surface: getComputedStyle(doc.body).backgroundColor, allow: allow.backgroundColor, ink: allow.color };
  })()`);
  check(light.surface === 'rgb(245, 245, 245)', 'a light theme gets light glass on a plain light surface', light);
  check(light.allow === 'rgb(23, 23, 23)' && light.ink === 'rgb(255, 255, 255)', 'on light glass the primary action is near-black with white text', light);
  check((await blurOf('.permission')).includes('blur'), 'light glass is frosted too');
  await useTheme(THEMES.dark);
  const flowing = await waitingSegment();
  check(flowing.animation === 'rail-flow' && flowing.image.includes('repeating-linear-gradient'), 'the rail into the waiting step is dots flowing down', flowing);
  await ui({ do: 'motion', value: 'reduce' });
  const held = await ring();
  check(held.plays.join() === 'paused' && held.display !== 'none', 'the rainbow holds still, still drawn, under reduced motion', held);
  check((await waitingSegment()).animation === 'none', 'the rail dots hold still under reduced motion', await waitingSegment());
  await ui({ do: 'motion', value: '' });
  check(isRunning(await ring()), 'the rainbow runs again without reduced motion', await ring());
  await screenshots('permission');
  // The rail comparison, in dark and light glass: the shipped hairline, then the whole rail as static 1px dots with 4px gaps.
  for (const [suffix, theme] of [['', THEMES.dark], ['-light', THEMES.light]] as const) {
    await useTheme(theme);
    await ui({ do: 'panelshot', name: `rail-hairline${suffix}` });
    await panel(
      `([...doc.querySelectorAll('.rail')].forEach((r) => { r.style.setProperty('--rail-finished', 'var(--rail-dots)'); r.style.setProperty('--rail-flow', 'var(--rail-dots)'); }),
        doc.getAnimations().filter((a) => a.animationName === 'rail-flow').forEach((a) => a.pause()), 1)`,
    );
    await ui({ do: 'panelshot', name: `rail-dotted${suffix}` });
    await panel(`([...doc.querySelectorAll('.rail')].forEach((r) => r.removeAttribute('style')), doc.getAnimations().filter((a) => a.animationName === 'rail-flow').forEach((a) => a.play()), 1)`);
  }
  await ui({ do: 'hover', selector: '.transcript' });
  await ui({ do: 'panelshot', name: 'scrollbar-light' });
  await useTheme(THEMES.dark);
  await click('.permission-open button', 'Allow');
  await waitFor('the allowed turn to finish', async () => (await count('.turn-footer')) === 2);

  await sendWithEnter(PROMPTS.essay);
  await waitFor('the stalled answer to stream', async () => (await panel<string | null>(`[...doc.querySelectorAll('.turn')].at(-1).querySelector('.markdown')?.textContent ?? null`))?.startsWith('Once') === true);
  check((await rainbows()).join() === 'composer', 'the streaming turn has no rainbow; the composer keeps it', await rainbows());
  await ui({ do: 'media', label: 'streaming' });
  await screenshots('streaming');

  await setStyle('native');
  check((await blurOf('.request-bubble')) === 'none', 'native has no blur', await blurOf('.request-bubble'));
  check((await ring()).display === 'none', 'native draws no rainbow', await ring());
  await ui({ do: 'perf', label: 'native, streaming' });
  await setStyle('glass');
  check((await blurOf('.request-bubble')).includes('blur'), 'glass comes back without a reload');

  await useTheme(THEMES['high-contrast']);
  check(await panel<boolean>(`doc.body.classList.contains('vscode-high-contrast')`), 'the theme is high contrast');
  check((await blurOf('.request-bubble')) === 'none', 'high contrast has no blur', await blurOf('.request-bubble'));
  check((await ring()).display === 'none', 'high contrast draws no rainbow', await ring());
  check((await fillOf('button.send')) !== WHITE, 'high contrast keeps the native button colors', await fillOf('button.send'));
  await useTheme(THEMES.dark);

  await click('button.stop');
  await waitFor('Stop to end the turn', async () => (await count('.turn-footer')) === 3);
  await vscode.workspace.getConfiguration('gcode').update('ui.style', undefined, vscode.ConfigurationTarget.Global);
}
