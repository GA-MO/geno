import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { ANSWERS, MARKERS, PROMPTS, RELEASES, SENT, THEMES } from './steer-fixture.js';

const model = () => process.env['GCODE_FAKE_MODEL']!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(ok: boolean, what: string, actual?: unknown): void {
  if (!ok) throw new Error(`${what}${actual === undefined ? '' : `; got ${JSON.stringify(actual)}`}`);
}

async function waitFor(what: string, probe: () => Promise<boolean>, ms = 90_000): Promise<void> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      if (await probe()) return;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last === undefined ? '' : `: ${String(last)}`}`);
    await sleep(150);
  }
}

async function ui<T = unknown>(action: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${model()}/ui`, { method: 'POST', body: JSON.stringify(action) });
  const text = await response.text();
  check(response.ok, `ui ${JSON.stringify(action)}`, text);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

const panel = <T>(expression: string): Promise<T> => ui<T>({ do: 'eval', expression });
const click = (selector: string) => ui({ do: 'click', selector });
const press = (key: string, modifiers: string[] = []) => ui({ do: 'press', key, modifiers });
const textOf = (selector: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
const shown = (selector: string) => panel<boolean>(`(() => { const e = doc.querySelector(${JSON.stringify(selector)}); return e !== null && e.getClientRects().length > 0; })()`);
const attr = (selector: string, name: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)}) ?? null`);
const turns = () => count('.transcript .turn');
const footers = () => count('.transcript .turn-footer');
const view = () => panel<string>('doc.body.dataset.view');
const panelWidth = (target: number) => ui<number>({ do: 'resize', width: target });
const sendNowKey = process.platform === 'darwin' ? ['meta'] : ['ctrl'];

/** The classes of a turn's rail steps, in order, as `step-<kind>`. */
const railOf = (turn: number) =>
  panel<string[]>(`[...doc.querySelectorAll('.transcript .turn:nth-of-type(${turn}) > .rail > li')].map((li) => [...li.classList].find((c) => c.startsWith('step-') && c !== 'step'))`);

const release = (file: string) => writeFile(path.join(vscode.workspace.workspaceFolders![0]!.uri.fsPath, file), '');

/** Whether every shown control of the composer's bottom row stays inside it, and the row scrolls nothing. */
const rowFits = () =>
  panel<{ fits: boolean; scroll: number; client: number; outside: string[] }>(
    `(() => {
      const bar = doc.querySelector('.input-toolbar');
      const box = bar.getBoundingClientRect();
      const outside = [...bar.querySelectorAll('*')].filter((e) => e.getClientRects().length > 0).filter((e) => {
        const r = e.getBoundingClientRect();
        return r.right > box.right + 0.5 || r.left < box.left - 0.5;
      }).map((e) => e.className || e.tagName);
      return { fits: outside.length === 0 && bar.scrollWidth <= bar.clientWidth, scroll: bar.scrollWidth, client: bar.clientWidth, outside };
    })()`,
  );

async function useTheme(theme: string): Promise<void> {
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
  await sleep(1500);
  await vscode.commands.executeCommand('notifications.clearAll');
  await sleep(300);
}

async function screenshots(name: string): Promise<void> {
  await ui({ do: 'pointerAway' });
  for (const [slug, theme] of Object.entries(THEMES)) {
    await useTheme(theme);
    await ui({ do: 'screenshot', name: `${name}-${slug}` });
  }
  await useTheme(THEMES.dark);
}

async function typeDraft(text: string): Promise<void> {
  await click('textarea');
  await ui({ do: 'type', text });
}

async function send(text: string): Promise<void> {
  await typeDraft(text);
  await press('Enter');
}

const pill = async () => ({ state: await textOf('.queued-chip:not([hidden]) .queued-state'), text: await textOf('.queued-chip:not([hidden]) .tray-label') });

/** The landed steer in turn `turn`: its label, its text, and what the rail holds right before and after it. */
async function landed(turn: number): Promise<{ label: string | null; text: string | null; rail: string[] }> {
  const scope = `.transcript .turn:nth-of-type(${turn})`;
  return { label: (await textOf(`${scope} .steer-label`))?.trim() ?? null, text: await textOf(`${scope} .steer-text`), rail: await railOf(turn) };
}

/** The suite's failure, told to the test that launched it, which prints it: the extension host's console goes nowhere. */
export async function run(): Promise<void> {
  try {
    await steps();
  } catch (error) {
    await fetch(`${model()}/fail`, { method: 'POST', body: error instanceof Error ? (error.stack ?? error.message) : String(error) }).catch(() => {});
    throw error;
  }
}

async function steps(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await panelWidth(420);
  check(!(await shown('.send-now')), 'an idle composer has no Send now');

  // Send now during a tool round: the pill says it is on its way, and it lands between the step and the answer.
  await send(PROMPTS.steer);
  await waitFor('the waiting bash step', async () => (await count('.transcript .turn .step-calls.node-live')) === 1);
  check(!(await shown('.send-now')), 'Send now waits for something to send');
  await typeDraft(SENT.steer);
  await waitFor('Send now to offer itself', async () => await shown('.send-now'));
  check((await attr('.send-now', 'aria-disabled')) === 'false', 'a text-only draft can steer');
  const ready = await panelWidth(300);
  check(Math.abs(ready - 300) <= 4, 'the panel narrows to about 300px', ready);
  await sleep(300);
  const fitsReady = await rowFits();
  check(fitsReady.fits, `the bottom row fits at ${ready}px with Send now`, fitsReady);
  await screenshots('narrow-300-ready');
  await panelWidth(420);
  await screenshots('ready');

  await click('.send-now');
  await waitFor('the Sending now pill', async () => (await pill()).state === 'Sending now');
  check((await pill()).text === SENT.steer, 'the pill holds the message', await pill());
  check((await attr('.queued-chip', 'title'))?.startsWith('Lands at the next tool round') === true, 'its title says where it lands', await attr('.queued-chip', 'title'));
  check((await panel<string>('doc.querySelector("textarea").value')) === '', 'the draft went with it');
  check(!(await shown('.send-now')), 'Send now goes while the steer is out and nothing else is typed');
  check(await shown('button.stop'), 'the turn runs on');
  await typeDraft('and then');
  await waitFor('Send now held back', async () => (await shown('.send-now')) && (await attr('.send-now', 'aria-disabled')) === 'true');
  check((await attr('.send-now', 'title'))?.startsWith('One message at a time') === true, 'it says why', await attr('.send-now', 'title'));
  await screenshots('sending-now');
  const narrow = await panelWidth(300);
  check(Math.abs(narrow - 300) <= 4, 'narrow again', narrow);
  await sleep(300);
  const fitsPill = await rowFits();
  check(fitsPill.fits, `the bottom row fits at ${narrow}px with the steer out`, fitsPill);
  await screenshots('narrow-300-sending');
  await panelWidth(420);
  await click('textarea');
  await press('selectAll', ['meta']);
  await press('Backspace');

  await release(RELEASES.steer);
  await waitFor('the turn to finish', async () => (await footers()) === 1);
  const first = await landed(1);
  check(first.label === 'Sent mid-turn' && first.text === SENT.steer, 'the steer shows in the transcript, marked as sent mid-turn', first);
  check(first.rail.join() === 'step-text,step-calls,step-steer,step-text', 'between the tool step before it and the answer after it', first.rail);
  check((await textOf('.transcript .turn:nth-of-type(1) > .rail > li:last-child'))?.includes(ANSWERS.steer) === true, 'the answer follows it');
  check(!(await shown('.queued-chip')), 'the pill cleared once it landed');
  check((await turns()) === 1, 'a delivered steer starts no turn of its own', await turns());
  await screenshots('landed');
  const narrowLanded = await panelWidth(300);
  check(Math.abs(narrowLanded - 300) <= 4, 'narrow again', narrowLanded);
  await sleep(300);
  await screenshots('narrow-300-landed');
  await panelWidth(420);

  // Enter still queues: the follow-up waits for the turn's end, and Send now would steer it instead.
  await send(PROMPTS.queue);
  await waitFor('the second waiting step', async () => (await count('.transcript .turn:nth-of-type(2) .step-calls.node-live')) === 1);
  await send(SENT.queued);
  await waitFor('the Queued pill', async () => (await pill()).state === 'Queued');
  check((await pill()).text === SENT.queued, 'the queued pill holds the follow-up', await pill());
  check((await attr('.queued-chip', 'title')) === 'Sends when the turn finishes', 'its title says when it goes');
  check((await shown('.send-now')) && (await attr('.send-now', 'aria-disabled')) === 'false', 'Send now offers to steer the queued follow-up');
  await screenshots('queued');
  await release(RELEASES.queue);
  await waitFor('the queued follow-up to run as the next turn', async () => (await turns()) === 3);
  check((await textOf('.transcript .turn:nth-of-type(3) .request-bubble')) === SENT.queued, 'the follow-up went as typed');
  check((await count('.transcript .turn:nth-of-type(2) .step-steer')) === 0, 'and never into the turn it was typed in');

  // A steer the turn ends without: the key sends it now, the turn ends first, and it runs as the next turn, once.
  await waitFor('the held answer to be asked for', async () => (await ui<number>({ do: 'requests', marker: MARKERS.chat })) === 5);
  await typeDraft(SENT.nextTurn);
  await press('Enter', sendNowKey);
  await waitFor('the key to send it now', async () => (await pill()).state === 'Sending now');
  await sleep(500);
  await ui({ do: 'release', name: 'queued' });
  await waitFor('the steer to become the next turn', async () => (await turns()) === 4);
  check((await textOf('.transcript .turn:nth-of-type(4) .request-bubble')) === SENT.nextTurn, 'its prompt is the steer');
  await waitFor('that turn to end', async () => (await footers()) === 4);
  check((await textOf('.transcript .turn:nth-of-type(4) .markdown'))?.includes(ANSWERS.nextTurn) === true, 'with its own answer');
  check(!(await shown('.queued-chip')), 'the pill cleared');
  check((await count('.transcript .turn:nth-of-type(3) .step-steer')) === 0, 'the turn that missed it shows no steer');

  // A subagent's side view messages that child while it runs.
  await send(PROMPTS.agent);
  await waitFor('the child row', async () => (await count('.transcript .child-row.child-running')) === 1);
  await click('.transcript .child-row.child-running .child-open');
  await waitFor('the side view', async () => (await view()) === 'child');
  await waitFor('its message field', async () => await shown('.child-steer .steer-input'));
  await click('.child-steer .steer-input');
  await ui({ do: 'type', text: SENT.child });
  await press('Enter');
  await waitFor('the field to say it is on its way', async () => (await textOf('.child-steer .steer-status'))?.startsWith('Sending') === true);
  await screenshots('child-sending');
  await ui({ do: 'release', name: 'kid' });
  await waitFor('the field to say it landed', async () => (await textOf('.child-steer .steer-status')) === 'Delivered at its next tool round');
  await waitFor('the steer on the child’s rail', async () => (await textOf('.child-view .child-rail .steer-text')) === SENT.child);
  const kidRail = await panel<string[]>(`[...doc.querySelectorAll('.child-view .child-rail > li')].map((li) => [...li.classList].find((c) => c.startsWith('step-') && c !== 'step'))`);
  check(kidRail.indexOf('step-steer') > kidRail.indexOf('step-calls'), 'after the read it waited behind', kidRail);
  await waitFor('the child to end', async () => !(await shown('.child-steer .steer-input')));
  check((await textOf('.child-steer .steer-status')) === 'Delivered at its next tool round', 'its last word stays after it ends');
  await click('.child-view .child-back');
  await waitFor('the parent to finish', async () => (await footers()) === 5);

  // A reload, by way of the history: the replay puts the steer where it landed, not in a turn of its own.
  await vscode.commands.executeCommand('gcode.chat.new');
  await waitFor('a new chat', async () => (await turns()) === 0);
  await vscode.commands.executeCommand('gcode.chat.history');
  await waitFor('the session in the history', async () => (await count('.history-row')) >= 1);
  await panel(`([...doc.querySelectorAll('.history-row')].find((r) => r.querySelector('.history-row-title')?.textContent.includes(${JSON.stringify(MARKERS.chat)})).querySelector('.history-open').click(), 1)`);
  await waitFor('the session to load', async () => (await turns()) === 5 && (await footers()) === 5);
  const replayed = await landed(1);
  check(replayed.label === 'Sent mid-turn' && replayed.text === SENT.steer, 'the replay shows the steer, marked', replayed);
  check(replayed.rail.join() === 'step-text,step-calls,step-steer,step-text', 'in the same place', replayed.rail);
  check((await textOf('.transcript .turn:nth-of-type(4) .request-bubble')) === SENT.nextTurn, 'the missed steer replays as the turn it ran as');
  check((await count('.transcript .step-steer')) === 1, 'and no other steer shows in the parent');
  await screenshots('replayed');
}
