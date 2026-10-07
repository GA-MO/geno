import * as vscode from 'vscode';
import { ANSWER, COMMAND, PROMPT } from './schedules-fixture.js';
import { check, click, count, openPanel, panel, panelWidth, press, screenshots, shown, sleep, textOf, ui, view, waitFor } from './lanes-ui.js';

type Row = { readonly title: string; readonly state: string; readonly when: string; readonly next: string; readonly how: string; readonly last: string | null; readonly open: boolean; readonly buttons: readonly string[] };

const ROW = '.schedule-row';

/** The Scheduled section's first row, as the user reads it. */
const row = () =>
  panel<Row | null>(`(() => {
    const e = doc.querySelector(${JSON.stringify(ROW)});
    if (e === null) return null;
    const text = (s) => e.querySelector(s)?.textContent ?? null;
    return {
      title: text('.schedule-title'),
      state: text('.schedule-state'),
      when: text('.schedule-when'),
      next: text('.schedule-next'),
      how: text('.schedule-how'),
      last: text('.schedule-last-text'),
      open: e.querySelector('.schedule-open') !== null,
      buttons: [...e.querySelectorAll('.lane-actions button')].map((b) => b.textContent),
    };
  })()`);

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
}

async function narrow(name: string): Promise<void> {
  const width = await panelWidth(300);
  check(Math.abs(width - 300) <= 4, 'the panel narrows to about 300px', width);
  await sleep(300);
  const fits = await fitsIn('.tasks');
  check(fits.fits, `the Scheduled row fits at ${width}px`, fits);
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
  await waitFor('the engine to answer /schedule', async () => (await count('.transcript .turn-footer')) === 1, 30_000, () => textOf('.transcript'));
  const reply = (await textOf('.turn:last-of-type .rail')) ?? '';
  check(/Scheduled sch_[0-9a-f]{6} "/.test(reply) && reply.includes('Weekdays at 09:00'), 'the engine answers /schedule itself, with the task', reply);

  await openTasks();
  await waitFor('the Scheduled row', async () => await shown(ROW), 10_000, () => textOf('.tasks'));
  const made = (await row())!;
  check(made.title === PROMPT, 'the row is named after the prompt', made);
  check(made.state === 'Scheduled' && made.when === 'Weekdays at 09:00' && made.next.startsWith('Next '), 'it says when it runs next', made);
  check(made.how === 'Read-only · up to $0.05 and 20 model calls a run', 'it runs read-only, within the default budget', made);
  check(made.last === null && made.buttons.join() === 'Run now,Pause,Delete', 'no run yet, and Run now, Pause and Delete', made);
  check((await textOf('[data-section="scheduled"] .tasks-heading')) === 'Scheduled1', 'the section counts it', await textOf('[data-section="scheduled"] .tasks-heading'));
  await screenshots('scheduled');
  await narrow('scheduled-300');

  await click(`${ROW} [data-action="run"]`);
  await waitFor('Run now to end', async () => ((await row())?.last ?? '').includes(': Done'), 60_000, () => row());
  const ran = (await row())!;
  check(/^Last run .* \(Run now\): Done · \$\d+\.\d+$/.test(ran.last ?? ''), 'the row shows the run and what it cost', ran);
  check(ran.open && ran.next === made.next, 'with Open, and the schedule as it was', ran);
  await waitFor('the run in the task list', async () => ((await textOf('.task-row .task-title')) ?? '') === PROMPT, 10_000, () => textOf('.tasks'));
  await screenshots('ran');
  await narrow('ran-300');

  await click(`${ROW} [data-action="pause"]`);
  await waitFor('the pause', async () => (await row())?.state === 'Paused');
  check((await row())?.next === 'Paused' && (await shown(`${ROW} [data-action="resume"]`)), 'a paused task offers Resume', await row());
  await click(`${ROW} [data-action="resume"]`);
  await waitFor('the resume', async () => (await row())?.state === 'Scheduled');

  await click(`${ROW} [data-action="delete"]`);
  await waitFor('the delete confirm', async () => await shown(`${ROW} .lane-confirm`));
  await screenshots('delete-confirm');
  await click(`${ROW} [data-focus^="schedule-delete-no:"]`);
  await waitFor('the confirm to close', async () => !(await shown(`${ROW} .lane-confirm`)));

  await click(`${ROW} .schedule-open`);
  await waitFor('the run to show in the chat', async () => (await view()) === 'chat' && ((await textOf('.transcript')) ?? '').includes(ANSWER), 20_000, () => textOf('.transcript'));
  check(((await textOf('.transcript')) ?? '').includes(PROMPT), 'the run opens with its prompt and answer', await textOf('.transcript'));
  await screenshots('run-session');

  await openTasks();
  await click(`${ROW} [data-action="delete"]`);
  await click(`${ROW} [data-focus^="schedule-delete-yes:"]`);
  await waitFor('the row to go', async () => (await count(ROW)) === 0, 10_000, () => textOf('.tasks'));
  check(!(await shown('[data-section="scheduled"]')), 'the section hides with nothing scheduled');
}
