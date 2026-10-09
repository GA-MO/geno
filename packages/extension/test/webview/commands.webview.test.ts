import { afterAll, describe, expect, it } from 'vitest';
import { ANSWERS, LONG_COMMAND, LOOK, MANY_LINES, PROMPTS, REMOVE } from '../suite/commands-fixture.js';
import { closeBrowser, openPanel, type Panel } from './harness.js';
import { PERMISSION_OPTIONS, toolEnd, toolStart, turnStart, usageOf } from './turns.js';

const MODEL = 'qwen3.8-flash';
const THEMES = ['dark', 'light', 'high-contrast'] as const;

/** What the sandbox prints for each command of the fixture, before the engine's status line. */
const OUTPUTS: Readonly<Record<string, string>> = {
  ls: 'a.ts\nbuild\nnotes',
  'cat notes/many.txt': MANY_LINES.join('\n'),
  [LONG_COMMAND]: '-rw-r--r--  1 user  staff  20 Oct  7 12:00 ./a.ts',
  pwd: '/workspace',
};

/** What each command step shows: its title, its IN text, its OUT text, whether the output fades, and its expand button. */
type Shown = { readonly title: string; readonly command: string; readonly output: string | null; readonly truncated: boolean; readonly more: string | null };
const steps = (panel: Panel) =>
  panel.eval<Shown[]>(`[...doc.querySelectorAll('.command-step')].map((s) => ({
    title: s.querySelector('.command-title').textContent,
    command: s.querySelector('.command-in').textContent,
    output: s.querySelector('.command-output')?.textContent ?? null,
    truncated: s.querySelector('.command-output')?.classList.contains('truncated') ?? false,
    more: s.querySelector('.show-all')?.textContent ?? null,
  }))`);

/** Whether the long command wraps inside its box, with nothing cut off to the right. */
const longCommandFits = (panel: Panel) =>
  panel.eval<{ wraps: boolean; fits: boolean; width: number }>(`(() => {
    const pre = [...doc.querySelectorAll('.command-in')].find((p) => p.textContent === ${JSON.stringify(LONG_COMMAND)});
    const line = parseFloat(getComputedStyle(pre).lineHeight);
    return { wraps: pre.clientHeight > line * 1.5, fits: pre.scrollWidth <= pre.clientWidth, width: doc.body.clientWidth };
  })()`);

const textOf = (panel: Panel, selector: string) => panel.eval<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);

async function screenshots(panel: Panel, name: string, place: () => Promise<unknown>): Promise<void> {
  await panel.page.mouse.move(0, 0);
  for (const slug of THEMES) {
    await panel.theme(slug);
    await place();
    await panel.screenshot(`${name}-${slug}`);
  }
  await panel.theme('dark');
}

const scrollTo = (panel: Panel, selector: string) => () => panel.eval(`(doc.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'start' }), 1)`);

async function send(panel: Panel, prompt: string): Promise<void> {
  await panel.click('textarea');
  await panel.type(prompt);
  await panel.press('Enter');
}

/** The engine's two turns: four commands that run, then one the user denies. */
function playTurns(panel: Panel): void {
  const { host } = panel;
  let turns = 0;
  host.on('send', async ({ text }) => {
    const id = `t${turns++}`;
    await host.act(turnStart(id, text));
    if (text === PROMPTS.look) {
      for (const [i, call] of LOOK.entries()) {
        await host.act({ type: 'text', text: call.narration }, toolStart(`tu_look_${i}`, call));
        await host.act(toolEnd(`tu_look_${i}`, 'completed', `${OUTPUTS[String(call.input['command'])]}\n[exit code 0]`));
      }
      await host.act({ type: 'text', text: ANSWERS.look }, { type: 'turn-end', at: Date.now(), status: 'done', usage: usageOf(MODEL, 5000, 150) });
      return;
    }
    const remove = REMOVE[0]!;
    const command = String(remove.input['command']);
    await host.act({ type: 'text', text: remove.narration }, toolStart('tu_rm', remove));
    await host.act({ type: 'permission', id: '0', command, reason: 'deletes files', description: String(remove.input['description']), options: PERMISSION_OPTIONS, toolId: 'tu_rm' });
    const { optionId } = await host.next('permission');
    await host.act({ type: 'permission-done', id: '0', optionId }, { type: 'tool', id: 'tu_rm', at: Date.now(), status: 'denied', output: `The user rejected \`${command}\`, so it did not run.`, denial: { by: 'you', reason: 'It did not run, and Geno waits for you.' } });
    await host.act({ type: 'text', text: ANSWERS.remove }, { type: 'turn-end', at: Date.now(), status: 'done', usage: usageOf(MODEL, 2000, 60) });
  });
}

afterAll(closeBrowser);

describe('command steps in the chat webview', () => {
  it('shows each command as one titled box, wraps it at 300px, keeps the request in view and asks with its description', async () => {
    const panel = await openPanel({ look: { style: 'glass', detail: 'full', review: 'auto' } });
    playTurns(panel);
    await panel.waitFor('the panel to render', async () => (await panel.count('.transcript')) === 1);
    expect(await panel.eval<string>('doc.body.dataset.detail'), 'the panel shows every step').toBe('full');
    await send(panel, PROMPTS.look);
    await panel.waitFor('the look turn to finish', async () => (await panel.count('.turn-footer')) === 1);

    const shown = await steps(panel);
    expect(shown.length, 'every command is its own step').toBe(LOOK.length);
    expect(shown.map((s) => s.title), 'each step is titled by its description, and one without by the fallback').toEqual([
      'List the files in the project root',
      'Show the entries in the notes file',
      'Show details of the source, notes and build files',
      'Ran a command',
    ]);
    expect(shown.map((s) => s.command), 'each step shows its command whole').toEqual(LOOK.map((c) => c.input['command']));
    expect(shown[0]!.output?.split('\n'), 'a short output shows whole').toContain('a.ts');
    expect({ truncated: shown[0]!.truncated, more: shown[0]!.more }, 'a short output has no fade').toEqual({ truncated: false, more: null });
    expect({ output: shown[1]!.output, truncated: shown[1]!.truncated }, 'a long output previews its first lines and fades').toEqual({ output: MANY_LINES.slice(0, 4).join('\n'), truncated: true });
    expect(shown[1]!.more, 'and offers to show them all').toBe(`Show all ${MANY_LINES.length} lines`);
    expect(shown.filter((s) => s.output?.includes('[exit code 0]')), 'a clean exit line is left out').toEqual([]);
    expect(await panel.count('.command-step .step-row, .command-step .tool-row'), 'a command step is one box, not a row that opens to a list').toBe(0);

    await panel.page.setViewportSize({ width: 300, height: panel.page.viewportSize()!.height });
    await panel.frame();
    const width = await panel.eval<number>('doc.body.clientWidth');
    expect(width >= 270 && width <= 330, `the panel narrows to about 300px: ${width}`).toBe(true);
    const fits = await longCommandFits(panel);
    expect({ wraps: fits.wraps, fits: fits.fits }, 'the long command wraps in its box at about 300px, nothing cut off').toEqual({ wraps: true, fits: true });
    await screenshots(panel, 'steps-narrow', scrollTo(panel, '[data-turn="t0"] .request'));

    await panel.click('[data-step="bash"] .show-all');
    await panel.waitFor('the notes output to open', async () => (await steps(panel))[1]!.output === MANY_LINES.join('\n'));
    const opened = (await steps(panel))[1]!;
    expect({ truncated: opened.truncated, more: opened.more }, 'the opened output shows every line without a fade').toEqual({ truncated: false, more: null });

    // The stuck state is a scroll-state container query, which the browser settles on the frame after the scroll.
    await panel.eval(`(() => { const t = doc.querySelector('.transcript'); t.scrollTop = t.scrollHeight; return 1; })()`);
    await panel.frame();
    const stuck = await panel.eval<{ gap: number; clipped: boolean }>(
      `(() => { const t = doc.querySelector('.transcript'); const r = doc.querySelector('[data-turn="t0"] > .request'); const b = r.querySelector('.request-bubble'); return { gap: Math.round(r.getBoundingClientRect().top - t.getBoundingClientRect().top), clipped: getComputedStyle(b).overflow === 'hidden' }; })()`,
    );
    expect(stuck, 'scrolled to the end of a long turn, its request stays at the top, cut to a few lines').toEqual({ gap: 0, clipped: true });
    await screenshots(panel, 'sticky-request', () => panel.eval(`(() => { const t = doc.querySelector('.transcript'); t.scrollTop = t.scrollHeight; return 1; })()`));

    // A test window in VS Code usually has no focus, so the peek cannot play its duck there either.
    await panel.host.post({ type: 'window-focus', focused: false });
    await send(panel, PROMPTS.remove);
    await panel.waitFor('the permission card', async () => (await panel.count('.permission-open')) === 1);
    expect(await textOf(panel, '.permission-open .permission-description'), 'the card shows what the command is for').toBe(REMOVE[0]!.input['description']);
    expect(await textOf(panel, '.permission-open .permission-command'), 'and the full command').toBe('rm -rf build');
    await panel.waitFor('one Noodle while the turn runs: the peek down, even when the window has no focus to play its duck', async () => (await panel.eval<string>(`doc.querySelector('.peek').dataset.state`)) === 'away', 3000);
    await screenshots(panel, 'permission', scrollTo(panel, '.permission-open'));
    await panel.click('.permission-open button', 'Deny');
    await panel.waitFor('the denied turn to finish', async () => (await panel.count('.turn-footer')) === 2);
    const denied = (await steps(panel)).at(-1)!;
    expect(denied.title, 'the denied step keeps its title').toBe(REMOVE[0]!.input['description']);
    expect(denied.output, 'the denied step shows no output, since it never ran').toBeNull();
    expect(await textOf(panel, '[data-turn="t1"] .command-step .step-denied'), 'and says the user denied it').toBe('Denied by you');
    expect(await panel.count('[data-turn="t1"] .command-step .step-failed'), 'not that it failed').toBe(0);
    await panel.close();
  });
});
