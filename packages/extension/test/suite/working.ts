import * as vscode from 'vscode';
import { AGAIN_REPLIES, ANSWERS, PROMPTS, THEMES, WORK } from './working-fixture.js';

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
    await new Promise((r) => setTimeout(r, 100));
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
const arrived = async () => (await ui<{ arrived: number }>({ do: 'requests' })).arrived;

/** The suite sends the extension's window-focus message itself, as the start suite does: unfocused, Noodle holds its frame. */
const focus = (focused: boolean) => panel(`(doc.defaultView.postMessage({ type: 'window-focus', focused: ${focused} }, '*'), 1)`);
const pose = () => panel<string | null>(`doc.querySelector('.working-dino')?.dataset.pose ?? null`);
const frame = () => panel<string | null>(`doc.querySelector('.working-dino')?.dataset.frame ?? null`);

/** Records every pose the working dino shows from now on, and `none` while there is no dino. */
const watchPoses = () =>
  panel(
    `(() => { const w = doc.defaultView; const now = () => doc.querySelector('.working-dino')?.dataset.pose ?? 'none'; w.poses = [now()]; w.poseWatch?.disconnect(); w.poseWatch = new MutationObserver(() => { const p = now(); if (w.poses.at(-1) !== p) w.poses.push(p); }); w.poseWatch.observe(doc.querySelector('.transcript'), { subtree: true, childList: true, attributes: true, attributeFilter: ['data-pose'] }); return 1; })()`,
  );
const poses = () => panel<string[]>('doc.defaultView.poses');

const framed = () =>
  panel<string[]>(
    `[...doc.querySelectorAll('.dino')].filter((e) => { const c = getComputedStyle(e); return c.backgroundColor !== 'rgba(0, 0, 0, 0)' || c.backgroundImage !== 'none' || c.borderTopStyle !== 'none' || c.borderLeftStyle !== 'none' || c.boxShadow !== 'none' || c.outlineStyle !== 'none'; }).map((e) => e.className)`,
  );

async function theme(name: string): Promise<void> {
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', name, vscode.ConfigurationTarget.Global);
  await sleep(1500);
  await vscode.commands.executeCommand('notifications.clearAll');
  await sleep(300);
}

/** Dark glass, light glass and high contrast, each as a window capture and a panel capture. */
async function screenshots(name: string): Promise<void> {
  await ui({ do: 'pointerAway' });
  for (const [slug, colorTheme] of Object.entries(THEMES)) {
    await theme(colorTheme);
    await panel(`(doc.querySelector('.transcript').scrollTop = 1e9, 1)`);
    await sleep(300);
    await ui({ do: 'screenshot', name: `${name}-${slug}` });
    await ui({ do: 'panelshot', name: `${name}-${slug}-panel` });
  }
  await theme(THEMES.dark);
}

/** Lets Noodle move for `ms`, then holds it for a still of the panel. */
async function still(name: string, ms: number): Promise<void> {
  await focus(true);
  await sleep(ms);
  await focus(false);
  await panel(`(doc.querySelector('.transcript').scrollTop = 1e9, 1)`);
  await ui({ do: 'pointerAway' });
  await ui({ do: 'panelshot', name });
}

async function send(prompt: string): Promise<void> {
  await click('textarea');
  await ui({ do: 'type', text: prompt });
  await ui({ do: 'press', key: 'Enter' });
}

async function setMode(mode: 'ask' | 'plan'): Promise<void> {
  await click('.mode-picker');
  await waitFor('the mode menu', async () => (await count('.mode-menu:not([hidden]) .mode-option')) === 3);
  await click(`.mode-option[data-mode="${mode}"]`);
  await waitFor(`the engine to confirm ${mode}`, async () => (await panel<string>(`doc.querySelector('.input-box').dataset.mode`)) === mode);
}

/** How long Noodle moves before each pose's still: the laptop needs its pull-out and glasses. */
const SHOW_MS: Readonly<Record<string, number>> = { coding: 1500, reading: 500, writing: 500, running: 300 };

export async function run(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('gcode.chat.focus');
  for (let i = 0; i < 5; i++) await vscode.commands.executeCommand('workbench.action.decreaseViewWidth');

  // The working turn: it thinks, reads, codes in a .ts file, writes in a .md file, runs a command and a check.
  await focus(true);
  await watchPoses();
  await send(PROMPTS.work);
  await waitFor('the turn to run', async () => (await count('.turn[aria-busy="true"]')) === 1);
  await waitFor('Noodle to think while the model works', async () => (await pose()) === 'thinking');
  const placed = await panel<{ width: number; height: number; cols: number; rows: number; rendering: string; inStep: boolean; last: boolean; avatar: string; spinner: string; right: number; turnRight: number }>(
    `(() => { const c = doc.querySelector('.working-dino'); const r = c.getBoundingClientRect(); const step = c.parentElement; const steps = [...doc.querySelectorAll('.turn[aria-busy="true"] > .rail > .step')]; return { width: r.width, height: r.height, cols: c.width, rows: c.height, rendering: getComputedStyle(c).imageRendering, inStep: step.matches('.turn[aria-busy="true"] > .rail > .step'), last: steps.at(-1) === step, avatar: getComputedStyle(doc.querySelector('.turn[aria-busy="true"] .avatar')).display, spinner: getComputedStyle(doc.querySelector('.turn[aria-busy="true"] .turn-working')).display, right: r.right, turnRight: doc.querySelector('.turn[aria-busy="true"]').getBoundingClientRect().right }; })()`,
  );
  check(placed.width === 48 && placed.height === 48 && placed.cols === 24 && placed.rows === 24 && placed.rendering === 'pixelated', 'the working dino is the sprite at 2×, 48 px, pixelated', placed);
  check(placed.inStep && placed.last && Math.abs(placed.right - placed.turnRight) <= 1, 'it stands beside the running turn’s current step, at the right', placed);
  check(placed.avatar === 'none' && placed.spinner !== 'none', 'the turn’s 24 px avatar steps aside for a spinner while the working dino shows', placed);
  check((await framed()).length === 0, 'no dino has a background, border or shadow', await framed());

  // The CPU profile: 10 s of a running turn with Noodle thinking, alternated with 10 s of the same turn with Noodle
  // resting, where the turn's clock, the rail and the composer's rainbow still run.
  for (let run = 1; run <= 3; run++) {
    for (let attempt = 1; ; attempt++) {
      await focus(true);
      const { timers } = await ui<{ timers: number }>({ do: 'perf', label: `running turn, Noodle thinking, run ${run}, attempt ${attempt}` });
      if (timers >= 130) break;
      check(attempt < 4, 'Noodle animated through a whole 10 s profile', timers);
    }
    await focus(false);
    await ui({ do: 'perf', label: `running turn, Noodle resting, run ${run}` });
  }
  await focus(true);
  await screenshots('thinking');
  await still('pose-thinking-dark-panel', 800);

  // Each reply goes while Noodle rests, so the pose it brings holds for its still however short the step.
  const shot = new Set<string>();
  for (const [i, call] of WORK.entries()) {
    await focus(false);
    await ui({ do: 'release' });
    await waitFor(`the ${call.name} step to finish`, async () => (await arrived()) === i + 2);
    await waitFor(`Noodle to show ${call.pose} for ${call.name} ${JSON.stringify(call.input)}`, async () => (await pose()) === call.pose);
    if (!shot.has(call.pose)) await still(`pose-${call.pose}-dark-panel`, SHOW_MS[call.pose] ?? 500);
    shot.add(call.pose);
  }
  await focus(true);
  await ui({ do: 'release' });
  await waitFor('the working turn to end', async () => (await count('.turn[aria-busy="true"]')) === 0);
  await waitFor('the turn-end move to finish', async () => (await pose()) === null, 10_000);
  const work = (await poses()).filter((p) => p !== 'thinking');
  check(JSON.stringify(work) === JSON.stringify(['none', ...WORK.map((c) => c.pose).filter((p, i, all) => all[i - 1] !== p), 'flex', 'none']), 'the dino switched poses with the steps, then flexed once, as the check passed', await poses());
  const after = await panel<{ avatar: string; spinner: string; working: string | null }>(`(() => { const t = doc.querySelector('.turn:last-child'); return { avatar: getComputedStyle(t.querySelector('.avatar')).display, spinner: getComputedStyle(t.querySelector('.turn-working')).display, working: t.dataset.working ?? null }; })()`);
  check(after.avatar !== 'none' && after.spinner === 'none' && after.working === null, 'the finished turn shows its still 24 px avatar again', after);
  check((await textOf('.turn:last-child .markdown'))?.includes(ANSWERS.work) === true, 'the answer shows');

  // A failed read brings sweat; a command Ask holds brings the question mark; a turn without checks hops or rolls.
  await watchPoses();
  await send(PROMPTS.trouble);
  await waitFor('the second turn to think', async () => (await pose()) === 'thinking');
  await focus(false);
  await ui({ do: 'release' });
  await waitFor('Noodle to sweat after the failed read', async () => (await pose()) === 'sweat');
  await still('pose-sweat-dark-panel', 800);
  await ui({ do: 'release' });
  await waitFor('the permission card', async () => (await count('.permission-open')) === 1);
  await waitFor('Noodle to ask while the card waits', async () => (await pose()) === 'asking');
  await still('pose-asking-dark-panel', 500);
  await screenshots('asking');
  await click('.permission-open button', 'Deny');
  await waitFor('Noodle to sweat after the denied command', async () => (await pose()) === 'sweat');
  await focus(true);
  await ui({ do: 'release' });
  await waitFor('the second turn to end', async () => (await count('.turn[aria-busy="true"]')) === 0);
  await waitFor('its turn-end move to finish', async () => (await pose()) === null, 10_000);
  const trouble = await poses();
  check(['hop', 'somersault'].includes(trouble.at(-2)!) && !trouble.includes('flex'), 'a turn without a passing check hops or somersaults, and does not flex', trouble);

  // Plan mode: the clipboard. Under reduced motion the pose holds its first frame, and the turn ends with no move.
  await setMode('plan');
  await watchPoses();
  await send(PROMPTS.plan);
  await waitFor('Noodle to plan', async () => (await pose()) === 'planning');
  await still('pose-planning-dark-panel', 1500);
  await focus(true);
  await ui({ do: 'motion', value: 'reduce' });
  await sleep(300);
  const held = await frame();
  await sleep(800);
  check((await frame()) === held, 'under reduced motion the pose does not animate', [held, await frame()]);
  await ui({ do: 'release' });
  await waitFor('the plan turn to read', async () => (await arrived()) === WORK.length + 1 + 3 + 2);
  check((await pose()) === 'planning', 'a Plan turn keeps the clipboard while it reads', await pose());
  await ui({ do: 'release' });
  await waitFor('the plan turn to end', async () => (await count('.turn[aria-busy="true"]')) === 0);
  await waitFor('the dino to leave', async () => (await pose()) === null, 10_000);
  const planned = await poses();
  check(planned.at(-2) === 'planning' && planned.at(-1) === 'none', 'under reduced motion the turn ends with no move', planned);
  await ui({ do: 'motion', value: '' });

  // The same work again, recorded: the laptop comes out again in a new turn, and the turn ends with a flex.
  await setMode('ask');
  await watchPoses();
  await send(PROMPTS.work);
  await waitFor('the recorded turn to run', async () => (await count('.turn[aria-busy="true"]')) === 1);
  await ui({ do: 'record', name: 'working', replies: AGAIN_REPLIES, every: 1400 });
  await waitFor('the recorded turn to end', async () => (await count('.turn[aria-busy="true"]')) === 0);
  await waitFor('its flex to finish', async () => (await pose()) === null, 10_000);
  const again = await poses();
  check(again.includes('coding') && again.at(-2) === 'flex', 'the recorded turn codes and ends with a flex', again);
}
