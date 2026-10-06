import * as vscode from 'vscode';
import { DATABASE, DECISION, DECISION_TURN, THAI, THEMES } from './history-search-fixture.js';

const model = () => process.env['GCODE_FAKE_MODEL']!;

function check(ok: boolean, what: string, actual?: unknown): void {
  if (!ok) throw new Error(`${what}${actual === undefined ? '' : `; got ${JSON.stringify(actual)}`}`);
}

async function waitFor(what: string, probe: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      if (await probe()) return;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last === undefined ? '' : `: ${String(last)}`}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function ui<T = unknown>(action: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${model()}/ui`, { method: 'POST', body: JSON.stringify(action) });
  const text = await response.text();
  check(response.ok, `ui ${JSON.stringify(action)}`, text);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

const panel = <T>(expression: string): Promise<T> => ui<T>({ do: 'eval', expression });
const click = (selector: string, text?: string) => ui({ do: 'click', selector, ...(text === undefined ? {} : { text }) });
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
const visible = (selector: string) => panel<boolean>(`(() => { const e = doc.querySelector(${JSON.stringify(selector)}); return !!e && !e.closest('[hidden]') && e.getClientRects().length > 0; })()`);
const rows = () => panel<string[]>(`[...doc.querySelectorAll('.history-row')].map((r) => r.dataset.session)`);
const hitOf = (id: string) =>
  panel<{ place: string; snippet: string; marks: string[] } | null>(
    `(() => { const r = doc.querySelector('[data-session="${id}"] .history-hit'); return r && { place: r.querySelector('.history-hit-place').textContent, snippet: r.querySelector('.history-snippet').textContent, marks: [...r.querySelectorAll('mark')].map((m) => m.textContent) }; })()`,
  );

async function screenshots(name: string): Promise<void> {
  for (const [slug, theme] of Object.entries(THEMES)) {
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
    await new Promise((r) => setTimeout(r, 1500));
    await vscode.commands.executeCommand('notifications.clearAll');
    await new Promise((r) => setTimeout(r, 300));
    await ui({ do: 'screenshot', name: `${name}-${slug}` });
  }
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', THEMES.dark, vscode.ConfigurationTarget.Global);
}

/** Replaces the search field's text as the user types it. */
async function search(text: string): Promise<void> {
  await click('.history-search-input');
  await ui({ do: 'press', key: 'selectAll', modifiers: ['meta'] });
  await ui({ do: 'press', key: 'Backspace' });
  if (text !== '') await ui({ do: 'type', text });
}

export async function run(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('gcode.chat.focus');

  await vscode.commands.executeCommand('gcode.chat.history');
  await waitFor('the history to list the three sessions', async () => (await rows()).length === 3);

  await search('postgres');
  await waitFor('the text search to find the database session', async () => (await hitOf(DATABASE.id)) !== null);
  check((await rows()).join() === DATABASE.id, 'only the session whose text holds the word is listed', await rows());
  const found = (await hitOf(DATABASE.id))!;
  check(/^Turn 9 · [A-Z][a-z]{2} \d+$/.test(found.place), 'the hit names its turn and day', found.place);
  check(found.snippet === DECISION, 'the hit shows the turn\'s text around the match', found.snippet);
  check(found.marks.join() === 'Postgres', 'the match is marked as the text writes it', found.marks);
  await screenshots('search');

  await search('ตัดสินใจ');
  await waitFor('the Thai search to find the Thai session', async () => (await hitOf(THAI.id)) !== null);
  check((await rows()).join() === THAI.id, 'Thai matches inside a run of text with no spaces', await rows());
  check((await hitOf(THAI.id))!.marks.join() === 'ตัดสินใจ', 'the Thai match is marked', (await hitOf(THAI.id))!.marks);
  await screenshots('search-thai');

  await search('kubernetes');
  await waitFor('a search that finds nothing to say so', async () => (await panel<string>(`doc.querySelector('.history-note').textContent`)) === 'No chats match “kubernetes”.');

  await search('');
  await waitFor('the cleared search to list every session again, with no hits', async () => (await rows()).length === 3 && (await count('.history-hit')) === 0);

  await search('orders database');
  await waitFor('two words, both in the decision turn', async () => (await hitOf(DATABASE.id))?.place.startsWith(`Turn ${DECISION_TURN} `) === true);
  await click(`[data-session="${DATABASE.id}"] .history-open`);
  await waitFor('the session to load with every turn', async () => (await count('.turn')) === DATABASE.turns.length && (await visible('textarea')));
  // The transcript keeps room at its top for the sticky request, so a turn scrolled to the top starts below it.
  await waitFor('the found turn to be scrolled to the top of the transcript, mid-scroll, and marked for a moment', () =>
    panel<boolean>(
      `(() => { const log = doc.querySelector('.transcript'); const turn = doc.querySelectorAll('.turn')[${DECISION_TURN - 1}]; const top = turn.getBoundingClientRect().top - log.getBoundingClientRect().top; return Math.abs(top - parseFloat(getComputedStyle(log).scrollPaddingTop)) < 4 && log.scrollTop > 0 && log.scrollTop + log.clientHeight < log.scrollHeight - 24 && turn.classList.contains('turn-found'); })()`,
    ),
  );
  check((await panel<string>(`doc.querySelectorAll('.turn')[${DECISION_TURN - 1}].querySelector('.request-bubble').textContent`)) === DATABASE.turns[DECISION_TURN - 1]!.prompt, 'the turn in view is the one that holds the decision');
  await screenshots('opened-at-turn');
  await waitFor('the mark to fade', async () => (await count('.turn-found')) === 0, 5000);
}
