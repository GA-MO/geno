import * as vscode from 'vscode';
import { ANSWERS, IDS, LANE, PROMPT, SUGGESTIONS } from './spinoff-fixture.js';
import { check, click, count, openPanel, panel, panelWidth, press, screenshots, shown, textOf, ui, view, waitFor } from './lanes-ui.js';

type Card = { readonly state: string; readonly title: string; readonly tldr: string | null; readonly buttons: readonly string[]; readonly lane: string | null; readonly fits: boolean };

/** Every card in the transcript, or in the Tasks pane, as the user sees it. */
const cards = (within: string) =>
  panel<Card[]>(`[...doc.querySelectorAll(${JSON.stringify(`${within} .spinoff`)})].filter((e) => e.getClientRects().length > 0).map((e) => {
    const box = e.getBoundingClientRect();
    const inside = [...e.querySelectorAll('*')].filter((d) => d.getClientRects().length > 0).every((d) => { const r = d.getBoundingClientRect(); return r.right <= box.right + 0.5 && r.left >= box.left - 0.5; });
    return {
      state: e.dataset.state,
      title: e.querySelector('.spinoff-title, .spinoff-started-text')?.textContent ?? '',
      tldr: e.querySelector('.spinoff-tldr')?.textContent ?? null,
      buttons: [...e.querySelectorAll('button')].map((b) => b.textContent),
      lane: e.querySelector('.spinoff-lane')?.textContent ?? null,
      fits: inside,
    };
  })`);

const card = (id: string, action: string) => `.transcript .spinoff[data-spinoff="${id}"] button[data-action="${action}"]`;

async function send(text: string): Promise<void> {
  await click('textarea');
  await ui({ do: 'type', text });
  await press('Enter');
}

/** At about 300px each card stays inside the transcript, with no sideways scroll. */
async function narrow(name: string): Promise<void> {
  const width = await panelWidth(300);
  check(Math.abs(width - 300) <= 4, 'the panel narrows to about 300px', width);
  const fits = await panel<{ overflow: number; outside: string[] }>(
    `(() => {
      const log = doc.querySelector('.transcript');
      const box = log.getBoundingClientRect();
      const parts = [...log.querySelectorAll('.spinoff, .spinoff *')].filter((e) => e.getClientRects().length > 0);
      return { overflow: log.scrollWidth - log.clientWidth, outside: parts.filter((e) => { const r = e.getBoundingClientRect(); return r.right > box.right + 0.5 || r.left < box.left - 0.5; }).map((e) => e.className || e.tagName) };
    })()`,
  );
  check(fits.overflow <= 0 && fits.outside.length === 0, `the cards fit at ${width}px`, fits);
  await screenshots(name);
  await panelWidth(420);
}

async function openTasks(): Promise<void> {
  await vscode.commands.executeCommand('gcode.chat.tasks');
  await waitFor('the Tasks pane', async () => (await view()) === 'tasks');
}

async function closePane(): Promise<void> {
  await press('Escape');
  await waitFor('the chat', async () => (await view()) === 'chat');
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
  await send(PROMPT);
  await waitFor('the turn to finish', async () => (await count('.transcript .turn-footer')) === 1);
  check((await textOf('.turn:last-of-type'))!.includes(ANSWERS.chat), 'the turn answers', await textOf('.turn:last-of-type'));

  const offered = await cards('.transcript');
  check(offered.length === 2 && offered.every((c) => c.state === 'offered'), 'two cards, both open', offered);
  check(offered[0]!.title === SUGGESTIONS.helper.title && offered[0]!.tldr === SUGGESTIONS.helper.tldr, 'the card shows the title and why', offered[0]);
  check(offered.every((c) => c.buttons.join() === 'Start,Dismiss'), 'each offers Start and Dismiss', offered);
  check((await count('.transcript .calls[data-step="spawn_task"]')) === 0, 'no spawn_task call shows as a call');
  const promptOpen = () => panel<boolean>(`doc.querySelector('.spinoff[data-spinoff="${IDS.helper}"] .spinoff-prompt').open`);
  check(!(await promptOpen()), 'the prompt is folded');
  await click(`.spinoff[data-spinoff="${IDS.helper}"] .spinoff-prompt > summary`);
  await waitFor('the prompt to open', promptOpen);
  check((await textOf(`.spinoff[data-spinoff="${IDS.helper}"] .spinoff-prompt-text`)) === SUGGESTIONS.helper.prompt, 'it is the prompt the task starts with');
  await screenshots('offered');
  await narrow('narrow-300-offered');
  await click(`.spinoff[data-spinoff="${IDS.helper}"] .spinoff-prompt > summary`);

  await openTasks();
  await waitFor('the Suggested section', () => shown('.tasks-section[data-section="suggested"]'));
  const listed = await cards('.tasks-section[data-section="suggested"]');
  check(listed.map((c) => c.title).join('|') === `${SUGGESTIONS.test.title}|${SUGGESTIONS.helper.title}`, 'the pane lists both, newest first', listed);
  check((await textOf('.tasks-section[data-section="suggested"] .tasks-count')) === '2', 'and counts them');
  await screenshots('suggested');
  await closePane();

  await click(card(IDS.helper, 'start'));
  await waitFor('the card to start', async () => (await cards('.transcript'))[0]?.state === 'started');
  const started = (await cards('.transcript'))[0]!;
  check(started.lane === LANE && started.buttons.join() === 'Open', 'started, it names its lane and offers Open', started);
  check(started.title.includes(SUGGESTIONS.helper.title), 'and keeps its title', started);
  await openTasks();
  await waitFor('the lane task done in the list', async () => (await panel<string[]>(`[...doc.querySelectorAll('.task-row')].map((r) => r.textContent)`)).some((row) => row.includes(SUGGESTIONS.helper.title) && row.includes(`Lane ${LANE}`) && row.includes('Done')));
  const suggestedNow = await cards('.tasks-section[data-section="suggested"]');
  check(suggestedNow.length === 1 && suggestedNow[0]!.title === SUGGESTIONS.test.title, 'Suggested keeps only the open one', suggestedNow);
  await closePane();
  await screenshots('started');

  await click(card(IDS.test, 'dismiss'));
  await waitFor('the dismissed card to go', async () => (await count(`.transcript .spinoff[data-spinoff="${IDS.test}"]`)) === 0);
  await openTasks();
  check(!(await shown('.tasks-section[data-section="suggested"]')), 'the Suggested section is gone with nothing open');
  await closePane();
  await narrow('narrow-300-started');
}
