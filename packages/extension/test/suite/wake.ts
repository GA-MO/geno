import * as vscode from 'vscode';
import { ANSWERS, DRAFT, PROMPT } from './wake-fixture.js';
import { check, click, count, openPanel, panel, panelWidth, press, screenshots, shown, sleep, textOf, ui, view, waitFor } from './lanes-ui.js';

const WAKING_ROW = '.task-row.current';
const job = '.command-job[data-job="bg-1"]';

/** Every shown element under `selector` stays inside its box, and nothing scrolls sideways. */
const fitsIn = (selector: string) =>
  panel<{ fits: boolean; wide: string[] }>(`(() => {
    const box = doc.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    const wide = [...doc.querySelectorAll(${JSON.stringify(`${selector} *`)})].filter((e) => e.getClientRects().length > 0 && e.getBoundingClientRect().right > box.right + 0.5).map((e) => e.className || e.tagName);
    return { fits: wide.length === 0 && doc.scrollingElement.scrollWidth <= doc.scrollingElement.clientWidth, wide };
  })()`);

async function openTasks(): Promise<void> {
  await vscode.commands.executeCommand('gcode.chat.tasks');
  await waitFor('the Tasks pane', async () => (await view()) === 'tasks');
  // Working folds to one line; the waiting row is in it.
  if ((await panel<string | null>(`doc.querySelector('.tasks-fold')?.getAttribute('aria-expanded') ?? null`)) === 'false') await click('.tasks-fold');
}

async function closeTasks(): Promise<void> {
  await press('Escape');
  await waitFor('the chat again', async () => (await view()) !== 'tasks');
}

export async function run(): Promise<void> {
  await openPanel();
  await panelWidth(420);

  await click('textarea');
  await ui({ do: 'type', text: PROMPT });
  await press('Enter');
  await waitFor('the first turn to end while the build runs', async () => (await count('.turn-footer')) === 1, 90_000, () => textOf('.transcript'));
  check(((await textOf('.transcript')) ?? '').includes(ANSWERS.first), 'the model ended its turn with the build still running');
  await waitFor('the build to run in the background', async () => (await textOf(`${job}.job-running .job-line`)) === 'Running in background as bg-1');

  await waitFor('the pill to count the waiting chat as running', async () => ((await textOf('.activity-pill')) ?? '').includes('1 running'), 10_000, () => textOf('.activity-pill'));
  check((await textOf('.activity-label')) === 'Wakes on bg-1', 'the label says what the chat waits for', await textOf('.activity-label'));

  await openTasks();
  await waitFor('the waiting row', async () => await shown(`${WAKING_ROW} .task-wakes`), 10_000, () => textOf('.tasks'));
  check((await textOf(`${WAKING_ROW} .task-wakes`)) === 'Wakes on bg-1', 'the row says what will wake the chat', await textOf(`${WAKING_ROW} .task-wakes`));
  check((await textOf(`${WAKING_ROW} .task-state`)) === 'Waiting to wake', 'its badge says it waits to be woken', await textOf(`${WAKING_ROW} .task-state`));
  check(await shown(`${WAKING_ROW} [data-action="wake-cancel"]`), 'the row offers Cancel');
  check((await panel<string | null>(`doc.querySelector('${WAKING_ROW}').closest('[data-section]')?.dataset.section ?? null`)) === 'working', 'the row is in Working');
  await screenshots('tasks-waiting');
  const narrow = await panelWidth(300);
  check(Math.abs(narrow - 300) <= 4, 'the panel narrows to about 300px', narrow);
  await sleep(300);
  const tasksFit = await fitsIn('.tasks');
  check(tasksFit.fits, `the waiting row and its Cancel fit at ${narrow}px`, tasksFit);
  await screenshots('tasks-waiting-300');
  await panelWidth(420);
  await closeTasks();

  // A draft holds the wake back, however long the build has been done.
  await click('textarea');
  await ui({ do: 'type', text: DRAFT });
  const folder = vscode.workspace.workspaceFolders![0]!.uri;
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, 'go'), new Uint8Array());
  await waitFor('the build to end', async () => (await textOf(`${job}.job-ended .job-line`)) === 'bg-1 exited with code 0', 30_000, () => textOf(job));
  await sleep(2500);
  check((await count('.turn')) === 1, 'no turn wakes while the user types', await count('.turn'));

  await panel(`(() => { const t = doc.querySelector('textarea'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await waitFor('the woken turn', async () => (await count('.turn')) === 2, 20_000, () => textOf('.transcript'));
  check((await textOf('.turn:last-child .turn-wake')) === 'woke: 1 task finished', 'the head says why it woke', await textOf('.turn:last-child .turn-wake'));
  check((await count('.turn:last-child .request-bubble')) === 0, 'a woken turn shows no message of the user');
  await waitFor('the woken turn to end', async () => (await count('.turn-footer')) === 2, 60_000, () => textOf('.transcript'));
  check(((await textOf('.turn:last-child')) ?? '').includes(ANSWERS.woken), 'the woken turn answered with the build result');
  await waitFor('the pill to clear', async () => (await count('.activity-pill:not([hidden])')) === 0 || !((await textOf('.activity-pill')) ?? '').includes('running'), 10_000, () => textOf('.activity-pill'));
  // The dino's turn-end move plays only while the window has the focus, which a test window may not have; the suite
  // sends the extension's window-focus message itself, as the start suite does.
  await panel(`(doc.defaultView.postMessage({ type: 'window-focus', focused: true }, '*'), 1)`);
  await waitFor('the working dino to leave the stage', async () => (await count('.turn[data-working]')) === 0, 10_000, () => panel(`doc.querySelector('.turn[data-working]')?.dataset.working ?? null`));
  await panel(`(doc.querySelector('.turn:last-child').scrollIntoView({ block: 'start' }), 1)`);
  await screenshots('woken');
  await panelWidth(300);
  await sleep(300);
  const headFits = await fitsIn('.turn:last-child .turn-head');
  check(headFits.fits, 'the woken head fits at 300px', headFits);
  await panel(`(doc.querySelector('.turn:last-child').scrollIntoView({ block: 'start' }), 1)`);
  await screenshots('woken-300');
  await panelWidth(420);

  await openTasks();
  await waitFor('the row to stop waiting', async () => (await count(`${WAKING_ROW} .task-wakes`)) === 0, 10_000, () => textOf('.tasks'));
  await closeTasks();

  // Loaded again, the woken turn keeps its tag.
  await vscode.commands.executeCommand('gcode.chat.new');
  await waitFor('a new chat', async () => (await count('.turn')) === 0);
  await vscode.commands.executeCommand('gcode.chat.tasks');
  await waitFor('the Tasks pane', async () => (await view()) === 'tasks');
  await click('.task-row [data-action="open"]');
  await waitFor('the session to load again', async () => (await count('.turn')) === 2, 20_000, () => textOf('.transcript'));
  check((await textOf('.turn:last-child .turn-wake')) === 'woke: 1 task finished', 'the replayed woken turn keeps its tag', await textOf('.turn:last-child .turn-wake'));
  check((await count('.turn:last-child .request-bubble')) === 0, 'and shows no message of the user');
}
