import * as vscode from 'vscode';
import { ANSWERS, MARKERS, PROMPTS } from './attention-fixture.js';
import { check, click, count, openPanel, panel, panelWidth, press, screenshots, shown, sleep, textOf, toasts, ui, view, waitFor, workbench } from './lanes-ui.js';

type Marker = (typeof MARKERS)[keyof typeof MARKERS];

/** The Tasks row whose title holds `marker`. */
export const rowOf = (marker: Marker) => `.task-row:has(.task-title[title*="${marker}"])`;

/** Which section each listed task sits in, and the shown sections in order. */
export const sectionsShown = () =>
  panel<{ order: string[]; rows: Record<string, string[]> }>(`(() => {
    const sections = [...doc.querySelectorAll('.tasks-section:not([hidden])')];
    return {
      order: sections.map((s) => s.dataset.section),
      rows: Object.fromEntries(sections.map((s) => [s.dataset.section, [...s.querySelectorAll('.task-title')].map((t) => t.textContent)])),
    };
  })()`);

export const sectionOf = (marker: Marker) => panel<string | null>(`doc.querySelector(${JSON.stringify(rowOf(marker))})?.closest('.tasks-section')?.dataset.section ?? null`);

/** The number on the Geno icon in the activity bar, or null when it has none. */
export const badge = () =>
  workbench<string | null>(`(() => {
    const item = [...document.querySelectorAll('.activitybar .action-item')].find((i) => (i.querySelector('.action-label')?.getAttribute('aria-label') ?? '').startsWith('Geno'));
    const content = item?.querySelector('.badge:not(.hidden) .badge-content');
    return content && content.getClientRects().length > 0 ? content.textContent : null;
  })()`);

export async function openTasks(): Promise<void> {
  await vscode.commands.executeCommand('gcode.chat.tasks');
  await waitFor('the Tasks pane', async () => (await view()) === 'tasks');
}

/** The open permission card holds the keyboard and sits inside the transcript's view. */
const cardInView = () =>
  panel<{ focused: boolean; inView: boolean }>(`(() => {
    const card = doc.querySelector('.permission-open[data-permission]');
    if (card === null) return { focused: false, inView: false };
    const r = card.getBoundingClientRect();
    const log = doc.querySelector('.transcript').getBoundingClientRect();
    return { focused: card.contains(doc.activeElement), inView: r.top >= log.top - 1 && r.top < log.bottom };
  })()`);

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

export async function run(): Promise<void> {
  await openPanel();
  await panelWidth(420);

  // Done: a turn the user watched finish.
  await send(PROMPTS.seen);
  await waitFor('the watched answer', async () => (await transcript()).includes(ANSWERS.seen));
  await waitFor('the watched turn to end', async () => !(await shown('button.stop')));

  // Working: a turn the model holds; it goes on in the background.
  await newChat();
  await send(PROMPTS.slow);
  await waitFor('the slow turn’s read', async () => (await count('.transcript .calls[data-step="read"]')) >= 1);

  // Needs you: a card of the chat's own, left waiting.
  await newChat();
  await send(PROMPTS.ask);
  await waitFor('the chat’s own permission card', async () => (await count('.permission-open[data-permission]')) === 1, 90_000, transcript);

  // Needs you through a child: the worker's card shows on the parent, and the parent's own turn still runs.
  await newChat();
  await send(PROMPTS.parent);
  await waitFor('the worker’s permission card on the parent', async () => (await count('.permission-open[data-permission]')) === 1, 90_000, transcript);

  // Ready: a lane that finishes while the user is elsewhere.
  await newChat();
  await click('textarea');
  await ui({ do: 'type', text: PROMPTS.lane });
  await click('.send-more');
  await waitFor('the send menu', async () => await shown('#send-menu'));
  await click('#send-menu [data-action="lane"]');
  await waitFor('the Lanes pane', async () => (await view()) === 'lanes');
  await waitFor('the lane to finish', async () => (await textOf('.lane-row .lane-state'))?.trim() === 'Done', 90_000, async () => textOf('.lanes:not([hidden])'));
  await waitFor('VS Code’s note that the lane finished', async () => (await toasts()).some((t) => t.startsWith(`Geno finished: ${PROMPTS.lane}`)));
  await press('Escape');
  await vscode.commands.executeCommand('notifications.clearAll');

  await openTasks();
  const listed = async () => sectionsShown();
  await waitFor('every section', async () => (await listed()).order.join() === 'needs-you,ready,working,done', 30_000, listed);
  const { rows } = await listed();
  check(rows['needs-you']!.join('|') === [PROMPTS.parent, PROMPTS.ask].join('|'), 'Needs you lists the newest card first', rows);
  check(rows['ready']!.join('|') === PROMPTS.lane, 'the finished lane is Ready', rows);
  check(rows['working']!.join('|') === PROMPTS.slow, 'the held turn is Working', rows);
  check(rows['done']!.join('|') === PROMPTS.seen, 'the watched turn is Done', rows);
  check((await textOf(`${rowOf(MARKERS.parent)} .task-state`))?.trim() === 'Needs permission', 'the parent reads as needing permission', await textOf(`${rowOf(MARKERS.parent)} .task-state`));
  check((await textOf(`${rowOf(MARKERS.parent)} .task-children`)) === '1 agent running', 'with its worker rolled in', await textOf(`${rowOf(MARKERS.parent)} .task-children`));
  check((await count('.task-row:has(.task-title[title*="[child]"])')) === 0, 'the worker has no row of its own');
  check((await textOf('[data-section="needs-you"] .tasks-count')) === '2', 'the heading counts two', await textOf('[data-section="needs-you"] .tasks-count'));
  check((await count(`${rowOf(MARKERS.lane)} .task-new`)) === 1, 'the lane is marked New');
  await waitFor('the badge on the Geno icon', async () => (await badge()) === '2', 10_000, badge);

  // Working folds to one line with its count, and opens on a click.
  check(!(await shown(rowOf(MARKERS.slow))), 'the working row is folded away');
  const fold = await panel<{ expanded: string | null; height: number; text: string }>(
    `(() => { const f = doc.querySelector('.tasks-fold'); return { expanded: f.getAttribute('aria-expanded'), height: f.getBoundingClientRect().height, text: f.textContent }; })()`,
  );
  check(fold.expanded === 'false' && fold.height < 40 && fold.text.includes('Working') && fold.text.includes('1') && fold.text.includes(PROMPTS.slow), 'Working is one line with its count and title', fold);
  await screenshots('tasks');

  const narrow = await panelWidth(300);
  check(Math.abs(narrow - 300) <= 4, 'the panel narrows to about 300px', narrow);
  await sleep(300);
  const fits = await panel<{ fits: boolean; wide: string[] }>(`(() => {
    const pane = doc.querySelector('.tasks').getBoundingClientRect();
    const wide = [...doc.querySelectorAll('.tasks *')].filter((e) => e.getClientRects().length > 0 && e.getBoundingClientRect().right > pane.right + 0.5).map((e) => e.className || e.tagName);
    return { fits: wide.length === 0 && doc.querySelector('.lanes:not([hidden])').scrollWidth <= doc.querySelector('.lanes:not([hidden])').clientWidth, wide };
  })()`);
  check(fits.fits, `the Tasks pane fits at ${narrow}px`, fits);
  await screenshots('tasks-300');
  await panelWidth(420);

  await click('.tasks-fold');
  await waitFor('Working to open', async () => await shown(rowOf(MARKERS.slow)));
  check((await panel<string>(`doc.querySelector('.tasks-fold').getAttribute('aria-expanded')`)) === 'true', 'the fold says it is open');
  await screenshots('tasks-working-open');
  await click('.tasks-fold');
  await waitFor('Working to fold again', async () => !(await shown(rowOf(MARKERS.slow))));

  // Opening the Ready lane shows its session, and it is Done from then on.
  await click(`${rowOf(MARKERS.lane)} .task-title`);
  await waitFor('the lane’s session in the chat', async () => (await view()) === 'chat' && (await transcript()).includes(ANSWERS.lane), 30_000, transcript);
  await openTasks();
  await waitFor('the lane to move to Done', async () => (await sectionOf(MARKERS.lane)) === 'done', 10_000, listed);
  check((await count(`${rowOf(MARKERS.lane)} .task-new`)) === 0, 'and lose its New mark');

  // A row in Needs you opens at the card that waits, even when the card is a child's on its parent.
  await click(`${rowOf(MARKERS.parent)} .task-title`);
  await waitFor('the parent with its card in view and the keyboard on it', async () => {
    const at = await cardInView();
    return (await view()) === 'chat' && at.focused && at.inView;
  }, 30_000, cardInView);
  check((await transcript()).includes(PROMPTS.parent), 'the parent is the chat shown');
  await screenshots('opened-at-card');

  // Answered, the worker and its parent finish while shown: Done, and the badge counts one.
  await click('.permission-open [data-focus$=":reject"]');
  await waitFor('the parent’s answer', async () => (await transcript()).includes(ANSWERS.parent), 60_000, transcript);
  await waitFor('the badge to count one', async () => (await badge()) === '1', 10_000, badge);
  await openTasks();
  await waitFor('the parent in Done', async () => (await sectionOf(MARKERS.parent)) === 'done', 10_000, listed);
  check((await sectionOf(MARKERS.ask)) === 'needs-you', 'the other card still needs the user');
  await press('Escape');
}
