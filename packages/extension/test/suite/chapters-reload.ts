import { CHAPTERS, USER_CHAPTER } from './chapters-fixture.js';
import { currentRow, dividers, jump, openToc, placeOf, tocRows } from './chapters.js';
import { check, click, count, openPanel, panelWidth, press, screenshots, shown, waitFor } from './lanes-ui.js';

/** After a window reload: every chapter is back as a divider and in the list, and the list still jumps. */
export async function run(): Promise<void> {
  try {
    await openPanel();
    await panelWidth(600);
    await waitFor('the chat to load again', async () => (await count('.transcript .turn-footer')) === 4);
    check(JSON.stringify(await dividers()) === JSON.stringify([CHAPTERS.fix.title, CHAPTERS.verify.title, USER_CHAPTER]), "the agent's chapters and the user's are dividers again", await dividers());
    await openToc();
    check(JSON.stringify((await tocRows()).map((row) => row.title)) === JSON.stringify(['Start', CHAPTERS.fix.title, CHAPTERS.verify.title, USER_CHAPTER]), 'the list is as it was', await tocRows());
    await jump(CHAPTERS.verify.title);
    const verify = await placeOf(CHAPTERS.verify.title);
    check(Math.abs(verify.top - verify.padding) <= 3, 'and jumps', verify);
    check((await currentRow()) === CHAPTERS.verify.title, 'to the current chapter', await tocRows());
    await screenshots('reloaded');
    await click('.chapter-toc-toggle');
    const turn = '.transcript .turn:nth-of-type(4)';
    await click(`${turn} .rewind-button`);
    await waitFor('the message menu', () => shown(`${turn} .rewind-menu`));
    check((await count(`${turn} .rewind-menu [data-action="chapter-remove"]`)) === 1, 'the marked message offers to remove its chapter');
    await press('Escape');
  } catch (error) {
    await fetch(`${process.env['GCODE_FAKE_MODEL']!}/fail`, { method: 'POST', body: error instanceof Error ? (error.stack ?? error.message) : String(error) }).catch(() => {});
    throw error;
  }
}
