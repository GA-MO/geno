import * as vscode from 'vscode';
import { ANSWER, BRANCH, FOLLOW_UP, SESSIONS, THEMES } from './start-fixture.js';

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
const click = (selector: string) => ui({ do: 'click', selector });
const textOf = (selector: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
const motion = () => panel<string>(`doc.querySelector('.start-page').dataset.motion`);
const peekState = () => panel<string>(`doc.querySelector('.peek').dataset.state`);
/** Moves the focus from the composer to the transcript; a window regaining the focus can hand the composer the focus again, so callers repeat it. */
const leaveComposer = () => panel(`(doc.activeElement.blur(), doc.querySelector('.transcript').focus(), 1)`);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the start page shows of Noodle: its picture and where it stands. */
const pose = () => panel<string>(`doc.querySelector('.start-dino').dataset.frame + '@' + doc.querySelector('.start-dino').style.transform`);

async function movesWithin(ms: number): Promise<boolean> {
  const before = await pose();
  await pause(ms);
  return (await pose()) !== before;
}

/** The peek's eye, read from its two eye cells: level, up or down a row, the pupil to the right or the left. */
async function peekEye(): Promise<string> {
  const rows = (await panel<string>(`doc.querySelector('.peek-body').dataset.frame`)).match(/.{24}/g)!;
  const EYES: Record<string, string> = { '2:wk': 'up', '2:kw': 'upLeft', '3:wk': 'open', '3:kw': 'left', '3:kk': 'blink', '4:wk': 'down', '4:kw': 'downLeft' };
  for (const row of [2, 3, 4]) {
    const eye = EYES[`${row}:${rows[row]!.slice(17, 19)}`];
    if (eye !== undefined) return eye;
  }
  return `unknown ${rows.slice(2, 5).join('/')}`;
}

/** Every state the peek has been in since `watchPeek`, in order. */
const watchPeek = () =>
  panel(
    `(() => { const w = doc.defaultView; w.peekSeen = [doc.querySelector('.peek').dataset.state]; w.peekWatch?.disconnect(); w.peekWatch = new MutationObserver(() => { const now = doc.querySelector('.peek').dataset.state; if (w.peekSeen.at(-1) !== now) w.peekSeen.push(now); }); w.peekWatch.observe(doc.querySelector('.peek'), { attributes: true, attributeFilter: ['data-state'] }); return 1; })()`,
  );
const peekSeen = () => panel<string[]>(`doc.defaultView.peekSeen`);
const setDraft = (text: string) =>
  panel(`(() => { const t = doc.querySelector('textarea'); t.value = ${JSON.stringify(text)}; t.focus(); t.dispatchEvent(new Event('input', { bubbles: true })); return ${JSON.stringify(text)}; })()`);

async function theme(name: keyof typeof THEMES): Promise<void> {
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', THEMES[name], vscode.ConfigurationTarget.Global);
  await pause(1500);
  await vscode.commands.executeCommand('notifications.clearAll');
  await pause(300);
}

async function screenshots(name: string): Promise<void> {
  for (const slug of Object.keys(THEMES) as (keyof typeof THEMES)[]) {
    await theme(slug);
    await ui({ do: 'screenshot', name: `${name}-${slug}` });
    await ui({ do: 'panelshot', name: `${name}-${slug}-panel` });
    if (slug === 'high-contrast' && (await count('.start-page')) === 1) check((await motion()) === 'still', 'Noodle stands still in high contrast', await motion());
  }
  await theme('dark');
}

const framed = () =>
  panel<string[]>(
    `[...doc.querySelectorAll('.dino')].filter((e) => { const c = getComputedStyle(e); return c.backgroundColor !== 'rgba(0, 0, 0, 0)' || c.backgroundImage !== 'none' || c.borderTopStyle !== 'none' || c.borderLeftStyle !== 'none' || c.boxShadow !== 'none' || c.outlineStyle !== 'none'; }).map((e) => e.className)`,
  );

export async function run(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('gcode.chat.focus');
  for (let i = 0; i < 5; i++) await vscode.commands.executeCommand('workbench.action.decreaseViewWidth');

  // The start page: Noodle alone, geno, the project and its branch, and the newest sessions to continue.
  await waitFor('the start page', async () => (await count('.start-page canvas.start-dino')) === 1);
  check((await count('.start-stage > *')) === 2, 'the stage holds only Noodle and its shadow', await count('.start-stage > *'));
  check((await textOf('.start-name')) === 'geno', 'the start page names geno', await textOf('.start-name'));
  check((await textOf('.start-project')) === vscode.workspace.workspaceFolders![0]!.name, 'the start page names the project', await textOf('.start-project'));
  await waitFor('the branch', async () => (await textOf('.start-branch')) === BRANCH);
  const newest = [...SESSIONS].reverse().slice(0, 3).map((s) => s.prompt);
  await waitFor('the recent sessions', async () => (await count('.start-recent')) === 3);
  const recents = await panel<string[]>(`[...doc.querySelectorAll('.start-recent-title')].map((e) => e.textContent)`);
  check(recents.join('|') === newest.join('|'), 'Continue lists the three newest sessions of this project, newest first', recents);
  const agos = await panel<string[]>(`[...doc.querySelectorAll('.start-recent-ago')].map((e) => e.textContent)`);
  check(agos.every((ago) => /^(\d+[mhd] ago|just now|[A-Z][a-z]{2} \d+(, \d{4})?)$/.test(ago)), 'each recent session says how long ago', agos);
  check((await framed()).length === 0, 'no dino element has a background, border or shadow', await framed());
  const scale = await panel<{ width: number; height: number; rendering: string }>(
    `(() => { const c = doc.querySelector('.start-dino'); const r = c.getBoundingClientRect(); return { width: r.width / c.width, height: r.height / c.height, rendering: getComputedStyle(c).imageRendering }; })()`,
  );
  check(scale.width === 4 && scale.height === 4 && scale.rendering === 'pixelated', 'Noodle is drawn at 4×, pixelated', scale);

  // Whether the test window has the focus depends on what else is on the screen, so the suite sends the
  // extension's window-focus message itself, through the same handler.
  const focus = (focused: boolean) => panel(`(doc.defaultView.postMessage({ type: 'window-focus', focused: ${focused} }, '*'), 1)`);
  await focus(false);
  await waitFor('Noodle to rest while the window is not focused', async () => (await motion()) === 'paused');
  check(!(await movesWithin(700)), 'Noodle holds its pose while the window is not focused');
  // The real window can lose the focus at any time while the suite runs, so each step that needs Noodle moving wakes it first.
  const awake = async () => {
    await focus(true);
    await waitFor('Noodle to wander with the window focused', async () => (await motion()) === 'moving');
  };
  await awake();
  check(await movesWithin(700), 'Noodle moves on the start page');
  // The CPU profile: 10 s of the wandering start page, alternated with 10 s of the same page with Noodle resting,
  // where everything else, the composer's rainbow too, still runs.
  // 10 s at a 70 ms tick is about 143 ticks; a run with far fewer timers had Noodle resting, the window having lost
  // the focus, and is taken again.
  for (let run = 1; run <= 3; run++) {
    for (let attempt = 1; ; attempt++) {
      await awake();
      const { timers } = await ui<{ timers: number }>({ do: 'perf', label: `start page wandering, run ${run}, attempt ${attempt}` });
      if (timers >= 130) break;
      check(attempt < 4, 'Noodle wandered through a whole 10 s profile', timers);
    }
    await focus(false);
    await waitFor('Noodle to rest for the baseline', async () => (await motion()) === 'paused');
    await ui({ do: 'perf', label: `start page with Noodle resting, run ${run}` });
  }
  await awake();
  await ui({ do: 'record', name: 'start' });
  await awake();
  // A click while Noodle is already in the air, or mid-turn, is ignored, so the suite clicks until one lands on the ground.
  await waitFor('a click on Noodle to start a somersault', async () => {
    await click('.start-dino');
    return (await panel<string>(`doc.querySelector('.start-page').dataset.move`)) === 'somersault';
  }, 10_000);
  // Upside down or on its back, the sprite's second row is empty or its last row is not.
  const rolled = await panel<boolean>(
    `new Promise((done) => { const c = doc.querySelector('.start-dino'); const until = Date.now() + 1500; (function look() { const rows = c.dataset.frame.match(/.{24}/g); if (!/[^.]/.test(rows[1]) || /[^.]/.test(rows[23])) done(true); else if (Date.now() > until) done(false); else doc.defaultView.setTimeout(look, 20); })(); })`,
  );
  check(rolled, 'the somersault turns the whole sprite over');
  await ui({ do: 'motion', value: 'reduce' });
  await waitFor('reduced motion', async () => (await motion()) === 'still');
  check(!(await movesWithin(700)), 'Noodle stays still in its idle pose under reduced motion');
  check((await panel<string>(`doc.querySelector('.start-dino').dataset.frame.match(/.{24}/g)[3]`)).slice(17, 19) === 'wk', 'the still pose is the idle frame, eye open');
  await ui({ do: 'motion', value: '' });
  await waitFor('motion again', async () => (await motion()) !== 'still');

  await ui({ do: 'pointerAway' });
  await screenshots('start');

  // A recent session loads on click. The chat is then idle, and the peek stays behind the composer until the user types.
  await click(`.start-recent[data-session="${SESSIONS.at(-1)!.id}"]`);
  await waitFor('the recent session to load', async () => (await textOf('.request-bubble')) === SESSIONS.at(-1)!.prompt);
  check((await count('.start-page')) === 0, 'the start page leaves once a session shows');
  await focus(true);
  await leaveComposer();
  await pause(800);
  check((await peekState()) === 'away', 'the peek stays hidden while the chat is idle', await peekState());

  // Typing a few characters brings Noodle up once, with a wave the first time; then it watches the text.
  await watchPeek();
  await click('textarea');
  await ui({ do: 'type', text: 'fi' });
  await pause(400);
  check((await peekState()) === 'away', 'two characters are not enough to climb', await peekSeen());
  await ui({ do: 'type', text: 'x the' });
  await waitFor('the peek to climb, wave and watch the text', async () => (await peekState()) === 'typing', 10_000);
  check((await peekSeen()).join(' ') === 'away climb wave typing', 'the peek climbs once, waves on its first appearance, then watches', await peekSeen());
  await ui({ do: 'type', text: ' bug' });
  check((await peekSeen()).filter((state) => state === 'climb').length === 1, 'more keystrokes do not climb again', await peekSeen());
  await waitFor('the eyes to look down toward the text', async () => (await peekEye()) === 'downLeft');
  check((await framed()).length === 0, 'the avatar and the peek have no background, border or shadow', await framed());
  const body = await panel<{ width: number; height: number; cols: number; rows: number; rendering: string }>(
    `(() => { const c = doc.querySelector('.peek-body'); const r = c.getBoundingClientRect(); return { width: r.width, height: r.height, cols: c.width, rows: c.height, rendering: getComputedStyle(c).imageRendering }; })()`,
  );
  check(body.width === 48 && body.height === 48 && body.cols === 24 && body.rows === 24 && body.rendering === 'pixelated', 'the peek is the whole 24 by 24 body at 2×, pixelated', body);
  const sits = await panel<{ peek: number; box: number; right: number; boxRight: number; tray: number; hands: string }>(
    `(() => { const p = doc.querySelector('.peek').getBoundingClientRect(); const b = doc.querySelector('.input-box').getBoundingClientRect(); const rows = doc.querySelector('.peek-body').dataset.frame.match(/.{24}/g); return { peek: p.bottom, box: b.top, right: p.right, boxRight: b.right, tray: doc.querySelector('.tray').hidden ? b.top : doc.querySelector('.tray').getBoundingClientRect().top, hands: rows.slice(22).join('/') }; })()`,
  );
  check(Math.abs(sits.peek - sits.box) <= 2 && sits.right > sits.boxRight - 100 && sits.peek <= sits.tray + 2, 'Noodle leans on the composer\'s top edge, on the right, above the tray', sits);
  check(/dgd.*dgd/.test(sits.hands.split('/')[0]!), 'both hands grip the edge, knuckles up', sits.hands);

  // A pause in typing brings one move, then Noodle watches again.
  await waitFor('one move after a pause', async () => (await peekSeen()).some((state) => state === 'drum' || state === 'lookAround'), 10_000);
  await waitFor('the move to end', async () => (await peekState()) === 'typing', 10_000);
  await focus(false);
  await ui({ do: 'pointerAway' });
  await screenshots('peek');
  await focus(true);

  // Under reduced motion Noodle holds still: both hands on the edge, eyes ahead, no move after a pause.
  await ui({ do: 'motion', value: 'reduce' });
  await waitFor('the peek to hold still', async () => (await peekEye()) === 'open');
  await watchPeek();
  await ui({ do: 'type', text: '!' });
  await pause(3800);
  check((await peekSeen()).join(' ') === 'typing', 'under reduced motion the peek plays no move', await peekSeen());
  await ui({ do: 'motion', value: '' });

  // Emptying the composer ducks it; typing again climbs, with no second wave.
  await setDraft('');
  await waitFor('the peek to duck when the composer is emptied', async () => (await peekState()) === 'away');
  check((await peekSeen()).includes('duck'), 'the peek ducks rather than vanishing', await peekSeen());
  await watchPeek();
  await ui({ do: 'type', text: FOLLOW_UP });
  await waitFor('the peek to climb again', async () => (await peekState()) === 'typing', 10_000);
  check(!(await peekSeen()).includes('wave'), 'the wave plays once a session', await peekSeen());

  // Sending ducks it, and it stays down while the turn runs, even while the user types a follow-up.
  await ui({ do: 'press', key: 'Enter' });
  await waitFor('the turn to run', async () => (await count('.turn[aria-busy="true"]')) === 1);
  await waitFor('the peek to duck on send', async () => (await peekState()) === 'away');
  check((await peekSeen()).at(-2) === 'duck', 'the peek ducks on send', await peekSeen());
  await ui({ do: 'type', text: 'and then this' });
  await pause(500);
  check((await peekState()) === 'away', 'the peek hides while a turn runs', await peekState());
  await setDraft('');
  await ui({ do: 'release' });
  await waitFor('the turn to end', async () => (await count('.turn[aria-busy="true"]')) === 0 && (await count('.turn-footer')) === 2);
  check((await textOf('.turn:last-child .markdown'))?.includes(ANSWER) === true, 'the answer shows');
  await pause(800);
  check((await peekState()) === 'away', 'the peek stays hidden after the turn while the chat is idle', await peekState());
}
