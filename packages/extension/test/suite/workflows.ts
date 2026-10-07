import * as vscode from 'vscode';
import { ANSWERS, COMMAND } from './workflows-fixture.js';
import { check, click, count, openPanel, panel, panelWidth, press, screenshots, shown, sleep, textOf, ui, view, waitFor } from './lanes-ui.js';

const CARD = '.permission-ask-workflow';
const ROW = '.task-row:has(.task-workflow)';

/** Every shown element under `selector` stays inside its box, and nothing scrolls sideways. */
const fitsIn = (selector: string) =>
  panel<{ fits: boolean; wide: string[] }>(`(() => {
    const box = doc.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    const wide = [...doc.querySelectorAll(${JSON.stringify(`${selector} *`)})].filter((e) => e.getClientRects().length > 0 && e.getBoundingClientRect().right > box.right + 0.5).map((e) => e.className || e.tagName);
    return { fits: wide.length === 0 && doc.scrollingElement.scrollWidth <= doc.scrollingElement.clientWidth, wide };
  })()`);

async function narrow(name: string, selector: string): Promise<void> {
  const width = await panelWidth(300);
  check(Math.abs(width - 300) <= 4, 'the panel narrows to about 300px', width);
  await sleep(300);
  const fits = await fitsIn(selector);
  check(fits.fits, `${selector} fits at ${width}px`, fits);
  await screenshots(name);
  await panelWidth(420);
}

/** The suite's failure, told to the test that launched it, which prints it: the extension host's console goes nowhere. */
export async function run(): Promise<void> {
  try {
    await steps();
  } catch (error) {
    await fetch(`${process.env['GCODE_FAKE_MODEL']!}/fail`, { method: 'POST', body: error instanceof Error ? (error.stack ?? error.message) : String(error) }).catch(() => {});
    throw error;
  }
}

async function steps(): Promise<void> {
  await openPanel();
  await panelWidth(420);
  await click('textarea');
  await ui({ do: 'type', text: COMMAND });
  await press('Enter');
  await waitFor('the workflow card', async () => await shown(`${CARD}.permission-open`), 30_000, () => textOf('.transcript'));
  const names = await panel<string[]>(`[...doc.querySelectorAll('${CARD} .workflow-step-name')].map((e) => e.textContent)`);
  check(names.join() === 'review,fix,verify,verify.pass is true', 'the card lists every step', names);
  const total = (await textOf(`${CARD} .workflow-total`)) ?? '';
  check(/^About \$\d+\.\d+, at most \$0\.25\. The run stops cleanly at its total cap of \$0\.40\.$/.test(total), 'the card says the estimate, the most it can spend and the cap', total);
  await panel(`(doc.querySelector('${CARD}').scrollIntoView({ block: 'start' }), 1)`);
  await screenshots('preview');
  await narrow('preview-300', CARD);

  await ui({ do: 'click', selector: `${CARD} .permission-actions button`, text: 'Run' });
  await waitFor('the card to settle', async () => ((await textOf(`${CARD} .permission-outcome`)) ?? '') === 'Started, in Tasks', 10_000, () => textOf('.transcript'));

  await vscode.commands.executeCommand('gcode.chat.tasks');
  await waitFor('the Tasks pane', async () => (await view()) === 'tasks');
  await panel(`(() => { const fold = doc.querySelector('.tasks-fold[aria-expanded="false"]'); fold?.click(); return 1; })()`);
  await waitFor('the workflow at its fix step', async () => ((await textOf(`${ROW} .task-workflow`)) ?? '').startsWith('Step 2 of 4: fix'), 30_000, () => textOf('.tasks'));
  check(((await textOf(ROW)) ?? '').includes('1 agent running'), 'the fix step runs as a subagent of the workflow', await textOf(ROW));
  check(!(await shown(`${ROW} .lane-cost`)), 'the row shows what the steps spent, not its own turn, which calls no model', await textOf(ROW));
  await screenshots('tasks-running');
  await narrow('tasks-running-300', ROW);

  await waitFor('the workflow to finish', async () => ((await textOf(`${ROW} .task-workflow`)) ?? '').startsWith('Finished 4 steps'), 60_000, () => textOf('.tasks'));
  await screenshots('tasks-done');

  await press('Escape');
  await waitFor('the chat', async () => (await view()) === 'chat');
  await waitFor('the woken turn with the report', async () => ((await textOf('.turn:last-child .rail')) ?? '').includes(ANSWERS['Run the workflow']!), 60_000, () => textOf('.transcript'));
  check((await textOf('.turn:last-child .turn-wake')) === 'woke: 1 task finished', 'the result comes back as a woken turn', await textOf('.turn:last-child .turn-wake'));
  check((await count('.turn')) === 2, 'the /workflow turn, then the woken one', await count('.turn'));
  await panel(`(() => { const t = doc.querySelector('.transcript'); t.scrollTop = t.scrollHeight; return 1; })()`);
  await screenshots('result');
  await narrow('result-300', '.transcript');
}
