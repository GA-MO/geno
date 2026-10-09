import { afterAll, describe, expect, it } from 'vitest';
import { ASKING, ASKING_ANSWER, ASKING_SUMMARY, LONG, LONG_ANSWER, LONG_SUMMARY, PROMPTS } from '../suite/fold-fixture.js';
import { closeBrowser, openPanel, type Panel } from './harness.js';
import { PERMISSION_OPTIONS, round, toolStart, turnStart, usageOf } from './turns.js';

const MODEL = 'qwen3.8-flash';
const THEMES = ['dark', 'light', 'high-contrast'] as const;

/** What one turn's rail shows: each step's kind, and the fold line's label and state. */
type Rail = { readonly steps: readonly string[]; readonly fold: string | null; readonly open: string | null };
const railOf = (panel: Panel, turn: string) =>
  panel.eval<Rail>(`(() => {
    const t = doc.querySelector('[data-turn="${turn}"]');
    const fold = t.querySelector('.turn-fold');
    return {
      steps: [...t.querySelectorAll(':scope > .rail > .step')].map((s) => [...s.classList].find((c) => c.startsWith('step-')).slice(5)),
      fold: fold?.textContent ?? null,
      open: fold?.getAttribute('aria-expanded') ?? null,
    };
  })()`);

const topOf = (panel: Panel, selector: string) => panel.eval<number>(`doc.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().top`);
const scrollTo = (panel: Panel, end: 'top' | 'bottom') => panel.eval(`(() => { const log = doc.querySelector('.transcript'); log.scrollTop = ${end === 'top' ? 0 : 'log.scrollHeight'}; return 1; })()`);

/** Dark glass, light glass and high contrast, which draws native whatever the setting says. */
async function screenshots(panel: Panel, name: string, place: () => Promise<unknown>): Promise<void> {
  await panel.page.mouse.move(0, 0);
  for (const slug of THEMES) {
    await panel.theme(slug);
    await place();
    await panel.screenshot(`${name}-${slug}`);
  }
  await panel.theme('dark');
}

async function send(panel: Panel, prompt: string): Promise<void> {
  await panel.click('textarea');
  await panel.type(prompt);
  await panel.press('Enter');
}

/** The engine's two turns, as the fake transport scripts them in the VS Code test. */
function playTurns(panel: Panel): void {
  const { host } = panel;
  let turns = 0;
  host.on('send', async ({ text }) => {
    const id = `t${turns++}`;
    await host.act(turnStart(id, text));
    if (text === PROMPTS.long) {
      for (const [i, call] of LONG.entries()) await round(host, `tu_long_${i}`, call, call.input['path'] === 'missing.ts' ? 'failed' : 'completed');
      await host.act({ type: 'text', text: LONG_ANSWER }, { type: 'turn-end', at: Date.now(), status: 'done', usage: usageOf(MODEL, 11_000, 330) });
      return;
    }
    for (const [i, call] of ASKING.slice(0, -1).entries()) await round(host, `tu_ask_${i}`, call);
    const remove = ASKING.at(-1)!;
    await host.act({ type: 'text', text: remove.narration }, toolStart('tu_ask_4', remove));
    await host.act({ type: 'permission', id: '0', command: String(remove.input['command']), reason: 'deletes files', options: PERMISSION_OPTIONS, toolId: 'tu_ask_4' });
    const { optionId } = await host.next('permission');
    await host.act({ type: 'permission-done', id: '0', optionId }, { type: 'tool', id: 'tu_ask_4', at: Date.now(), status: 'failed', output: 'The user denied this command.' });
    await host.act({ type: 'text', text: ASKING_ANSWER }, { type: 'turn-end', at: Date.now(), status: 'done', usage: usageOf(MODEL, 6000, 180) });
  });
}

afterAll(closeBrowser);

describe('the fold in the chat webview', () => {
  it('folds a finished turn to its summary, opens in place, follows the detail setting and folds a running turn', async () => {
    const panel = await openPanel();
    playTurns(panel);
    await panel.waitFor('the panel to render', async () => (await panel.count('.transcript')) === 1);
    expect(await panel.eval<string>('doc.body.dataset.detail'), 'the panel starts compact, the default').toBe('compact');

    await send(panel, PROMPTS.long);
    await panel.waitFor('the long turn to finish', async () => (await panel.count('.turn-footer')) === 1);
    expect(await railOf(panel, 't0'), 'the 20-step turn folds to its summary line, its answer and the file it changed').toEqual({ steps: ['fold', 'text', 'files'], fold: LONG_SUMMARY, open: 'false' });
    expect(await panel.eval<string>(`doc.querySelector('[data-turn="t0"] .step-text').textContent`), 'the text shown is the final answer').toBe(LONG_ANSWER.replace(/`/g, ''));
    expect(await panel.eval<string[]>(`[...doc.querySelectorAll('[data-turn="t0"] .changed-file')].map((c) => c.textContent)`), 'the changed file shows as one chip with its line counts').toEqual(['a.ts+1−1']);
    expect(await panel.count('[data-turn="t0"] .turn-footer .model'), 'the model, tokens and cost leave the folded turn').toBe(0);
    const tooltip = await panel.eval<string>(`doc.querySelector('[data-turn="t0"] .turn-meta').title`);
    expect(tooltip.startsWith(`${MODEL} · `) && tooltip.includes(' in · ') && tooltip.includes(' out'), `the cost line is the tooltip of "worked for": ${tooltip}`).toBe(true);
    await screenshots(panel, 'long-compact', () => scrollTo(panel, 'top'));

    // Opening the turn, from the middle of the transcript, keeps the summary line where the user clicked it.
    await panel.eval(`(doc.querySelector('[data-turn="t0"] .turn-fold').scrollIntoView({ block: 'center' }), 1)`);
    const before = await topOf(panel, '[data-turn="t0"] .turn-fold');
    await panel.click('[data-turn="t0"] .turn-fold');
    await panel.waitFor('the turn to open', async () => (await railOf(panel, 't0')).open === 'true');
    const after = await topOf(panel, '[data-turn="t0"] .turn-fold');
    expect(Math.abs(after - before), 'opening the turn does not move the summary line').toBeLessThan(1);
    const opened = await railOf(panel, 't0');
    expect(opened.steps.filter((s) => s === 'calls').length, 'the opened turn shows its full trail').toBe(LONG.length);
    expect(opened.steps, 'the opened turn shows its changes').toContain('changes');
    expect(await panel.count('[data-turn="t0"] .turn-footer .model'), 'the opened turn shows its model, tokens and cost').toBe(1);
    await screenshots(panel, 'expanded', () => scrollTo(panel, 'top'));
    await panel.click('[data-turn="t0"] .turn-fold');
    await panel.waitFor('the turn to fold again', async () => (await railOf(panel, 't0')).open === 'false');
    expect((await railOf(panel, 't0')).steps, 'clicking the line again folds the turn').toEqual(['fold', 'text', 'files']);

    await panel.look({ detail: 'full' });
    await panel.waitFor('the panel to switch to full', async () => (await panel.eval<string>('doc.body.dataset.detail')) === 'full');
    const full = await railOf(panel, 't0');
    expect(full.fold, 'full detail shows no summary line').toBeNull();
    expect(full.steps.filter((s) => s === 'calls').length, 'full detail shows every step').toBe(LONG.length);
    expect(await panel.count('[data-turn="t0"] .turn-footer .model'), 'full detail shows the model, tokens and cost').toBe(1);
    await screenshots(panel, 'long-full', () => scrollTo(panel, 'top'));
    await panel.look({ detail: 'compact' });
    await panel.waitFor('the panel to switch to compact', async () => (await panel.eval<string>('doc.body.dataset.detail')) === 'compact');

    await send(panel, PROMPTS.remove);
    await panel.waitFor('the permission card', async () => (await panel.count('.permission-open')) === 1);
    // The command's own step and its permission card can arrive in either order, so the steps are compared as a set.
    const running = await railOf(panel, 't1');
    expect({ ...running, steps: [...running.steps].sort() }, 'the running turn shows its last four steps, the approval card among them, and folds the rest').toEqual({
      steps: ['asking', 'calls', 'fold', 'permission', 'text'],
      fold: '+7 earlier steps',
      open: 'false',
    });
    await panel.waitFor('only the latest narration to show', async () => (await panel.eval<string[]>(`[...doc.querySelectorAll('[data-turn="t1"] .step-text')].map((s) => s.textContent)`)).join() === 'Removing the build output.');
    await screenshots(panel, 'running', () => scrollTo(panel, 'bottom'));
    await panel.click('.permission-open button', 'Deny');
    await panel.waitFor('the denied turn to finish', async () => (await panel.count('.turn-footer')) === 2);
    expect(await railOf(panel, 't1'), 'the finished turn counts the denied command in its summary').toEqual({ steps: ['fold', 'text'], fold: ASKING_SUMMARY, open: 'false' });
    expect(panel.host.received.filter((m) => m.type === 'permission'), 'Deny answers the card with the reject option').toEqual([{ type: 'permission', id: '0', optionId: 'reject' }]);
    await panel.close();
  });
});
