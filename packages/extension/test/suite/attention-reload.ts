import { MARKERS } from './attention-fixture.js';
import { badge, openTasks, rowOf, sectionOf, sectionsShown } from './attention.js';
import { check, click, count, openPanel, panelWidth, press, shown, textOf, ui, view, waitFor } from './lanes-ui.js';

/** After a window reload: what the user opened stays seen, and what waits on them still does. */
export async function run(): Promise<void> {
  await openPanel();
  await panelWidth(420);
  await openTasks();
  const listed = async () => sectionsShown();
  await waitFor('the list from the engine', async () => (await sectionOf(MARKERS.lane)) !== null, 60_000, listed);
  check((await sectionOf(MARKERS.lane)) === 'done', 'the lane opened before the reload is still Done', await listed());
  check((await sectionOf(MARKERS.ask)) === 'needs-you', 'the card nobody answered still needs the user', await listed());
  check((await sectionOf(MARKERS.slow)) === 'working', 'the held turn still works', await listed());
  await waitFor('the badge after the reload', async () => (await badge()) === '1', 10_000, badge);

  // Answer the last card and let the held turn go, so the engine has nothing left to run.
  await click(`${rowOf(MARKERS.ask)} .task-title`);
  await waitFor('the card in the chat', async () => (await view()) === 'chat' && (await count('.permission-open[data-permission]')) === 1, 30_000, async () => textOf('.transcript'));
  await click('.permission-open [data-focus$=":reject"]');
  await waitFor('the refused turn to end', async () => (await count('.permission-outcome')) === 1 && (await count('.turn[aria-busy="true"]')) === 0, 60_000, async () => textOf('.transcript'));
  await ui({ do: 'release', name: 'slow' });
  await openTasks();
  await waitFor('nothing left working or waiting', async () => (await listed()).order.join() === 'ready,done', 60_000, listed);
  check((await sectionOf(MARKERS.slow)) === 'ready', 'the held turn finished out of sight, so it is Ready', await listed());
  await waitFor('no badge', async () => (await badge()) === null, 10_000, badge);
  check(!(await shown('[data-section="needs-you"]')), 'Needs you is gone');
  await press('Escape');
}
