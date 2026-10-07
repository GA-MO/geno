import { ANSWER, PROMPT, URL_ENV } from './preview-fixture.js';
import { check, click, count, openPanel, panel, panelWidth, press, screenshots, shown, sleep, textOf, ui, view, waitFor } from './lanes-ui.js';
import * as vscode from 'vscode';

const STEP = '[data-tool="tu_preview_start"]';
const JOB = `${STEP} .command-job[data-job="bg-1"]`;
const TASK_JOB = '.task-row.current .task-job[data-job="bg-1"]';
const CARD = '.permission-open';

/** Whether anything inside `selector` runs past its edges. */
const fitsIn = (selector: string) =>
  panel<{ fits: boolean; outside: string[] }>(
    `(() => { const c = doc.querySelector('${selector}').getBoundingClientRect(); const outside = [...doc.querySelectorAll('${selector} *')].filter((e) => e.getClientRects().length > 0 && (e.getBoundingClientRect().right > c.right + 0.5 || e.getBoundingClientRect().left < c.left - 0.5)).map((e) => e.className || e.tagName); return { fits: outside.length === 0, outside }; })()`,
  );

const answers = async (url: string): Promise<boolean> => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
};

export async function run(): Promise<void> {
  const url = process.env[URL_ENV]!;
  await openPanel();
  await panelWidth(420);

  await click('textarea');
  await ui({ do: 'type', text: PROMPT });
  await press('Enter');

  // Ask mode asks before each read-only browser tool: the screenshot, then the console.
  for (const tool of ['take_screenshot', 'list_console_messages']) {
    await waitFor(`the card for ${tool}`, async () => (await count(CARD)) === 1 && ((await textOf(CARD)) ?? '').includes(tool), 90_000, () => textOf('.transcript'));
    await click(`${CARD} button[data-focus$=":allow"]`);
    await waitFor(`the ${tool} card to settle`, async () => (await count(CARD)) === 0);
  }
  await waitFor('the turn to finish', async () => (await count('.turn-footer')) === 1, 90_000, () => textOf('.transcript'));
  check(((await textOf('.transcript')) ?? '').includes(ANSWER), 'the model answered');

  check((await textOf(`${STEP} .command-title`)) === 'Dev server web', 'the step names the dev server', await textOf(`${STEP} .command-title`));
  check((await textOf(`${STEP} .command-in`)) === 'node server.mjs', 'its box shows the command it runs', await textOf(`${STEP} .command-in`));
  await waitFor('the step to show the server serving', async () => (await textOf(`${JOB}.job-running .job-line`)) === `Serving ${url} as bg-1`, 30_000, () => textOf(JOB));
  check(await shown(`${JOB} .job-stop`), 'a running dev server offers Stop on its step');
  await waitFor('the live tail to show the request', async () => ((await textOf(`${STEP} .command-output`)) ?? '').includes('GET /'), 30_000, () => textOf(`${STEP} .command-output`));
  await waitFor('the screenshot thumbnail to load', () =>
    panel<boolean>(`(() => { const img = doc.querySelector('.calls[data-step="mcp__browser__take_screenshot"] .step-images .thumb img'); return img !== null && img.complete && img.naturalWidth > 0; })()`),
  );
  check(await answers(url), 'the page answers while the server runs');

  const narrow = await panelWidth(300);
  check(Math.abs(narrow - 300) <= 4, 'the panel narrows to about 300px', narrow);
  await sleep(300);
  const stepFits = await fitsIn(STEP);
  check(stepFits.fits, 'the dev server step fits at 300px', stepFits);
  await panel(`(doc.querySelector('${STEP}').scrollIntoView({ block: 'start' }), 1)`);
  await screenshots('preview-300');

  await vscode.commands.executeCommand('gcode.chat.tasks');
  await waitFor('the Tasks pane', async () => (await view()) === 'tasks');
  const host = new URL(url).host;
  await waitFor('the dev server under its session', async () => (await textOf(`${TASK_JOB} .task-job-label`)) === `web on ${host}`, 30_000, () => textOf('.tasks'));
  await panel(`(doc.querySelector('${TASK_JOB}').scrollIntoView({ block: 'center' }), 1)`);
  const rowFits = await fitsIn(TASK_JOB);
  check(rowFits.fits, 'the dev server row and its Stop fit at 300px', rowFits);
  await screenshots('tasks-preview-300');

  await click(`${TASK_JOB} .task-job-stop`);
  await waitFor('the row to leave once the server stopped', async () => (await count(TASK_JOB)) === 0, 30_000, () => textOf('.tasks'));
  await press('Escape');
  await waitFor('the chat again', async () => (await view()) !== 'tasks');
  await waitFor('the step to say the user stopped it', async () => (await textOf(`${JOB}.job-stopped .job-line`)) === 'bg-1 was stopped by the user', 30_000, () => textOf(JOB));
  check(!(await shown(`${JOB} .job-stop`)), 'a stopped server offers no Stop');
  check(!(await answers(url)), 'nothing answers once it stopped');
  await panel(`(doc.querySelector('${STEP}').scrollIntoView({ block: 'start' }), 1)`);
  await screenshots('preview-stopped-300');
  await panelWidth(420);
}
