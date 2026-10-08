import { afterAll, describe, expect, it } from 'vitest';
import type { HistoryRow, HistoryScope, Transcript } from '../../src/chat/messages.js';
import { reduce } from '../../src/chat/transcript.js';
import { ANSWER, BRANCH, FOLLOW_UP, SESSIONS } from '../suite/start-fixture.js';
import { closeBrowser, openPanel, type Panel } from './harness.js';
import { turnStart, usageOf } from './turns.js';

const MODEL = 'qwen3.8-flash';
const PROJECT = 'workspace';
const WORKSPACE = `/tmp/${PROJECT}`;
const THEMES = ['dark', 'light', 'high-contrast'] as const;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The engine's history rows for the fixture's sessions, in the order the engine lists them. */
const ROWS: readonly HistoryRow[] = SESSIONS.map(({ id, prompt, at }) => ({
  id,
  title: prompt,
  workspace: WORKSPACE,
  project: PROJECT,
  here: true,
  updatedAt: Date.parse(at) + 3000,
  turns: 1,
  costUsd: 0.0004,
  current: false,
}));

/** A finished session as the extension replays its log: the prompt and its answer. */
const replayed = (id: string, prompt: string): Transcript =>
  [turnStart(`${id}-0`, prompt), { type: 'text', text: 'Done.' } as const, { type: 'turn-end', at: Date.now(), status: 'done', usage: usageOf(MODEL, 1200, 40) } as const].reduce(
    reduce,
    { model: MODEL, turns: [] } as Transcript,
  );

const textOf = (panel: Panel, selector: string) => panel.eval<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const motion = (panel: Panel) => panel.eval<string>(`doc.querySelector('.start-page').dataset.motion`);
const peekState = (panel: Panel) => panel.eval<string>(`doc.querySelector('.peek').dataset.state`);
const focus = (panel: Panel, focused: boolean) => panel.host.post({ type: 'window-focus', focused });
const reducedMotion = (panel: Panel, on: boolean) => panel.page.emulateMedia({ reducedMotion: on ? 'reduce' : 'no-preference' });
const leaveComposer = (panel: Panel) => panel.eval(`(doc.activeElement.blur(), doc.querySelector('.transcript').focus(), 1)`);

/** What the start page shows of Noodle: its picture and where it stands. */
const pose = (panel: Panel) => panel.eval<string>(`doc.querySelector('.start-dino').dataset.frame + '@' + doc.querySelector('.start-dino').style.transform`);

async function movesWithin(panel: Panel, ms: number): Promise<boolean> {
  const before = await pose(panel);
  await pause(ms);
  return (await pose(panel)) !== before;
}

/** The peek's eye, read from its two eye cells: level, up or down a row, the pupil to the right or the left. */
async function peekEye(panel: Panel): Promise<string> {
  const rows = (await panel.eval<string>(`doc.querySelector('.peek-body').dataset.frame`)).match(/.{24}/g)!;
  const EYES: Record<string, string> = { '2:wk': 'up', '2:kw': 'upLeft', '3:wk': 'open', '3:kw': 'left', '3:kk': 'blink', '4:wk': 'down', '4:kw': 'downLeft' };
  for (const row of [2, 3, 4]) {
    const eye = EYES[`${row}:${rows[row]!.slice(17, 19)}`];
    if (eye !== undefined) return eye;
  }
  return `unknown ${rows.slice(2, 5).join('/')}`;
}

/** Every state the peek has been in since `watchPeek`, in order. */
const watchPeek = (panel: Panel) =>
  panel.eval(
    `(() => { const w = doc.defaultView; w.peekSeen = [doc.querySelector('.peek').dataset.state]; w.peekWatch?.disconnect(); w.peekWatch = new MutationObserver(() => { const now = doc.querySelector('.peek').dataset.state; if (w.peekSeen.at(-1) !== now) w.peekSeen.push(now); }); w.peekWatch.observe(doc.querySelector('.peek'), { attributes: true, attributeFilter: ['data-state'] }); return 1; })()`,
  );
const peekSeen = (panel: Panel) => panel.eval<string[]>(`doc.defaultView.peekSeen`);
const setDraft = (panel: Panel, text: string) =>
  panel.eval(`(() => { const t = doc.querySelector('textarea'); t.value = ${JSON.stringify(text)}; t.focus(); t.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);

const framed = (panel: Panel) =>
  panel.eval<string[]>(
    `[...doc.querySelectorAll('.dino')].filter((e) => { const c = getComputedStyle(e); return c.backgroundColor !== 'rgba(0, 0, 0, 0)' || c.backgroundImage !== 'none' || c.borderTopStyle !== 'none' || c.borderLeftStyle !== 'none' || c.boxShadow !== 'none' || c.outlineStyle !== 'none'; }).map((e) => e.className)`,
  );

/** Dark, light and high contrast; on the start page, high contrast holds Noodle still. */
async function screenshots(panel: Panel, name: string): Promise<void> {
  await panel.page.mouse.move(0, 0);
  for (const slug of THEMES) {
    await panel.theme(slug);
    await panel.screenshot(`${name}-${slug}`);
    if (slug === 'high-contrast' && (await panel.count('.start-page')) === 1) expect(await motion(panel), 'Noodle stands still in high contrast').toBe('still');
  }
  await panel.theme('dark');
}

/** The extension's side: the header with the branch, the project's sessions, a session loaded on click, and one turn that waits for `release`. */
async function playHost(panel: Panel): Promise<() => void> {
  const { host } = panel;
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  const list = ({ scope }: { readonly scope: HistoryScope }) => host.post({ type: 'history', scope, rows: ROWS });
  host.on('list-sessions', list);
  await host.post({ type: 'header', header: { project: PROJECT, title: undefined, branch: BRANCH } });
  // The page asks for the sessions as it starts, before the test can answer.
  await list(await host.next('list-sessions'));
  host.on('open-session', async ({ id }) => {
    const session = SESSIONS.find((s) => s.id === id)!;
    await host.act({ type: 'reset', transcript: replayed(id, session.prompt) });
  });
  host.on('send', async ({ text }) => {
    await host.act(turnStart('t1', text));
    await released;
    await host.act({ type: 'text', text: ANSWER }, { type: 'turn-end', at: Date.now(), status: 'done', usage: usageOf(MODEL) });
  });
  return release;
}

afterAll(closeBrowser);

describe('the start page and the peek in the chat webview', () => {
  it('shows Noodle alone with geno, the branch and recent sessions; moves only when it may; peeks over the composer while the user types', async () => {
    const panel = await openPanel();
    const release = await playHost(panel);

    await panel.waitFor('the start page', async () => (await panel.count('.start-page canvas.start-dino')) === 1);
    expect(await panel.count('.start-stage > *'), 'the stage holds only Noodle and its shadow').toBe(2);
    expect(await textOf(panel, '.start-name'), 'the start page names geno').toBe('geno');
    expect(await textOf(panel, '.start-project'), 'the start page names the project').toBe(PROJECT);
    expect(await textOf(panel, '.start-branch'), 'and its branch').toBe(BRANCH);
    await panel.waitFor('the recent sessions', async () => (await panel.count('.start-recent')) === 3);
    const recents = await panel.eval<string[]>(`[...doc.querySelectorAll('.start-recent-title')].map((e) => e.textContent)`);
    expect(recents, 'Continue lists the three newest sessions of this project, newest first').toEqual([...SESSIONS].reverse().slice(0, 3).map((s) => s.prompt));
    const agos = await panel.eval<string[]>(`[...doc.querySelectorAll('.start-recent-ago')].map((e) => e.textContent)`);
    expect(agos.every((ago) => /^(\d+[mhd] ago|just now|[A-Z][a-z]{2} \d+(, \d{4})?)$/.test(ago)), `each recent session says how long ago: ${JSON.stringify(agos)}`).toBe(true);
    expect(await framed(panel), 'no dino element has a background, border or shadow').toEqual([]);
    const scale = await panel.eval<{ width: number; height: number; rendering: string }>(
      `(() => { const c = doc.querySelector('.start-dino'); const r = c.getBoundingClientRect(); return { width: r.width / c.width, height: r.height / c.height, rendering: getComputedStyle(c).imageRendering }; })()`,
    );
    expect(scale, 'Noodle is drawn at 4×, pixelated').toEqual({ width: 4, height: 4, rendering: 'pixelated' });

    await focus(panel, false);
    await panel.waitFor('Noodle to rest while the window is not focused', async () => (await motion(panel)) === 'paused');
    expect(await movesWithin(panel, 700), 'Noodle holds its pose while the window is not focused').toBe(false);
    await focus(panel, true);
    await panel.waitFor('Noodle to wander with the window focused', async () => (await motion(panel)) === 'moving');
    expect(await movesWithin(panel, 700), 'Noodle moves on the start page').toBe(true);

    // A click while Noodle is already in the air, or mid-turn, is ignored, so the test clicks until one lands on the ground.
    await panel.waitFor('a click on Noodle to start a somersault', async () => {
      await panel.click('.start-dino');
      return (await panel.eval<string>(`doc.querySelector('.start-page').dataset.move`)) === 'somersault';
    });
    // Upside down or on its back, the sprite's second row is empty or its last row is not.
    const rolled = await panel.eval<boolean>(
      `new Promise((done) => { const c = doc.querySelector('.start-dino'); const until = Date.now() + 1500; (function look() { const rows = c.dataset.frame.match(/.{24}/g); if (!/[^.]/.test(rows[1]) || /[^.]/.test(rows[23])) done(true); else if (Date.now() > until) done(false); else doc.defaultView.setTimeout(look, 20); })(); })`,
    );
    expect(rolled, 'the somersault turns the whole sprite over').toBe(true);
    await reducedMotion(panel, true);
    await panel.waitFor('reduced motion', async () => (await motion(panel)) === 'still');
    expect(await movesWithin(panel, 700), 'Noodle stays still in its idle pose under reduced motion').toBe(false);
    expect((await panel.eval<string>(`doc.querySelector('.start-dino').dataset.frame.match(/.{24}/g)[3]`)).slice(17, 19), 'the still pose is the idle frame, eye open').toBe('wk');
    await reducedMotion(panel, false);
    await panel.waitFor('motion again', async () => (await motion(panel)) !== 'still');
    await screenshots(panel, 'start');
    expect(await motion(panel), 'Noodle moves again after high contrast').toBe('moving');

    // A recent session loads on click. The chat is then idle, and the peek stays behind the composer until the user types.
    const newest = SESSIONS.at(-1)!;
    await panel.click(`.start-recent[data-session="${newest.id}"]`);
    expect((await panel.host.next('open-session')).id, 'the click asks the extension for that session').toBe(newest.id);
    await panel.waitFor('the recent session to load', async () => (await textOf(panel, '.request-bubble')) === newest.prompt);
    expect(await panel.count('.start-page'), 'the start page leaves once a session shows').toBe(0);
    await leaveComposer(panel);
    await pause(800);
    expect(await peekState(panel), 'the peek stays hidden while the chat is idle').toBe('away');

    // Typing a few characters brings Noodle up once, with a wave the first time; then it watches the text.
    await watchPeek(panel);
    await panel.click('textarea');
    await panel.type('fi');
    await pause(400);
    expect(await peekState(panel), 'two characters are not enough to climb').toBe('away');
    await panel.type('x the');
    await panel.waitFor('the peek to climb, wave and watch the text', async () => (await peekState(panel)) === 'typing');
    expect(await peekSeen(panel), 'the peek climbs once, waves on its first appearance, then watches').toEqual(['away', 'climb', 'wave', 'typing']);
    await panel.type(' bug');
    expect((await peekSeen(panel)).filter((state) => state === 'climb'), 'more keystrokes do not climb again').toHaveLength(1);
    await panel.waitFor('the eyes to look down toward the text', async () => (await peekEye(panel)) === 'downLeft');
    expect(await framed(panel), 'the avatar and the peek have no background, border or shadow').toEqual([]);
    const body = await panel.eval<{ width: number; height: number; cols: number; rows: number; rendering: string }>(
      `(() => { const c = doc.querySelector('.peek-body'); const r = c.getBoundingClientRect(); return { width: r.width, height: r.height, cols: c.width, rows: c.height, rendering: getComputedStyle(c).imageRendering }; })()`,
    );
    expect(body, 'the peek is the whole 24 by 24 body at 2×, pixelated').toEqual({ width: 48, height: 48, cols: 24, rows: 24, rendering: 'pixelated' });
    const sits = await panel.eval<{ peek: number; box: number; right: number; boxRight: number; tray: number; hands: string }>(
      `(() => { const p = doc.querySelector('.peek').getBoundingClientRect(); const b = doc.querySelector('.input-box').getBoundingClientRect(); const rows = doc.querySelector('.peek-body').dataset.frame.match(/.{24}/g); return { peek: p.bottom, box: b.top, right: p.right, boxRight: b.right, tray: doc.querySelector('.tray').hidden ? b.top : doc.querySelector('.tray').getBoundingClientRect().top, hands: rows.slice(22).join('/') }; })()`,
    );
    expect(Math.abs(sits.peek - sits.box) <= 2 && sits.right > sits.boxRight - 100 && sits.peek <= sits.tray + 2, `Noodle leans on the composer's top edge, on the right, above the tray: ${JSON.stringify(sits)}`).toBe(true);
    expect(sits.hands.split('/')[0], 'both hands grip the edge, knuckles up').toMatch(/dgd.*dgd/);

    // A pause in typing brings one move, then Noodle watches again.
    await panel.waitFor('one move after a pause', async () => (await peekSeen(panel)).some((state) => state === 'drum' || state === 'lookAround'));
    await panel.waitFor('the move to end', async () => (await peekState(panel)) === 'typing');
    await focus(panel, false);
    await screenshots(panel, 'peek');
    await focus(panel, true);

    // Under reduced motion Noodle holds still: both hands on the edge, eyes ahead, no move after a pause.
    await reducedMotion(panel, true);
    await panel.waitFor('the peek to hold still', async () => (await peekEye(panel)) === 'open');
    await watchPeek(panel);
    await panel.type('!');
    await pause(3800);
    expect(await peekSeen(panel), 'under reduced motion the peek plays no move').toEqual(['typing']);
    await reducedMotion(panel, false);

    // Emptying the composer ducks it; typing again climbs, with no second wave.
    await setDraft(panel, '');
    await panel.waitFor('the peek to duck when the composer is emptied', async () => (await peekState(panel)) === 'away');
    expect(await peekSeen(panel), 'the peek ducks rather than vanishing').toContain('duck');
    await watchPeek(panel);
    await panel.type(FOLLOW_UP);
    await panel.waitFor('the peek to climb again', async () => (await peekState(panel)) === 'typing');
    expect(await peekSeen(panel), 'the wave plays once a session').not.toContain('wave');

    // Sending ducks it, and it stays down while the turn runs, even while the user types a follow-up.
    await panel.press('Enter');
    expect((await panel.host.next('send')).text, 'Enter sends the draft').toBe(FOLLOW_UP);
    await panel.waitFor('the turn to run', async () => (await panel.count('.turn[aria-busy="true"]')) === 1);
    await panel.waitFor('the peek to duck on send', async () => (await peekState(panel)) === 'away');
    expect((await peekSeen(panel)).at(-2), 'the peek ducks on send').toBe('duck');
    await panel.type('and then this');
    await pause(500);
    expect(await peekState(panel), 'the peek hides while a turn runs').toBe('away');
    await setDraft(panel, '');
    release();
    await panel.waitFor('the turn to end', async () => (await panel.count('.turn[aria-busy="true"]')) === 0 && (await panel.count('.turn-footer')) === 2);
    expect(await textOf(panel, '.turn:last-child .markdown'), 'the answer shows').toContain(ANSWER);
    await pause(800);
    expect(await peekState(panel), 'the peek stays hidden after the turn while the chat is idle').toBe('away');
    expect(panel.host.received.filter((m) => m.type === 'send'), 'the page sent one request').toHaveLength(1);
    await panel.close();
  });
});
