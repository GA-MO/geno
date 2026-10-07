import * as vscode from 'vscode';
import { ANSWERS, PROMPTS } from './background-fixture.js';
import { check, click, count, openPanel, panel, panelWidth, press, screenshots, shown, textOf, ui, view, waitFor } from './lanes-ui.js';

const job = (id: string) => `.command-job[data-job="${id}"]`;
const outputOf = (toolId: string) => textOf(`[data-tool="${toolId}"] .command-output`);

/** Whether the job row keeps its text and its Stop button inside the step at this width. */
const jobRowFits = (id: string) =>
  panel<{ fits: boolean; width: number }>(`(() => {
    const row = doc.querySelector('${job(id)}');
    const box = row.closest('.command-step').getBoundingClientRect();
    const inside = [...row.querySelectorAll('*')].every((e) => { const r = e.getBoundingClientRect(); return r.right <= box.right + 0.5 && r.left >= box.left - 0.5; });
    return { fits: inside && row.scrollWidth <= row.clientWidth, width: doc.body.clientWidth };
  })()`);

async function send(prompt: string): Promise<void> {
  await click('textarea');
  await ui({ do: 'type', text: prompt });
  await press('Enter');
}

export async function run(): Promise<void> {
  await openPanel();
  await panelWidth(420);

  await send(PROMPTS.start);
  await waitFor('the turn to finish', async () => (await count('.turn-footer')) === 1, 90_000, () => textOf('.transcript'));
  check(((await textOf('.transcript')) ?? '').includes(ANSWERS.start), 'the model answered after the build ended');

  await waitFor('the server step to run in the background', async () => (await textOf(`${job('bg-1')}.job-running .job-line`)) === 'Running in background as bg-1');
  check(await shown(`${job('bg-1')} .job-stop`), 'a running background command offers Stop');
  await waitFor('the live tail to reach the ready line', async () => ((await outputOf('tu_bg_server')) ?? '').includes('ready on http://localhost:5173'), 30_000, () => outputOf('tu_bg_server'));
  check(!((await outputOf('tu_bg_server')) ?? '').includes('Started background command'), 'the box shows the output, not the start line');
  check((await textOf(`${job('bg-2')}.job-ended .job-line`)) === 'bg-2 exited with code 0', 'the build step says how it ended', await textOf(`${job('bg-2')} .job-line`));
  check((await outputOf('tu_bg_build')) === 'built in 1.0s', 'with the end of its output', await outputOf('tu_bg_build'));
  check(!(await shown(`${job('bg-2')} .job-stop`)), 'an ended command offers no Stop');

  await vscode.commands.executeCommand('gcode.chat.tasks');
  await waitFor('the Tasks pane', async () => (await view()) === 'tasks');
  await waitFor('the running job under its session', async () => (await textOf('.task-row.current .task-job[data-job="bg-1"]')) === 'bg-1Start the dev serverStop');
  check((await count('.task-job')) === 1, 'only the running command is listed', await count('.task-job'));
  await screenshots('tasks-job');
  await press('Escape');
  await waitFor('the chat again', async () => (await view()) !== 'tasks');

  const narrow = await panelWidth(300);
  check(Math.abs(narrow - 300) <= 4, 'the panel narrows to about 300px', narrow);
  const fits = await jobRowFits('bg-1');
  check(fits.fits, `the job row and its Stop fit at ${narrow}px`, fits);
  await panel(`(doc.querySelector('[data-tool="tu_bg_server"]').scrollIntoView({ block: 'start' }), 1)`);
  await screenshots('background-300');

  await click(`${job('bg-1')} .job-stop`);
  await waitFor('the server to stop', async () => (await textOf(`${job('bg-1')}.job-stopped .job-line`)) === 'bg-1 was stopped by the user', 30_000, () => textOf(job('bg-1')));
  check(!(await shown(`${job('bg-1')} .job-stop`)), 'a stopped command offers no Stop');
  await panel(`(doc.querySelector('[data-tool="tu_bg_server"]').scrollIntoView({ block: 'start' }), 1)`);
  await screenshots('background-stopped-300');
  await panelWidth(420);

  await send(PROMPTS.after);
  await waitFor('the second turn to finish', async () => (await count('.turn-footer')) === 2, 90_000, () => textOf('.transcript'));
  check(((await textOf('.transcript')) ?? '').includes(ANSWERS.after), 'the model answered the next prompt');
}
