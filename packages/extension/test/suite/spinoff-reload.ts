import { ANSWERS, IDS, LANE, MARKERS, SUGGESTIONS } from './spinoff-fixture.js';
import { check, click, count, openPanel, panelWidth, screenshots, textOf, waitFor } from './lanes-ui.js';

/** After a window reload: the started card stays started, the dismissed one stays gone, and Open shows the task. */
export async function run(): Promise<void> {
  try {
    await openPanel();
    await panelWidth(420);
    await waitFor('the chat to load again', async () => (await count('.transcript .turn-footer')) === 1);
    check((await count(`.transcript .spinoff[data-spinoff="${IDS.helper}"][data-state="started"]`)) === 1, 'the started card is still started');
    check((await textOf(`.spinoff[data-spinoff="${IDS.helper}"] .spinoff-lane`)) === LANE, 'in its lane', await textOf(`.spinoff[data-spinoff="${IDS.helper}"] .spinoff-lane`));
    check((await count(`.transcript .spinoff[data-spinoff="${IDS.test}"]`)) === 0, 'the dismissed card stays gone');
    await screenshots('reloaded');
    await click(`.spinoff[data-spinoff="${IDS.helper}"] button[data-action="open"]`);
    await waitFor('the task to open', async () => (await textOf('.transcript .turn:first-of-type'))?.includes(MARKERS.task) === true);
    check((await textOf('.transcript .turn:first-of-type'))!.includes(SUGGESTIONS.helper.prompt), "its first message is the suggestion's prompt", await textOf('.transcript .turn:first-of-type'));
    check((await textOf('.transcript .turn:first-of-type'))!.includes(ANSWERS.task), 'with its answer', await textOf('.transcript .turn:first-of-type'));
  } catch (error) {
    await fetch(`${process.env['GCODE_FAKE_MODEL']!}/fail`, { method: 'POST', body: error instanceof Error ? (error.stack ?? error.message) : String(error) }).catch(() => {});
    throw error;
  }
}
