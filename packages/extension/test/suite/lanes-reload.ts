import * as vscode from 'vscode';
import { ANSWERS, PROMPTS } from './lanes-fixture.js';
import { check, count, openPanel, panelWidth, press, screenshots, shown, textOf, toasts, ui, view, waitFor } from './lanes-ui.js';

/** After a window reload: the turn the last window left running is still running here, and ends here. */
export async function run(): Promise<void> {
  await openPanel();
  await panelWidth(420);
  const seen = async () => ({ turns: await count('.transcript .turn'), last: await textOf('.turn:last-of-type'), stop: await shown('button.stop'), toasts: await toasts() });
  await waitFor('the slow turn, still running', async () => (await shown('button.stop')) && (await count('.transcript .turn')) >= 2, 90_000, seen);
  check((await textOf('.turn:last-of-type .request'))?.includes(PROMPTS.slow) ?? false, 'the running turn is the slow one', await textOf('.turn:last-of-type .request'));
  check((await count('.turn:last-of-type .calls[data-step="read"]')) === 1, 'with the read it made before the reload');
  check((await count('.turn:last-of-type .turn-footer')) === 0, 'and no end yet');
  await vscode.commands.executeCommand('gcode.chat.tasks');
  await waitFor('the Tasks pane', async () => (await view()) === 'tasks');
  await waitFor('the chat still running in the list', async () => (await count('.task-row.current .task-state.tone-busy')) === 1);
  await press('Escape');
  await waitFor('the chat', async () => (await view()) === 'chat');
  await screenshots('reloaded-running');

  await ui({ do: 'release', name: 'slow' });
  await waitFor('the slow turn to end here', async () => (await count('.turn:last-of-type .turn-footer')) === 1);
  check((await textOf('.turn:last-of-type'))!.includes(ANSWERS.slow), 'with the answer the engine got after the reload', await textOf('.turn:last-of-type'));
  check(!(await shown('button.stop')) && (await shown('button.send')), 'the composer is idle again');
  check(!(await textOf('.turn:last-of-type'))!.includes('failed'), 'the turn did not fail', await textOf('.turn:last-of-type'));
  await vscode.commands.executeCommand('gcode.chat.tasks');
  await waitFor('the chat done in the list', async () => (await textOf('.task-row.current .task-state'))?.trim() === 'Done');
  await press('Escape');
}
