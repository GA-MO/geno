import { ANSWERS, CHAPTERS, PROMPTS, USER_CHAPTER } from './chapters-fixture.js';
import { check, click, count, focused, openPanel, panel, panelWidth, press, screenshots, shown, sleep, textOf, ui, waitFor } from './lanes-ui.js';

const turn = (n: number) => `.transcript .turn:nth-of-type(${n})`;

type Row = { readonly title: string; readonly current: boolean };

export const tocRows = () =>
  panel<Row[]>(`[...doc.querySelectorAll('.chapter-toc-item')].map((b) => ({ title: b.querySelector('.chapter-toc-title').textContent, current: b.getAttribute('aria-current') === 'true' }))`);
export const currentRow = async () => (await tocRows()).find((row) => row.current)?.title;

/** The chapter dividers the transcript draws, top to bottom. */
export const dividers = () => panel<string[]>(`[...doc.querySelectorAll('.transcript .chapter-divider')].filter((e) => e.getClientRects().length > 0).map((e) => e.textContent)`);

/** Where a divider sits from the transcript's top, the transcript's scroll padding, and its scroll position. */
export const placeOf = (title: string) =>
  panel<{ top: number; padding: number; scrollTop: number }>(`(() => {
    const log = doc.querySelector('.transcript');
    const d = [...log.querySelectorAll('.chapter-divider')].find((e) => e.textContent === ${JSON.stringify(title)});
    return { top: d.getBoundingClientRect().top - log.getBoundingClientRect().top, padding: parseFloat(doc.defaultView.getComputedStyle(log).scrollPaddingTop), scrollTop: log.scrollTop };
  })()`);

/**
 * The text the table of contents' button hides, at every scroll position of the chat, 37px apart: each text that lies
 * under the button and is the topmost thing there but for the button itself. Text the stuck request already hides does
 * not count. The scroll position is put back after.
 */
export const coveredText = () =>
  panel<string[]>(`(() => {
    const log = doc.querySelector('.transcript');
    const was = log.scrollTop;
    const covered = new Set();
    for (let top = 0; top <= log.scrollHeight - log.clientHeight + 37; top += 37) {
      log.scrollTop = top;
      const t = doc.querySelector('.chapter-toc-toggle').getBoundingClientRect();
      const walk = doc.createTreeWalker(log, NodeFilter.SHOW_TEXT);
      for (let node = walk.nextNode(); node; node = walk.nextNode()) {
        if (node.textContent.trim() === '') continue;
        const range = doc.createRange();
        range.selectNodeContents(node);
        for (const r of range.getClientRects()) {
          const left = Math.max(r.left, t.left), right = Math.min(r.right, t.right), top2 = Math.max(r.top, t.top), bottom = Math.min(r.bottom, t.bottom);
          if (right - left < 1 || bottom - top2 < 1) continue;
          const below = doc.elementsFromPoint((left + right) / 2, (top2 + bottom) / 2).find((e) => !e.closest('.chapter-toc'));
          if (below && below.contains(node.parentElement)) covered.add(node.textContent.trim().slice(0, 40));
        }
      }
    }
    log.scrollTop = was;
    return [...covered];
  })()`);

export async function openToc(): Promise<void> {
  if (!(await shown('.chapter-toc-list'))) await click('.chapter-toc-toggle');
  await waitFor('the chapter list to open', () => shown('.chapter-toc-list'));
}

/** Chooses a row of the table of contents, and waits for the scroll to settle. */
export async function jump(title: string): Promise<void> {
  await openToc();
  await ui({ do: 'click', selector: '.chapter-toc-title', text: title });
  await sleep(300);
}

const scrollTo = (expression: string) =>
  panel(`(() => { const log = doc.querySelector('.transcript'); log.scrollTop = ${expression}; log.dispatchEvent(new doc.defaultView.Event('scroll')); return 1; })()`);

async function send(text: string): Promise<void> {
  await click('textarea');
  await ui({ do: 'type', text });
  await press('Enter');
}

async function nothingCovered(where: string): Promise<void> {
  const covered = await coveredText();
  check(covered.length === 0, `the button covers no text ${where}, at any scroll position`, covered);
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
  // Wide enough that the open list leaves most of the chat clear, so it stays open after a choice.
  await panelWidth(600);
  await send(PROMPTS.look);
  await waitFor('the first turn to finish', async () => (await count('.transcript .turn-footer')) === 1);
  check(!(await shown('.chapter-toc-slot')) && (await panel<boolean>(`'chapters' in doc.body.dataset`)) === false, 'a chat without chapters shows no table of contents');
  await send(PROMPTS.fix);
  await waitFor('the second turn to finish', async () => (await count('.transcript .turn-footer')) === 2);
  await send(PROMPTS.verify);
  await waitFor('the third turn to finish', async () => (await count('.transcript .turn-footer')) === 3);
  await send(PROMPTS.notes);
  await waitFor('the fourth turn to finish', async () => (await count('.transcript .turn-footer')) === 4);
  check((await textOf(turn(4)))!.includes(ANSWERS.notes.split('\n')[0]!), 'the fourth turn answers', await textOf(turn(4)));

  check(JSON.stringify(await dividers()) === JSON.stringify([CHAPTERS.fix.title, CHAPTERS.verify.title]), "the agent's two chapters are dividers", await dividers());
  check((await count('.transcript .calls[data-step="mark_chapter"]')) === 0, 'no mark_chapter call shows as a call');
  check((await panel<string | null>(`doc.querySelector('.chapter-divider').getAttribute('title')`)) === CHAPTERS.fix.summary, "the divider's tooltip is the summary");
  check(await shown('.chapter-toc-toggle'), 'the table of contents shows');
  check(!(await shown('.chapter-toc-list')), 'folded at first');
  await openToc();
  check(JSON.stringify((await tocRows()).map((row) => row.title)) === JSON.stringify(['Start', CHAPTERS.fix.title, CHAPTERS.verify.title]), 'it lists the start and both chapters', await tocRows());
  check((await currentRow()) === CHAPTERS.verify.title, 'at the end of the chat the last chapter is current', await tocRows());

  await jump(CHAPTERS.fix.title);
  const fix = await placeOf(CHAPTERS.fix.title);
  check(fix.scrollTop > 0 && Math.abs(fix.top - fix.padding) <= 3, "the jump puts the chapter's divider just below the stuck request", fix);
  check((await currentRow()) === CHAPTERS.fix.title, 'and makes it current', await tocRows());
  check(await shown('.chapter-toc-list'), 'the list stays open on a wide panel, so the current row follows the reading');
  await nothingCovered('on a wide panel');
  await screenshots('toc-open');

  await jump('Start');
  check((await panel<number>(`doc.querySelector('.transcript').scrollTop`)) === 0, 'Start goes to the top');
  check((await currentRow()) === 'Start', 'above the first chapter, the start is current', await tocRows());

  const verify = await placeOf(CHAPTERS.verify.title);
  await scrollTo(`${verify.scrollTop + verify.top - verify.padding + 40}`);
  await waitFor('the current row to follow the scroll', async () => (await currentRow()) === CHAPTERS.verify.title, 5000, tocRows);
  await scrollTo(`${verify.scrollTop + verify.top - verify.padding - 120}`);
  await waitFor('the current row to go back', async () => (await currentRow()) === CHAPTERS.fix.title, 5000, tocRows);
  await click('.chapter-toc-toggle');
  await waitFor('the list to fold', async () => !(await shown('.chapter-toc-list')));
  await screenshots('divider');

  await click(`${turn(4)} .rewind-button`);
  await waitFor('the message menu', () => shown(`${turn(4)} .rewind-menu`));
  check((await count(`${turn(4)} .rewind-menu [data-action="chapter-remove"]`)) === 0, 'a message with no chapter offers no removal');
  await click(`${turn(4)} .rewind-menu [data-action="chapter-mark"]`);
  await waitFor('the title field', () => shown(`${turn(4)} .chapter-input`));
  check((await panel<string>(`doc.querySelector(${JSON.stringify(`${turn(4)} .chapter-input`)}).value`)) === PROMPTS.notes, "the field starts with the message's words", await panel(`doc.querySelector(${JSON.stringify(`${turn(4)} .chapter-input`)}).value`));
  check((await focused())?.startsWith('chapter-title:') === true, 'and takes the keyboard', await focused());
  await screenshots('marking');
  await press('selectAll');
  await ui({ do: 'type', text: USER_CHAPTER });
  await press('Enter');
  await waitFor("the user's chapter above the fourth message", async () => (await textOf(`${turn(4)} > .chapter-slot .chapter-divider`)) === USER_CHAPTER);
  check(!(await shown(`${turn(4)} .chapter-input`)), 'the field closes');
  await openToc();
  check(JSON.stringify((await tocRows()).map((row) => row.title)) === JSON.stringify(['Start', CHAPTERS.fix.title, CHAPTERS.verify.title, USER_CHAPTER]), 'the list gains it, in order', await tocRows());
  await jump(CHAPTERS.fix.title);
  await jump(USER_CHAPTER);
  const mine = await placeOf(USER_CHAPTER);
  const button = await panel<number>(`doc.querySelector('.chapter-toc-toggle').getBoundingClientRect().bottom - doc.querySelector('.transcript').getBoundingClientRect().top`);
  check(mine.top > button && mine.top <= button + 12, "the user's chapter opens its turn at the top, just below the button", { ...mine, button });
  check((await currentRow()) === USER_CHAPTER, 'and is current', await tocRows());
  await click('.chapter-toc-toggle');
  await waitFor('the list to fold', async () => !(await shown('.chapter-toc-list')));
  await screenshots('user-chapter');

  const width = await panelWidth(300);
  check(Math.abs(width - 300) <= 4, 'the panel narrows to about 300px', width);
  await sleep(300);
  await jump(CHAPTERS.fix.title);
  check(!(await shown('.chapter-toc-list')), 'on a narrow panel a choice folds the list, so it covers nothing');
  const narrow = await placeOf(CHAPTERS.fix.title);
  check(Math.abs(narrow.top - narrow.padding) <= 3, 'and still jumps', narrow);
  await nothingCovered('at 300px');
  const fits = await panel<{ overflow: number; outside: string[] }>(`(() => {
    const log = doc.querySelector('.transcript');
    const box = doc.body.getBoundingClientRect();
    const parts = [...doc.querySelectorAll('.chapter-toc, .chapter-toc *, .chapter-divider, .chapter-divider *')].filter((e) => e.getClientRects().length > 0);
    return { overflow: log.scrollWidth - log.clientWidth, outside: parts.filter((e) => { const r = e.getBoundingClientRect(); return r.right > box.right + 0.5 || r.left < box.left - 0.5; }).map((e) => e.className || e.tagName) };
  })()`);
  check(fits.overflow <= 0 && fits.outside.length === 0, 'the dividers and the button fit at 300px', fits);
  await screenshots('narrow-300-divider');
  await openToc();
  const listFits = await panel<{ left: number; right: number; width: number }>(`(() => { const r = doc.querySelector('.chapter-toc-list').getBoundingClientRect(); return { left: r.left, right: r.right, width: doc.body.getBoundingClientRect().width }; })()`);
  check(listFits.left >= 0 && listFits.right <= listFits.width + 0.5, 'the open list fits the panel at 300px', listFits);
  await screenshots('narrow-300-toc');
  await press('Escape');
  await waitFor('Escape to fold the list', async () => !(await shown('.chapter-toc-list')));
  check((await focused()) === 'chapter-toc', 'onto its button', await focused());
  await panelWidth(600);
}
