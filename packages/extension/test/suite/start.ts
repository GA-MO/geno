import * as vscode from 'vscode';
import { ANSWER, BRANCH, FOLLOW_UP, SESSIONS, THEMES } from './start-fixture.js';
import { SHOOTING } from './shooting.js';

const PERF = process.env['GCODE_PERF'] === '1';

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
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function theme(name: keyof typeof THEMES): Promise<void> {
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', THEMES[name], vscode.ConfigurationTarget.Global);
  await pause(1500);
  await vscode.commands.executeCommand('notifications.clearAll');
  await pause(300);
}

async function screenshots(name: string): Promise<void> {
  if (!SHOOTING) return;
  for (const slug of Object.keys(THEMES) as (keyof typeof THEMES)[]) {
    await theme(slug);
    await ui({ do: 'screenshot', name: `${name}-${slug}` });
    await ui({ do: 'panelshot', name: `${name}-${slug}-panel` });
  }
  await theme('dark');
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

  // The start page, from what the extension and the engine know: the folder, its git branch, and the newest sessions the engine logged.
  await waitFor('the start page', async () => (await count('.start-page canvas.start-dino')) === 1);
  check((await textOf('.start-project')) === vscode.workspace.workspaceFolders![0]!.name, 'the start page names the project', await textOf('.start-project'));
  await waitFor('the branch', async () => (await textOf('.start-branch')) === BRANCH);
  const newest = [...SESSIONS].reverse().slice(0, 3).map((s) => s.prompt);
  await waitFor('the recent sessions', async () => (await count('.start-recent')) === 3);
  const recents = await panel<string[]>(`[...doc.querySelectorAll('.start-recent-title')].map((e) => e.textContent)`);
  check(recents.join('|') === newest.join('|'), 'Continue lists the three newest sessions of this project, newest first', recents);

  // Whether the test window has the focus depends on what else is on the screen, so the suite sends the
  // extension's window-focus message itself, through the same handler.
  const focus = (focused: boolean) => panel(`(doc.defaultView.postMessage({ type: 'window-focus', focused: ${focused} }, '*'), 1)`);
  const awake = async () => {
    await focus(true);
    await waitFor('Noodle to wander with the window focused', async () => (await motion()) === 'moving');
  };
  if (PERF) {
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
  }
  if (SHOOTING) {
    await awake();
    await ui({ do: 'record', name: 'start' });
    await ui({ do: 'pointerAway' });
    await screenshots('start');
  }

  // A recent session loads on click, replayed from the engine's log.
  await click(`.start-recent[data-session="${SESSIONS.at(-1)!.id}"]`);
  await waitFor('the recent session to load', async () => (await textOf('.request-bubble')) === SESSIONS.at(-1)!.prompt);
  check((await count('.start-page')) === 0, 'the start page leaves once a session shows');
  check((await textOf('.turn:last-child .markdown'))?.includes('Done.') === true, 'the loaded session shows its answer', await textOf('.turn:last-child .markdown'));

  // A follow-up in the loaded session reaches the model once, and its answer shows.
  await click('textarea');
  await ui({ do: 'type', text: FOLLOW_UP });
  await ui({ do: 'press', key: 'Enter' });
  await waitFor('the turn to run', async () => (await count('.turn[aria-busy="true"]')) === 1);
  await ui({ do: 'release' });
  await waitFor('the turn to end', async () => (await count('.turn[aria-busy="true"]')) === 0 && (await count('.turn-footer')) === 2);
  check((await textOf('.turn:last-child .markdown'))?.includes(ANSWER) === true, 'the answer shows');
}
