import * as vscode from 'vscode';
import { check, click, openPanel, panel, panelWidth, press, rowFits, screenshots, shown, sleep, textOf, ui, view, waitFor } from './lanes-ui.js';
import { ANSWER, PROMPT } from './waits-fixture.js';

const waitText = () => textOf('.run-wait .wait-text');
const OFFLINE = /^Offline, retrying in \d+s$/;

export async function run(): Promise<void> {
  await openPanel();
  await panelWidth(420);

  await click('textarea');
  await ui({ do: 'type', text: PROMPT });
  await press('Enter');
  const seen = async () => ({ wait: await waitText(), transcript: await textOf('.transcript') });
  await waitFor('the running row to say the turn is offline', async () => OFFLINE.test((await waitText()) ?? ''), 90_000, seen);
  check(await shown('.run-wait .retry-now'), 'the row offers Retry now');
  check(await shown('.round-button.stop'), 'and Stop');
  check(!(await shown('.run-time')), 'the clock gives the wait its place');
  check(await shown('.run-wait .codicon-debug-disconnect'), 'with the offline icon');
  const failure = await panel<string>(`doc.querySelector('.run-wait').title`);
  check(/ECONNRESET|other side closed|socket/i.test(failure), 'its title holds the failure', failure);
  check(((await textOf('.transcript')) ?? '').includes('Reading a.ts.'), 'the tool call from before the drop stays in the transcript');
  await screenshots('offline');

  const narrow = await panelWidth(300);
  check(Math.abs(narrow - 300) <= 4, 'the panel narrows to about 300px', narrow);
  await sleep(300);
  const fits = await rowFits();
  check(fits.fits, `the running row fits at ${narrow}px while it waits`, fits);
  check(OFFLINE.test((await waitText()) ?? ''), 'the wait keeps its words at 300px', await waitText());
  check((await shown('.run-wait .retry-now')) && (await shown('.round-button.stop')), 'Retry now and Stop both show at 300px');
  await screenshots('offline-300');
  await panelWidth(420);

  await vscode.commands.executeCommand('gcode.chat.tasks');
  await waitFor('the Tasks pane', async () => (await view()) === 'tasks');
  await waitFor('the waiting chat in the list', async () => OFFLINE.test((await textOf('.task-row.current .task-state'))?.trim() ?? ''), 30_000, async () => textOf('.tasks'));
  check((await panel<boolean>(`doc.querySelector('.task-row.current .task-state').classList.contains('tone-wait')`)), 'the task reads as wanting attention');
  await screenshots('offline-tasks');
  await press('Escape');
  await waitFor('the chat again', async () => (await view()) !== 'tasks');

  // The model server answers again; Retry now sends the call without waiting out the probe.
  await ui({ do: 'up' });
  await click('.run-wait .retry-now');
  await waitFor('the answer after the retry', async () => ((await textOf('.transcript')) ?? '').includes(ANSWER), 30_000, seen);
  await waitFor('the turn to end', async () => !(await shown('.round-button.stop')));
  check(!(await shown('.run-wait')), 'the wait is gone from the row');
  await screenshots('resumed');
}
