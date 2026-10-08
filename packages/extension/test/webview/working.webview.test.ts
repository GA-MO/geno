import { afterAll, describe, expect, it } from 'vitest';
import { ANSWERS, PLAN, PROMPTS, TROUBLE, WORK } from '../suite/working-fixture.js';
import { closeBrowser, MODES, openPanel, type Panel } from './harness.js';
import { editDiff, PERMISSION_OPTIONS, toolEnd, toolStart, turnStart, usageOf, type Call } from './turns.js';

const MODEL = 'qwen3.8-flash';
const THEMES = ['dark', 'light', 'high-contrast'] as const;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const callOf = ({ say, name, input }: (typeof WORK)[number] | (typeof TROUBLE)[number]): Call => ({ narration: say, name, input });

/** The last turn does the work again, undoing the first turn's edits. */
const AGAIN = WORK.map((call) => (call.name === 'edit' ? { ...call, input: { ...call.input, old_str: call.input['new_str'], new_str: call.input['old_str'] } } : call));

/** What the engine's tools print: the check's headline is what tells the panel the check passed. */
const outputOf = (call: Call): string => (call.name === 'check' ? 'check `true` passed' : `ok: ${String(call.input['path'] ?? call.input['command'] ?? '')}`);

const focus = (panel: Panel, focused: boolean) => panel.host.post({ type: 'window-focus', focused });
const reducedMotion = (panel: Panel, on: boolean) => panel.page.emulateMedia({ reducedMotion: on ? 'reduce' : 'no-preference' });
const pose = (panel: Panel) => panel.eval<string | null>(`doc.querySelector('.working-dino')?.dataset.pose ?? null`);
const frame = (panel: Panel) => panel.eval<string | null>(`doc.querySelector('.working-dino')?.dataset.frame ?? null`);
const textOf = (panel: Panel, selector: string) => panel.eval<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);

/** Records every pose the working dino shows from now on, and `none` while there is no dino. */
const watchPoses = (panel: Panel) =>
  panel.eval(
    `(() => { const w = doc.defaultView; const now = () => doc.querySelector('.working-dino')?.dataset.pose ?? 'none'; w.poses = [now()]; w.poseWatch?.disconnect(); w.poseWatch = new MutationObserver(() => { const p = now(); if (w.poses.at(-1) !== p) w.poses.push(p); }); w.poseWatch.observe(doc.querySelector('.transcript'), { subtree: true, childList: true, attributes: true, attributeFilter: ['data-pose'] }); return 1; })()`,
  );
const poses = (panel: Panel) => panel.eval<string[]>('doc.defaultView.poses');

const framed = (panel: Panel) =>
  panel.eval<string[]>(
    `[...doc.querySelectorAll('.dino')].filter((e) => { const c = getComputedStyle(e); return c.backgroundColor !== 'rgba(0, 0, 0, 0)' || c.backgroundImage !== 'none' || c.borderTopStyle !== 'none' || c.borderLeftStyle !== 'none' || c.boxShadow !== 'none' || c.outlineStyle !== 'none'; }).map((e) => e.className)`,
  );

async function screenshots(panel: Panel, name: string): Promise<void> {
  await panel.page.mouse.move(0, 0);
  for (const slug of THEMES) {
    await panel.theme(slug);
    await panel.eval(`(doc.querySelector('.transcript').scrollTop = 1e9, 1)`);
    await panel.screenshot(`${name}-${slug}`);
  }
  await panel.theme('dark');
}

async function send(panel: Panel, prompt: string): Promise<void> {
  await panel.click('textarea');
  await panel.type(prompt);
  await panel.press('Enter');
}

async function setMode(panel: Panel, mode: 'ask' | 'plan'): Promise<void> {
  await panel.click('.mode-picker');
  await panel.waitFor('the mode menu', async () => (await panel.count('.mode-menu:not([hidden]) .mode-option')) === 3);
  await panel.click(`.mode-option[data-mode="${mode}"]`);
  await panel.waitFor(`the engine to confirm ${mode}`, async () => (await panel.eval<string>(`doc.querySelector('.input-box').dataset.mode`)) === mode);
}

/**
 * The engine's turns, as the VS Code test's fake model scripts them. Each model round waits for `release`, so the
 * test can look at each step's pose, as the VS Code suite holds each reply.
 */
function playTurns(panel: Panel): () => void {
  const { host } = panel;
  let allowed = 0;
  let used = 0;
  let wake: () => void = () => {};
  const release = () => {
    allowed++;
    wake();
  };
  const turnFor = async () => {
    while (used >= allowed) await new Promise<void>((resolve) => (wake = resolve));
    used++;
  };
  let mode = MODES.current;
  host.on('set-mode', async ({ modeId }) => {
    mode = modeId;
    await host.post({ type: 'modes', modes: { ...MODES, current: modeId } });
  });
  const ends = () => ({ type: 'turn-end', at: Date.now(), status: 'done', usage: usageOf(MODEL) }) as const;
  async function rounds(prefix: string, calls: readonly Call[]): Promise<void> {
    for (const [i, call] of calls.entries()) {
      await turnFor();
      const id = `${prefix}${i}`;
      await host.act({ type: 'text', text: call.narration }, toolStart(id, call));
      if (call.name === 'edit') await host.act(editDiff(id, String(call.input['path']), 2, String(call.input['old_str']), String(call.input['new_str'])));
      await host.act(toolEnd(id, 'completed', outputOf(call)));
    }
  }
  let turns = 0;
  host.on('send', async ({ text }) => {
    const n = turns++;
    await host.act(turnStart(`t${n}`, text, mode));
    if (text === PROMPTS.work) {
      await rounds(n === 0 ? 'tu_work_' : 'tu_again_', (n === 0 ? WORK : AGAIN).map(callOf));
      await turnFor();
      await host.act({ type: 'text', text: ANSWERS.work }, ends());
      return;
    }
    if (text === PROMPTS.plan) {
      await rounds('tu_plan_', PLAN.map(callOf));
      await turnFor();
      await host.act({ type: 'text', text: ANSWERS.plan }, ends());
      return;
    }
    const [read, remove] = TROUBLE.map(callOf);
    await turnFor();
    await host.act({ type: 'text', text: read!.narration }, toolStart('tu_trouble_0', read!), toolEnd('tu_trouble_0', 'failed', 'error: missing.ts not found'));
    await turnFor();
    const command = String(remove!.input['command']);
    await host.act({ type: 'text', text: remove!.narration }, toolStart('tu_trouble_1', remove!));
    await host.act({ type: 'permission', id: '0', command, reason: 'deletes files', options: PERMISSION_OPTIONS, toolId: 'tu_trouble_1' });
    const { optionId } = await host.next('permission');
    await host.act({ type: 'permission-done', id: '0', optionId }, toolEnd('tu_trouble_1', 'failed', `denied: \`${command}\` was refused by the user.`), ends());
  });
  return release;
}

afterAll(closeBrowser);

describe('the working dino in the chat webview', () => {
  it('switches poses with the running turn’s steps, flexes when its check passed, and becomes the still avatar', async () => {
    const panel = await openPanel();
    const release = playTurns(panel);
    await panel.waitFor('the panel to render', async () => (await panel.count('.transcript')) === 1);

    // The working turn: it thinks, reads, codes in a .ts file, writes in a .md file, runs a command and a check.
    await watchPoses(panel);
    await send(panel, PROMPTS.work);
    await panel.waitFor('the turn to run', async () => (await panel.count('.turn[aria-busy="true"]')) === 1);
    await panel.waitFor('Noodle to think while the model works', async () => (await pose(panel)) === 'thinking');
    const placed = await panel.eval<{ width: number; height: number; cols: number; rows: number; rendering: string; inStep: boolean; last: boolean; avatar: string; spinner: string; right: number; turnRight: number }>(
      `(() => { const c = doc.querySelector('.working-dino'); const r = c.getBoundingClientRect(); const step = c.parentElement; const steps = [...doc.querySelectorAll('.turn[aria-busy="true"] > .rail > .step')]; return { width: r.width, height: r.height, cols: c.width, rows: c.height, rendering: getComputedStyle(c).imageRendering, inStep: step.matches('.turn[aria-busy="true"] > .rail > .step'), last: steps.at(-1) === step, avatar: getComputedStyle(doc.querySelector('.turn[aria-busy="true"] .avatar')).display, spinner: getComputedStyle(doc.querySelector('.turn[aria-busy="true"] .turn-working')).display, right: r.right, turnRight: doc.querySelector('.turn[aria-busy="true"]').getBoundingClientRect().right }; })()`,
    );
    expect({ width: placed.width, height: placed.height, cols: placed.cols, rows: placed.rows, rendering: placed.rendering }, 'the working dino is the sprite at 2×, 48 px, pixelated').toEqual({
      width: 48,
      height: 48,
      cols: 24,
      rows: 24,
      rendering: 'pixelated',
    });
    expect(placed.inStep && placed.last && Math.abs(placed.right - placed.turnRight) <= 1, `it stands beside the running turn’s current step, at the right: ${JSON.stringify(placed)}`).toBe(true);
    expect(placed.avatar === 'none' && placed.spinner !== 'none', `the turn’s 24 px avatar steps aside for a spinner while the working dino shows: ${JSON.stringify(placed)}`).toBe(true);
    expect(await framed(panel), 'no dino has a background, border or shadow').toEqual([]);
    await screenshots(panel, 'thinking');

    // Each round goes while Noodle rests, so the pose it brings holds however short the step.
    for (const call of WORK) {
      await focus(panel, false);
      release();
      await panel.waitFor(`Noodle to show ${call.pose} for ${call.name} ${JSON.stringify(call.input)}`, async () => (await pose(panel)) === call.pose);
    }
    await focus(panel, true);
    release();
    await panel.waitFor('the working turn to end', async () => (await panel.count('.turn[aria-busy="true"]')) === 0);
    await panel.waitFor('the turn-end move to finish', async () => (await pose(panel)) === null);
    expect(
      (await poses(panel)).filter((p) => p !== 'thinking'),
      'the dino switched poses with the steps, then flexed once, as the check passed',
    ).toEqual(['none', ...WORK.map((c) => c.pose).filter((p, i, all) => all[i - 1] !== p), 'flex', 'none']);
    const after = await panel.eval<{ avatar: string; spinner: string; working: string | null }>(
      `(() => { const t = doc.querySelector('.turn:last-child'); return { avatar: getComputedStyle(t.querySelector('.avatar')).display, spinner: getComputedStyle(t.querySelector('.turn-working')).display, working: t.dataset.working ?? null }; })()`,
    );
    expect(after.avatar !== 'none' && after.spinner === 'none' && after.working === null, `the finished turn shows its still 24 px avatar again: ${JSON.stringify(after)}`).toBe(true);
    expect(await textOf(panel, '.turn:last-child .markdown'), 'the answer shows').toContain(ANSWERS.work);

    // A failed read brings sweat; a command Ask holds brings the question mark; the user's no ends the turn, and a turn
    // without checks hops or rolls.
    await watchPoses(panel);
    await send(panel, PROMPTS.trouble);
    await panel.waitFor('the second turn to think', async () => (await pose(panel)) === 'thinking');
    await focus(panel, false);
    release();
    await panel.waitFor('Noodle to sweat after the failed read', async () => (await pose(panel)) === 'sweat');
    release();
    await panel.waitFor('the permission card', async () => (await panel.count('.permission-open')) === 1);
    await panel.waitFor('Noodle to ask while the card waits', async () => (await pose(panel)) === 'asking');
    await screenshots(panel, 'asking');
    await focus(panel, true);
    await panel.click('.permission-open button', 'Deny');
    await panel.waitFor('the denied turn to end', async () => (await panel.count('.turn[aria-busy="true"]')) === 0);
    await panel.waitFor('its turn-end move to finish', async () => (await pose(panel)) === null);
    const trouble = await poses(panel);
    expect(['hop', 'somersault'].includes(trouble.at(-2)!) && !trouble.includes('flex'), `a turn without a passing check hops or somersaults, and does not flex: ${JSON.stringify(trouble)}`).toBe(true);

    // Plan mode: the clipboard. Under reduced motion the pose holds its first frame, and the turn ends with no move.
    await setMode(panel, 'plan');
    await watchPoses(panel);
    await send(panel, PROMPTS.plan);
    await panel.waitFor('Noodle to plan', async () => (await pose(panel)) === 'planning');
    await reducedMotion(panel, true);
    await pause(300);
    const held = await frame(panel);
    await pause(800);
    expect(await frame(panel), 'under reduced motion the pose does not animate').toBe(held);
    release();
    await panel.waitFor('the plan turn to read', async () => panel.host.transcript.turns.at(-1)!.blocks.some((b) => b.kind === 'tool' && b.status === 'completed'));
    await panel.frame();
    expect(await pose(panel), 'a Plan turn keeps the clipboard while it reads').toBe('planning');
    release();
    await panel.waitFor('the plan turn to end', async () => (await panel.count('.turn[aria-busy="true"]')) === 0);
    await panel.waitFor('the dino to leave', async () => (await pose(panel)) === null);
    const planned = await poses(panel);
    expect(planned.slice(-2), 'under reduced motion the turn ends with no move').toEqual(['planning', 'none']);
    await reducedMotion(panel, false);

    // The same work again: the laptop comes out again in a new turn, and the turn ends with a flex.
    await setMode(panel, 'ask');
    await watchPoses(panel);
    await send(panel, PROMPTS.work);
    await panel.waitFor('the second work turn to run', async () => (await panel.count('.turn[aria-busy="true"]')) === 1);
    for (let i = 0; i <= AGAIN.length; i++) {
      release();
      await pause(200);
    }
    await panel.waitFor('the second work turn to end', async () => (await panel.count('.turn[aria-busy="true"]')) === 0);
    await panel.waitFor('its flex to finish', async () => (await pose(panel)) === null);
    const again = await poses(panel);
    expect(again.includes('coding') && again.at(-2) === 'flex', `the second work turn codes and ends with a flex: ${JSON.stringify(again)}`).toBe(true);
    await panel.close();
  });
});
