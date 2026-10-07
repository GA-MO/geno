import { afterAll, describe, expect, it } from 'vitest';
import { ANSWER, EDIT, PROMPTS } from '../suite/style-fixture.js';
import { closeBrowser, openPanel, type Panel } from './harness.js';
import { PERMISSION_OPTIONS, round, toolEnd, toolStart, turnStart, usageOf } from './turns.js';

const MODEL = 'qwen3.8-flash';
const THEMES = ['dark', 'light', 'high-contrast'] as const;

/** What carries the rainbow class, each as `composer` or the class of whatever else does. */
const rainbows = (panel: Panel) => panel.eval<string[]>(`[...doc.querySelectorAll('.rainbow')].map((e) => (e.closest('.composer') ? 'composer' : e.className))`);

/** The composer's rainbow ring as drawn: whether it shows, and the state of each rainbow animation on the page. */
type Ring = { display: string; plays: string[] };
const ring = (panel: Panel) =>
  panel.eval<Ring>(`({
    display: getComputedStyle(doc.querySelector('.ring')).display,
    plays: doc.getAnimations().filter((a) => a.animationName === 'rainbow-run').map((a) => a.playState),
  })`);
const isRunning = (r: Ring) => r.display !== 'none' && r.plays.join() === 'running';

/** The primary buttons' white fill in the glass style. */
const WHITE = 'rgb(242, 242, 242)';
const fillOf = (panel: Panel, selector: string) => panel.eval<string>(`getComputedStyle(doc.querySelector(${JSON.stringify(selector)})).backgroundColor`);
const blurOf = (panel: Panel, selector: string) => panel.eval<string>(`getComputedStyle(doc.querySelector(${JSON.stringify(selector)})).backdropFilter`);

/** The rail segment leading into the step waiting on the user: its image and its animation. */
const waitingSegment = (panel: Panel) =>
  panel.eval<{ image: string; animation: string }>(`(() => {
    const s = getComputedStyle(doc.querySelector('.turn:last-child .node-wait'), '::before');
    return { image: s.backgroundImage, animation: s.animationName };
  })()`);

/** Glass in Dark Modern and Light Modern, native in Dark High Contrast, which keeps it whatever the setting says. */
async function screenshots(panel: Panel, name: string): Promise<void> {
  await panel.page.mouse.move(0, 0);
  for (const slug of THEMES) {
    await panel.theme(slug);
    await panel.screenshot(`${name}-${slug}`);
  }
  await panel.theme('dark');
}

async function sendWithEnter(panel: Panel, prompt: string): Promise<void> {
  await panel.click('textarea');
  await panel.type(prompt);
  await panel.press('Enter');
}

/** The engine's three turns, as the fake transport scripts them in the VS Code test. */
function playTurns(panel: Panel): void {
  const { host } = panel;
  let turns = 0;
  host.on('send', async ({ text }) => {
    const id = `t${turns++}`;
    await host.act(turnStart(id, text));
    if (text === PROMPTS.edit) {
      await host.act({ type: 'text', text: 'Reading the code first.' }, toolStart('tu_read_a', { name: 'read', input: { path: 'a.ts' } }), toolStart('tu_read_b', { name: 'read', input: { path: 'b.ts' } }));
      await host.act(toolEnd('tu_read_a', 'completed', 'export function add(a: number, b: number): number {'), toolEnd('tu_read_b', 'completed', "export const greeting = 'hello';"));
      await round(host, 'tu_edit_a', { narration: 'Making the edit.', name: 'edit', input: EDIT });
      await host.act({ type: 'text', text: ANSWER }, { type: 'turn-end', at: Date.now(), status: 'done', usage: usageOf(MODEL, 3000, 90) });
    } else if (text === PROMPTS.remove) {
      const call = { name: 'bash', input: { command: 'rm -rf build' } };
      await host.act({ type: 'text', text: 'Removing the build output.' }, toolStart('tu_rm', call));
      await host.act({ type: 'permission', id: '0', command: 'rm -rf build', reason: 'deletes files', options: PERMISSION_OPTIONS, toolId: 'tu_rm' });
      const { optionId } = await host.next('permission');
      await host.act({ type: 'permission-done', id: '0', optionId }, toolEnd('tu_rm', 'completed', ''));
      await host.act({ type: 'text', text: 'Removed `build`.' }, { type: 'turn-end', at: Date.now(), status: 'done', usage: usageOf(MODEL, 2000, 60) });
    } else {
      // The fake transport stalls after the first two chunks of the answer, until the user stops the turn.
      await host.act({ type: 'text', text: 'Once upo' }, { type: 'text', text: 'n a time' });
      await host.next('stop', 120_000);
      await host.act({ type: 'turn-end', at: Date.now(), status: 'stopped', usage: undefined });
    }
  });
}

afterAll(closeBrowser);

describe('the chat panel style in the webview', () => {
  it('is glass with a rainbow on the composer, native on request and in high contrast', async () => {
    const panel = await openPanel({ look: { style: 'glass', detail: 'full', review: 'auto' } });
    playTurns(panel);
    await panel.waitFor('the panel to render', async () => (await panel.count('.transcript')) === 1);

    expect(await panel.eval<string>('doc.body.dataset.style'), 'the panel starts in glass, the default style').toBe('glass');
    const framed = () =>
      panel.eval<string[]>(
        `[...doc.querySelectorAll('.dino')].map((e) => getComputedStyle(e)).filter((c) => c.backgroundColor !== 'rgba(0, 0, 0, 0)' || c.backgroundImage !== 'none' || c.borderTopStyle !== 'none' || c.boxShadow !== 'none' || c.outlineStyle !== 'none').map((c) => c.cssText || 'framed')`,
      );
    expect(await panel.count('.dino'), 'Noodle stands on the start page').toBeGreaterThan(0);
    expect(await framed(), 'Noodle stands on the glass with no tile, border or shadow').toEqual([]);
    expect(await panel.eval(`({ image: getComputedStyle(doc.body).backgroundImage, color: getComputedStyle(doc.body).backgroundColor })`), 'the panel is a plain dark surface, with no gradient or glow').toEqual({
      image: 'none',
      color: 'rgb(30, 30, 32)',
    });
    expect(await panel.eval<string>(`doc.querySelector('.start-page').dataset.motion`), 'Noodle wanders the start page in glass while the window is focused').toBe('moving');

    // The rainbow does not depend on focus: it runs with the composer focused and without.
    await panel.click('.start-name');
    expect(await rainbows(panel), 'only the composer carries the rainbow').toEqual(['composer']);
    expect(isRunning(await ring(panel)), 'the composer rainbow runs while the composer is not focused').toBe(true);
    await panel.click('textarea');
    expect(isRunning(await ring(panel)), 'the composer rainbow runs while the composer is focused').toBe(true);
    await screenshots(panel, 'empty');

    await sendWithEnter(panel, PROMPTS.edit);
    await panel.waitFor('the first turn to finish', async () => (await panel.count('.turn-footer')) === 1);
    await panel.waitFor('the diagram to draw', async () => (await panel.count('.diagram[data-state="rendered"]')) === 1);
    expect(await rainbows(panel), 'a finished turn has no rainbow; the composer keeps it').toEqual(['composer']);
    await panel.click('.calls[data-step="read"] .step-row');
    await panel.waitFor('the read step to open', async () => (await panel.count('.call-list')) === 1);
    expect(await blurOf(panel, '.call-list'), 'an opened step lists its calls on glass').toContain('blur');
    const bubble = await panel.eval<{ fill: string; blur: string }>(`(() => { const s = getComputedStyle(doc.querySelector('.request-bubble')); return { fill: s.backgroundColor, blur: s.backdropFilter }; })()`);
    expect(bubble.fill, 'the user message is neutral glass, with no accent tint').toBe('rgba(255, 255, 255, 0.07)');
    expect(bubble.blur, 'the user message is frosted').toContain('blur');
    await panel.eval(`(doc.querySelector('.turn').scrollIntoView(), 1)`);
    await screenshots(panel, 'finished');
    await panel.eval(`(doc.querySelector('.diagram').previousElementSibling.scrollIntoView({ block: 'start' }), 1)`);
    await screenshots(panel, 'diagram');

    await sendWithEnter(panel, PROMPTS.remove);
    await panel.waitFor('the permission card', async () => (await panel.count('.permission-open')) === 1);
    expect(await rainbows(panel), 'the turn waiting on the user has no rainbow; the composer keeps it').toEqual(['composer']);
    expect(isRunning(await ring(panel)), 'the composer rainbow runs while a turn works').toBe(true);
    const allow = await panel.eval<{ fill: string; ink: string }>(`(() => { const s = getComputedStyle(doc.querySelector('.permission-open .button')); return { fill: s.backgroundColor, ink: s.color }; })()`);
    expect(allow, 'Allow, a primary action, is white with dark text').toEqual({ fill: WHITE, ink: 'rgb(10, 10, 10)' });
    expect(await fillOf(panel, '.permission-open .button.secondary'), 'Deny, a secondary action, stays quiet').not.toBe(WHITE);
    await panel.theme('light');
    const light = await panel.eval<{ surface: string; allow: string; ink: string }>(`(() => {
      const allow = getComputedStyle(doc.querySelector('.permission-open .button'));
      return { surface: getComputedStyle(doc.body).backgroundColor, allow: allow.backgroundColor, ink: allow.color };
    })()`);
    expect(light.surface, 'a light theme gets light glass on a plain light surface').toBe('rgb(245, 245, 245)');
    expect({ allow: light.allow, ink: light.ink }, 'on light glass the primary action is near-black with white text').toEqual({ allow: 'rgb(23, 23, 23)', ink: 'rgb(255, 255, 255)' });
    expect(await blurOf(panel, '.permission'), 'light glass is frosted too').toContain('blur');
    await panel.theme('dark');
    const flowing = await waitingSegment(panel);
    expect(flowing.animation, 'the rail into the waiting step flows').toBe('rail-flow');
    expect(flowing.image, 'the rail into the waiting step is dots').toContain('repeating-linear-gradient');
    await panel.page.emulateMedia({ reducedMotion: 'reduce' });
    const held = await ring(panel);
    expect(held.plays.join(), 'the rainbow holds still under reduced motion').toBe('paused');
    expect(held.display, 'the rainbow is still drawn under reduced motion').not.toBe('none');
    expect((await waitingSegment(panel)).animation, 'the rail dots hold still under reduced motion').toBe('none');
    await panel.page.emulateMedia({ reducedMotion: 'no-preference' });
    expect(isRunning(await ring(panel)), 'the rainbow runs again without reduced motion').toBe(true);
    await screenshots(panel, 'permission');
    await panel.click('.permission-open button', 'Allow');
    await panel.waitFor('the allowed turn to finish', async () => (await panel.count('.turn-footer')) === 2);
    expect(panel.host.received.filter((m) => m.type === 'permission'), 'Allow answers the card with the allow option').toEqual([{ type: 'permission', id: '0', optionId: 'allow' }]);

    await sendWithEnter(panel, PROMPTS.essay);
    await panel.waitFor('the stalled answer to stream', async () => (await panel.eval<string | null>(`[...doc.querySelectorAll('.turn')].at(-1).querySelector('.markdown')?.textContent ?? null`))?.startsWith('Once') === true);
    expect(await rainbows(panel), 'the streaming turn has no rainbow; the composer keeps it').toEqual(['composer']);
    await screenshots(panel, 'streaming');

    await panel.look({ style: 'native' });
    expect(await blurOf(panel, '.request-bubble'), 'native has no blur').toBe('none');
    expect((await ring(panel)).display, 'native draws no rainbow').toBe('none');
    await panel.look({ style: 'glass' });
    expect(await blurOf(panel, '.request-bubble'), 'glass comes back without a reload').toContain('blur');

    await panel.theme('high-contrast');
    expect(await panel.eval<boolean>(`doc.body.classList.contains('vscode-high-contrast')`), 'the theme is high contrast').toBe(true);
    expect(await blurOf(panel, '.request-bubble'), 'high contrast has no blur').toBe('none');
    expect((await ring(panel)).display, 'high contrast draws no rainbow').toBe('none');
    expect(await fillOf(panel, 'button.send'), 'high contrast keeps the native button colors').not.toBe(WHITE);
    await panel.theme('dark');

    await panel.click('button.stop');
    await panel.waitFor('Stop to end the turn', async () => (await panel.count('.turn-footer')) === 3);
    await panel.close();
  });
});
