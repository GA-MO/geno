import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { APPLIED, GRAFTED, REASONS, SUMMARY, TASK } from './arena-fixture.js';
import { check, click, count, focused, openPanel, panel, panelWidth, press, screenshots, shown, sleep, textOf, ui, view, waitFor } from './lanes-ui.js';

const workspace = () => vscode.workspace.workspaceFolders![0]!.uri.fsPath;
const disk = (file: string) => readFile(path.join(workspace(), file), 'utf8');
const calls = () => ui<Record<string, number>>({ do: 'calls' });
const texts = (selector: string) => panel<string[]>(`[...doc.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent.trim())`);
const pane = '.lanes.arena';

/** Whether every shown element of the Arena pane stays inside it, and neither the pane nor the page scrolls sideways. */
const paneFits = () =>
  panel<{ fits: boolean; width: number; outside: string[]; scroll: number; client: number; page: number }>(
    `(() => {
      const pane = doc.querySelector('${pane}');
      const box = pane.getBoundingClientRect();
      const outside = [...pane.querySelectorAll('*')].filter((e) => e.getClientRects().length > 0).filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && (r.right > box.right + 0.5 || r.left < box.left - 0.5);
      }).map((e) => e.className || e.tagName);
      const page = doc.documentElement;
      return { fits: outside.length === 0 && pane.scrollWidth <= pane.clientWidth && page.scrollWidth <= page.clientWidth, width: box.width, outside, scroll: pane.scrollWidth, client: pane.clientWidth, page: page.scrollWidth };
    })()`,
  );

async function fitsAt300(what: string): Promise<void> {
  const width = await panelWidth(300);
  check(Math.abs(width - 300) <= 4, 'the panel narrows to about 300px', width);
  await sleep(400);
  const fits = await paneFits();
  check(fits.fits, `${what} fits a ${width}px panel`, fits);
}

async function send(text: string): Promise<void> {
  await click('textarea');
  await ui({ do: 'type', text });
  await press('Enter');
}

export async function run(): Promise<void> {
  await openPanel();
  await panelWidth(420);

  // A mistake in the arguments shows on the card, not in a dialog.
  await send('/best-of-n 5 ' + TASK);
  await waitFor('the Arena pane', async () => (await view()) === 'arena');
  check((await textOf(`${pane} .arena-error`))?.startsWith('Best-of-n runs 2 to 4 lanes, not 5.') === true, 'a wrong lane count shows inline', await textOf(`${pane} .arena-error`));
  check((await count('.turn')) === 0, '/best-of-n starts no chat turn');
  await press('Escape');
  await waitFor('the chat', async () => (await view()) === 'chat');

  // The preview: the task, the lanes and their variants, the cost in words; nothing spends before Start.
  await send(`/best-of-n 3 ${TASK}`);
  await waitFor('the Arena pane', async () => (await view()) === 'arena');
  await waitFor('the cost preview', async () => (await textOf(`${pane} .arena-cost`))?.startsWith('About') === true);
  await waitFor('the keyboard on Back', () => panel<boolean>(`doc.activeElement === doc.querySelector('${pane} .history-back')`), 5000, focused);
  check((await textOf(`${pane} .arena-cost`)) === 'About $0.15: 3 lanes at a default of $0.032 a task, plus up to $0.05 for the review.', 'the cost in words', await textOf(`${pane} .arena-cost`));
  check((await texts(`${pane} .arena-variants li`)).join('|') === 'AAs asked|BMinimal change|CIdiomatic refactor', 'each lane’s variant', await texts(`${pane} .arena-variants li`));
  check((await textOf(`${pane} .arena-task`)) === TASK, 'the task', await textOf(`${pane} .arena-task`));
  check((await panel<string | null>(`doc.querySelector('${pane} .arena-choice.chosen')?.dataset.variety ?? null`)) === 'seeds', 'seeds is the variety');

  await click(`${pane} [data-variety="effort"]`);
  await waitFor('the effort variants', async () => (await texts(`${pane} .arena-variants li`)).join('|') === 'Alow effort|Bmedium effort|Chigh effort');
  await click(`${pane} [data-variety="seeds"]`);
  await waitFor('the seed variants again', async () => (await texts(`${pane} .arena-variants li`)).join('|') === 'AAs asked|BMinimal change|CIdiomatic refactor');
  check(Object.keys(await calls()).length === 0, 'the preview called no model', await calls());
  await screenshots('preview');
  await fitsAt300('the preview');
  await screenshots('preview-300');
  await panelWidth(420);

  // The race: a row per lane with its dino on the track, and Stop.
  await click(`${pane} [data-focus="arena-start"]`);
  await waitFor('three lanes racing', async () => (await count(`${pane} .race-row`)) === 3, 120_000);
  await waitFor('every lane running', async () => (await texts(`${pane} .race-state`)).join() === 'Running,Running,Running');
  await waitFor('a dino on each track', async () => (await count(`${pane} .race-runner canvas.helper-dino`)) === 3);
  check(await shown(`${pane} [data-focus="arena-stop"]`), 'Stop shows while lanes run');
  check((await textOf(`${pane} .arena-status`))?.trim() === 'Racing', 'the run is racing', await textOf(`${pane} .arena-status`));
  const lanes = await panel<string[]>(`[...doc.querySelectorAll('${pane} .race-row')].map((e) => e.dataset.lane)`);
  const [laneA, laneB, laneC] = lanes as [string, string, string];
  await screenshots('race');
  await fitsAt300('the race');
  await screenshots('race-300');
  await panelWidth(420);

  // The lanes finish; A and B pass their check and C fails it; then the review ranks A and B.
  await ui({ do: 'release', name: 'race' });
  await waitFor('the review to start', async () => (await textOf(`${pane} .arena-status`))?.trim() === 'Ranking…', 120_000);
  check((await texts(`${pane} .race-check`)).join() === 'Check passed,Check passed,Check failed', 'each lane’s check', await texts(`${pane} .race-check`));
  check((await texts(`${pane} .race-state`)).join() === 'Passed,Passed,Failed', 'each lane’s state', await texts(`${pane} .race-state`));
  check((await textOf(`${pane} .arena-ranking`)) !== null, 'the pane says the review is ranking');
  await screenshots('ranking');
  await ui({ do: 'release', name: 'review' });

  await waitFor('the ranking', async () => (await textOf(`${pane} .arena-status`))?.trim() === 'Ranked', 120_000);
  const ranks = await panel<string[]>(`[...doc.querySelectorAll('${pane} .rank-row')].map((e) => e.querySelector('.rank-number').textContent + ' ' + e.dataset.lane + ' ' + (e.querySelector('.rank-reason')?.textContent ?? ''))`);
  check(ranks.join('|') === `1 ${laneB} ${REASONS.B}|2 ${laneA} ${REASONS.A}|– ${laneC} `, 'B first, then A, with their reasons, then C unranked', ranks);
  check((await textOf(`${pane} .arena-summary`)) === SUMMARY, 'the review’s summary', await textOf(`${pane} .arena-summary`));
  check((await texts(`${pane} [data-action="pick"]`)).join() === 'Pick B,Pick A', 'Pick on the passing lanes only', await texts(`${pane} [data-action="pick"]`));

  // The compare: one lane at a time below the wide width, every lane side by side above it.
  await waitFor('the compare', async () => (await count(`${pane} .compare-file`)) === 2);
  check((await texts(`${pane} .compare-path`)).join() === 'a.ts,b.ts', 'a row per changed file', await texts(`${pane} .compare-path`));
  check(await shown(`${pane} .compare-switch`), 'a narrow panel switches lanes');
  check((await panel<string>(`doc.querySelector('${pane} .compare-tab.chosen').dataset.lane`)) === laneB, 'it opens on the first ranked lane');
  check((await texts(`${pane} .compare-tab`)).join() === 'A#2,B#1,C', 'the switcher gives each lane’s rank', await texts(`${pane} .compare-tab`));
  check((await count(`${pane} .compare-cell:not(.focused)`)) > 0 && !(await shown(`${pane} .compare-cell[data-lane="${laneA}"]`)), 'only one lane shows');
  await click(`${pane} .compare-tab[data-lane="${laneA}"]`);
  await waitFor('lane A in the compare', async () => await shown(`${pane} .compare-cell[data-lane="${laneA}"] .compare-hunk`));
  check((await count(`${pane} .compare-cell[data-lane="${laneA}"] .compare-hunk`)) === 2, 'A has two hunks in a.ts');
  check((await count(`${pane} .compare-hunk.graftable`)) === 0, 'nothing grafts before a pick');
  await panel(`doc.querySelector('${pane} .arena-compare').scrollIntoView()`);
  await fitsAt300('the ranking and the compare');
  await screenshots('compare-300');
  const wide = await panelWidth(700);
  await sleep(400);
  const cells = await panel<number>(`[...doc.querySelector('${pane} .compare-file').querySelectorAll('.compare-cell')].filter((c) => c.getClientRects().length > 0).length`);
  check(!(await shown(`${pane} .compare-switch`)) && cells === 3, `a ${wide}px panel shows every lane side by side`, { wide, cells });
  const aligned = await panel<boolean>(`[...doc.querySelectorAll('${pane} .compare-file')].every((file) => new Set([...file.querySelectorAll('.compare-cell')].map((c) => Math.round(c.getBoundingClientRect().top))).size === 1)`);
  check(aligned, 'each file’s cells line up across the lanes');
  check((await paneFits()).fits, 'the wide compare fits', await paneFits());
  await screenshots('ranked');
  await panelWidth(420);

  // Pick B: the run records it and the chat applies it for review; the pane stays for the graft.
  await click(`${pane} [data-focus="arena-pick:${laneB}"]`);
  await waitFor('the apply to finish', async () => (await textOf(`${pane} .arena-notice`))?.startsWith('Lane B is applied in the chat') === true, 60_000, async () => textOf(`${pane} .arena-notice`));
  check((await view()) === 'arena', 'the pane stays open after the pick');
  check((await texts(`${pane} .rank-state`))[0] === 'Winner', 'B is the winner');
  check((await count(`${pane} [data-action="pick"]`)) === 0, 'no more picks');
  check((await count(`${pane} .compare-hunk.graftable`)) === 2, 'A’s added line and C’s line two can be grafted; A’s line two is B’s own', await count(`${pane} .compare-hunk.graftable`));
  check((await disk('a.ts')) === APPLIED['a.ts'] && (await disk('b.ts')) === APPLIED['b.ts'], 'the winner is applied to the main checkout');
  await click(`${pane} .compare-tab[data-lane="${laneA}"]`);
  await waitFor('A’s hunks with their checkboxes', async () => await shown(`${pane} .compare-cell[data-lane="${laneA}"] .compare-hunk.graftable input`));
  await panel(`doc.querySelector('${pane} .arena-compare').scrollIntoView()`);
  await screenshots('picked');
  await fitsAt300('the compare after a pick');
  await panel(`doc.querySelector('${pane} .arena-compare').scrollIntoView()`);
  await screenshots('picked-300');
  await panelWidth(420);

  await press('Escape');
  await waitFor('the chat', async () => (await view()) === 'chat');
  await waitFor('the apply turn with its two hunks', async () => (await count('.transcript .hunk[data-hunk] .hunk-actions')) === 2);
  check((await textOf('.turn:last-of-type .request'))?.includes(`Apply lane ${laneB}`) === true, 'the apply is a chat turn', await textOf('.turn:last-of-type .request'));
  await click('.transcript .hunk[data-hunk] [data-focus^="keep:"]');
  await waitFor('one hunk kept', async () => (await count('.transcript .hunk .decision-kept')) === 1);

  // The webview goes away and comes back; the host hands the run to the new one.
  await panel('doc.defaultView.arenaMark = true');
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  await sleep(800);
  await openPanel();
  await waitFor('a new webview', async () => (await panel<boolean>('doc.defaultView.arenaMark === undefined')) === true);
  await click('textarea');
  await ui({ do: 'type', text: '/best-of-n' });
  await press('Enter');
  await press('Enter');
  await waitFor('the Arena pane on the last run', async () => (await view()) === 'arena' && (await count(`${pane} .compare-file`)) === 2);
  check((await texts(`${pane} .rank-state`))[0] === 'Winner', 'the run came back with its winner');

  // Graft A's added line: the chat takes it as a turn, under review.
  await click(`${pane} .compare-tab[data-lane="${laneA}"]`);
  await waitFor('A’s graftable hunk', async () => await shown(`${pane} .compare-cell[data-lane="${laneA}"] .compare-hunk.graftable input`));
  check((await panel<boolean>(`doc.querySelector('${pane} [data-action="graft"]').disabled`)), 'Graft waits for a ticked hunk');
  await click(`${pane} .compare-cell[data-lane="${laneA}"] .compare-hunk.graftable input`);
  await waitFor('the graft button', async () => (await textOf(`${pane} [data-action="graft"]`)) === 'Graft 1 hunk from A');
  await click(`${pane} [data-action="graft"]`);
  await waitFor('the chat', async () => (await view()) === 'chat');
  await waitFor('the graft on disk', async () => (await disk('a.ts')) === GRAFTED, 60_000, async () => disk('a.ts'));
  await waitFor('the graft turn with its hunk under review', async () => (await count('.turn:last-of-type .hunk[data-hunk] .hunk-actions')) === 1);
  check((await textOf('.turn:last-of-type .request'))?.includes(`Graft 1 hunk from lane ${laneA}`) === true, 'the graft is a chat turn', await textOf('.turn:last-of-type .request'));
  check((await textOf('.turn:last-of-type'))?.includes(`Grafted 1 hunk in 1 file from lane ${laneA}.`) === true, 'the turn says what it grafted', await textOf('.turn:last-of-type'));
  check((await disk('b.ts')) === APPLIED['b.ts'], 'B’s other change stays');
  await screenshots('grafted');
}
