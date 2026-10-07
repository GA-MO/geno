import * as vscode from 'vscode';
import { BAD_REQUEST, MARKERS, PROMPTS } from './turn-end-fixture.js';
import { check, click, count, openPanel, panel, press, textOf, toasts, ui, view, waitFor } from './lanes-ui.js';

async function send(prompt: string): Promise<void> {
  await click('textarea');
  await ui({ do: 'type', text: prompt });
  await press('Enter');
}

async function newChat(): Promise<void> {
  await vscode.commands.executeCommand('gcode.chat.new');
  await waitFor('a fresh chat', async () => (await count('.transcript .turn')) === 0);
}

const transcript = async () => (await textOf('.transcript')) ?? '';
const sectionOf = (marker: string) => panel<string | null>(`doc.querySelector('.task-row:has(.task-title[title*="${marker}"])')?.closest('.tasks-section')?.dataset.section ?? null`);
const asked = (marker: string) => ui<number>({ do: 'asked', marker });

export async function run(): Promise<void> {
  await openPanel();

  // A turn the user watches end on a model error shows the provider's message and ends Failed.
  await send(PROMPTS.watched);
  await waitFor('the model error in the transcript', async () => (await transcript()).includes(BAD_REQUEST), 60_000, transcript);
  await waitFor('the turn shown as failed', async () => (await count('.ending-failed')) === 1, 30_000, transcript);

  // One that ends so while the user is in another chat: VS Code says it failed, and Tasks lists it under Needs you.
  await newChat();
  await vscode.commands.executeCommand('notifications.clearAll');
  await send(PROMPTS.away);
  await waitFor('the model call', async () => (await asked(MARKERS.away)) === 1);
  await newChat();
  await ui({ do: 'release' });
  await waitFor('VS Code’s note that the turn failed', async () => (await toasts()).some((t) => t.startsWith(`Geno failed: ${PROMPTS.away}`)), 60_000, toasts);
  check(!(await toasts()).some((t) => t.startsWith('Geno finished')), 'no note says it finished', await toasts());
  await vscode.commands.executeCommand('gcode.chat.tasks');
  await waitFor('the Tasks pane', async () => (await view()) === 'tasks');
  await waitFor('the failed turn under Needs you', async () => (await sectionOf(MARKERS.away)) === 'needs-you', 30_000, () => sectionOf(MARKERS.away));
}
