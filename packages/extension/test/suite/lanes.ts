import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { ANSWERS, LANE, PROMPTS } from './lanes-fixture.js';
import { check, click, count, focused, openPanel, panel, panelWidth, press, rowFits, screenshots, shown, sleep, textOf, toasts, ui, view, waitFor } from './lanes-ui.js';

const workspace = () => vscode.workspace.workspaceFolders![0]!.uri.fsPath;
const disk = (file: string) => readFile(path.join(workspace(), file), 'utf8');
const lane = (inner = '') => `.lane-row[data-lane="${LANE}"] ${inner}`.trim();

export async function run(): Promise<void> {
  await openPanel();
  await panelWidth(420);

  // The send menu offers the draft to a new lane.
  await click('textarea');
  await ui({ do: 'type', text: PROMPTS.lane });
  await click('.send-more');
  await waitFor('the send menu', async () => await shown('#send-menu'));
  const offered = await panel<string[]>(`[...doc.querySelectorAll('#send-menu [role="menuitem"]')].map((e) => e.textContent)`);
  check(offered.join('|') === 'SendEnter|Run in a new lanebackground', 'the menu offers Send and Run in a new lane', offered);
  check((await panel<string | null>('doc.activeElement?.dataset.action ?? null')) === 'send', 'the first item takes the keyboard');
  await press('ArrowDown');
  check((await panel<string | null>('doc.activeElement?.dataset.action ?? null')) === 'lane', 'the arrows move to the lane item');
  await screenshots('send-menu');
  await press('Escape');
  check(!(await shown('#send-menu')) && (await panel<boolean>(`doc.activeElement === doc.querySelector('.send-more')`)), 'Escape closes the menu onto its chevron');

  // At about 300px the composer's row keeps the chevron with the rest.
  const narrow = await panelWidth(300);
  check(Math.abs(narrow - 300) <= 4, 'the panel narrows to about 300px', narrow);
  await sleep(300);
  const fits = await rowFits();
  check(fits.fits, `the bottom row fits at ${narrow}px with the send menu's chevron`, fits);
  check(await shown('.send-more') && (await shown('button.send')), 'the chevron and Send both show');
  await click('.send-more');
  await waitFor('the send menu at 300px', async () => await shown('#send-menu'));
  const menuFits = await panel<boolean>(`(() => { const m = doc.querySelector('#send-menu').getBoundingClientRect(); return m.left >= 0 && m.right <= doc.documentElement.clientWidth; })()`);
  check(menuFits, 'the send menu stays inside the narrow panel');
  await screenshots('narrow-300');

  await click('#send-menu [data-action="lane"]');
  await waitFor('the Lanes pane', async () => (await view()) === 'lanes');
  check((await panel<string>('doc.querySelector("textarea").value')) === '', 'the draft went to the lane');
  const seen = async () => ({ pane: await textOf('.lanes:not([hidden])'), toasts: await toasts() });
  await waitFor('the new lane, running', async () => (await textOf(lane('.lane-state')))?.trim() === 'Running', 90_000, seen);
  check((await textOf(lane('.lane-task'))) === PROMPTS.lane, 'the row names the task', await textOf(lane('.lane-task')));
  check(await panel<boolean>(`doc.querySelector('${lane('[data-action="apply"]')}').disabled`), 'a running lane cannot be applied');
  check(await panel<boolean>(`doc.querySelector('${lane('[data-action="discard"]')}').disabled`), 'nor discarded');
  await screenshots('lanes-running');
  await panelWidth(420);

  await ui({ do: 'release', name: 'lane' });
  await waitFor('the lane to finish', async () => (await textOf(lane('.lane-state')))?.trim() === 'Done');
  check((await textOf(lane('.lane-diff'))) === '+1 −1 · 1 file', 'the row gives the diff stat', await textOf(lane('.lane-diff')));
  check((await textOf(lane('.lane-check')))?.trim() === 'Check passed', 'the check result', await textOf(lane('.lane-check')));
  check(/^\$\d/.test((await textOf(lane('.lane-cost'))) ?? ''), 'and the cost', await textOf(lane('.lane-cost')));
  await waitFor('a notification that the lane finished', async () => (await toasts()).some((t) => t.startsWith(`Geno finished: ${PROMPTS.lane}`) && t.includes(`(lane ${LANE})`)));
  check((await disk('a.ts')).includes('export const two = 2;'), 'the lane left the main checkout alone');
  await screenshots('lanes-done', true);
  await vscode.commands.executeCommand('notifications.clearAll');

  // Apply goes through the review flow: an edit step with its hunk, which the user keeps or undoes.
  await click(lane('[data-action="apply"]'));
  await waitFor('the chat again', async () => (await view()) === 'chat');
  await waitFor('the apply turn with its hunk', async () => (await count('.transcript .hunk[data-hunk] .hunk-actions')) === 1);
  check((await textOf('.turn:last-of-type .request'))?.includes(`Apply lane ${LANE}`) ?? false, 'the apply shows as its own turn', await textOf('.turn:last-of-type .request'));
  await waitFor('a.ts to take the lane change', async () => (await disk('a.ts')).includes('export const TWO = 2;'));
  check((await textOf('.transcript'))!.includes(`Applied 1 file from lane ${LANE}.`), 'the turn says what it applied', await textOf('.transcript'));
  await screenshots('applied');
  await click('.transcript .hunk[data-hunk] [data-focus^="keep:"]');
  await waitFor('the hunk to be kept', async () => (await count('.transcript .hunk .decision-kept')) === 1);

  // Discard asks first for a lane with changes.
  await vscode.commands.executeCommand('gcode.chat.lanes');
  await waitFor('the Lanes pane', async () => (await view()) === 'lanes');
  await waitFor('the applied lane, still there', async () => (await count(lane())) === 1);
  await click(lane('[data-action="discard"]'));
  await waitFor('the discard confirm', async () => (await count(lane('.lane-confirm'))) === 1);
  check((await focused()) === `lane-discard-no:${LANE}`, 'Cancel takes the keyboard', await focused());
  await screenshots('discard-confirm');
  await click(lane('.lane-confirm .button.secondary'));
  await waitFor('the confirm to go', async () => (await count(lane('.lane-confirm'))) === 0);
  check((await count(lane())) === 1, 'Cancel keeps the lane');
  await click(lane('[data-action="discard"]'));
  await waitFor('the confirm again', async () => (await count(lane('.lane-confirm'))) === 1);
  await click(lane('.lane-confirm .button.danger'));
  await waitFor('the lane to go', async () => (await count('.lane-row')) === 0);
  check((await textOf('.lanes-note'))?.startsWith('A lane is a copy') ?? false, 'an empty pane says what a lane is', await textOf('.lanes-note'));
  await press('Escape');
  await waitFor('the chat', async () => (await view()) === 'chat');

  // A chat turn that is still running when the window goes away; the next window picks it up.
  await click('textarea');
  await ui({ do: 'type', text: PROMPTS.slow });
  await press('Enter');
  await waitFor('the read step of the slow turn', async () => (await count('.transcript .calls[data-step="read"]')) >= 1);
  check(await shown('button.stop'), 'the turn runs');
  await vscode.commands.executeCommand('gcode.chat.tasks');
  await waitFor('the Tasks pane', async () => (await view()) === 'tasks');
  await waitFor('the running chat in the list', async () => (await count('.task-row.current .task-state.tone-busy')) === 1);
  check((await count('.task-row')) === 2, 'the list has the chat and the lane task', await count('.task-row'));
  check((await textOf('.task-row:not(.current) .task-state'))?.trim() === 'Done', 'the lane task is done', await textOf('.task-row:not(.current) .task-state'));
  await screenshots('tasks');
  await press('Escape');
  check(!(await textOf('.transcript'))!.includes(ANSWERS.slow), 'the slow turn has not answered yet');
}
