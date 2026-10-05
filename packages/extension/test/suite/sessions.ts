import * as vscode from 'vscode';
import { ANSWERS, ELSEWHERE, OLDER, PROMPTS, RENAMED, TEMPORARY, THEMES } from './sessions-fixture.js';

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
const page = <T>(expression: string): Promise<T> => ui<T>({ do: 'evalPage', expression });
const click = (selector: string, text?: string) => ui({ do: 'click', selector, ...(text === undefined ? {} : { text }) });
const textOf = (selector: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
const titles = () => panel<string[]>(`[...doc.querySelectorAll('.history-row:not([hidden]) .history-row-title')].map((t) => t.textContent)`);
const visible = (selector: string) => panel<boolean>(`(() => { const e = doc.querySelector(${JSON.stringify(selector)}); return !!e && !e.closest('[hidden]') && e.getClientRects().length > 0; })()`);
const header = () => panel<string>(`doc.querySelector('.header-project').textContent + ' / ' + doc.querySelector('.header-title').textContent`);
const project = () => vscode.workspace.workspaceFolders![0]!.name;

async function showPanel(): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1);
}

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

async function send(prompt: string): Promise<void> {
  await click('textarea');
  await ui({ do: 'type', text: prompt });
  await ui({ do: 'press', key: 'Enter' });
}

/** Clicks a view-title action in the workbench, as the user would, by its label. */
async function titleAction(label: string): Promise<void> {
  const clicked = await page<boolean>(
    `(() => { const a = [...document.querySelectorAll('.pane-header .action-label, .composite.title .action-label')].find((e) => e.getAttribute('aria-label') === ${JSON.stringify(label)}); a?.click(); return !!a; })()`,
  );
  check(clicked, `the view title has a ${label} action`);
}

export async function run(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await showPanel();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('gcode.chat.focus');
  for (let i = 0; i < 5; i++) await vscode.commands.executeCommand('workbench.action.decreaseViewWidth');

  check((await header()) === `${project()} / New chat`, 'a window with no session names the project and a new chat', await header());

  await send(PROMPTS.hello);
  await waitFor('the first turn to finish', async () => (await count('.turn-footer')) === 1);
  await waitFor('the header to take the first prompt as the title', async () => (await header()) === `${project()} / ${PROMPTS.hello}`);
  await screenshots('header');

  await titleAction('Chat History');
  await waitFor('the history to list this project', async () => (await titles()).length === 2);
  check(!(await visible('.transcript')) && !(await visible('textarea')), 'the history takes the transcript\'s and the composer\'s place');
  check((await titles()).join('|') === `${PROMPTS.hello}|${OLDER.prompt}`, 'this project\'s sessions, newest first', await titles());
  check((await textOf('.history-row.current .history-row-title')) === PROMPTS.hello, 'the session in the panel is marked current');
  const meta = await textOf(`[data-session="${OLDER.id}"] .history-meta`);
  check(/^(\d+d ago|[A-Z][a-z]{2} \d+) · 1 turn · \$0\.0008$/.test(meta ?? ''), 'a row gives the time, the turn count and the cost', meta);
  await screenshots('history');

  await click('.history-search-input');
  await ui({ do: 'type', text: 'parser' });
  await waitFor('the search to narrow the list', async () => (await titles()).join() === OLDER.prompt);
  await click('.history-search-input');
  await ui({ do: 'press', key: 'selectAll', modifiers: ['meta'] });
  await ui({ do: 'press', key: 'Backspace' });
  await waitFor('the cleared search to list both again', async () => (await titles()).length === 2);

  await click('.scope-option', 'All projects');
  await waitFor('every project to be listed', async () => (await titles()).join() === ELSEWHERE.prompt);
  check(!(await titles()).includes(TEMPORARY.prompt), 'a temporary clone\'s session never shows');
  check((await textOf('.history-meta'))?.startsWith('elsewhere · ') === true, 'every project\'s list names each row\'s project', await textOf('.history-meta'));
  check((await count('.history-elsewhere')) === 1, 'another project\'s row says it opens elsewhere');
  await screenshots('history-all');
  await click('.scope-option', 'This project');
  await waitFor('this project again', async () => (await titles()).length === 2);

  await panel(`(doc.querySelector('.history-row.current .history-actions button[title="Rename"]').click(), 1)`);
  await waitFor('the rename field', async () => (await count('.history-rename')) === 1);
  await screenshots('rename');
  await panel(`(() => { const i = doc.querySelector('.history-rename'); i.value = ${JSON.stringify(RENAMED)}; return 1; })()`);
  await click('.history-rename');
  await ui({ do: 'press', key: 'Enter' });
  await waitFor('the list to show the new title', async () => (await titles()).includes(RENAMED));
  await waitFor('the header to show the new title', async () => (await header()) === `${project()} / ${RENAMED}`);

  await click(`[data-session="${OLDER.id}"] .history-open`);
  await waitFor('the old session to load', async () => (await textOf('.request-bubble')) === OLDER.prompt);
  check(!(await visible('.history')) && (await visible('textarea')), 'opening a session closes the history');
  check((await header()) === `${project()} / ${OLDER.prompt}`, 'the header names the loaded session', await header());
  check((await count('.turn')) === 1, 'the panel shows only the loaded session\'s turns', await count('.turn'));
  check((await textOf('.turn .turn-fold')) === 'Read 1 file', 'a loaded session renders compact, its work behind the summary line', await textOf('.turn .turn-fold'));
  check((await textOf('.turn .markdown'))?.includes(OLDER.answer) === true, 'the loaded turn shows its answer while folded');
  await click('.turn .turn-fold');
  await waitFor('the loaded turn to open', async () => (await count('.turn .step-calls')) === 1);
  check((await textOf('.turn .markdown'))?.includes(OLDER.text) === true, 'the replayed text is drawn');
  check((await count('.calls[data-step="read"] .file-chip')) === 1, 'the replayed read is a step with its file');
  check((await textOf('.turn-footer'))?.includes('$0.0008') === true, 'the replayed turn keeps its cost', await textOf('.turn-footer'));
  check((await textOf('.turn-head .turn-meta')) === 'worked for 4.0s', 'the replayed turn keeps its duration', await textOf('.turn-head .turn-meta'));
  await screenshots('loaded');

  await send(PROMPTS.more);
  await waitFor('the follow-up to finish in the loaded session', async () => (await count('.turn-footer')) === 2);
  check((await textOf('.turn:last-child .markdown'))?.includes(ANSWERS.more) === true, 'the chat continues from the loaded session');

  await titleAction('New Chat');
  await waitFor('a new chat', async () => (await count('.turn')) === 0 && (await count('.empty-state')) === 1);
  check((await header()) === `${project()} / New chat`, 'a new chat starts untitled', await header());
  await vscode.commands.executeCommand('gcode.chat.history');
  await waitFor('the history with both sessions kept', async () => (await titles()).length === 2);
  const turns = await textOf(`[data-session="${OLDER.id}"] .history-meta`);
  check(turns?.includes('2 turns') === true, 'the loaded session kept the follow-up', turns);

  await panel(`(doc.querySelector('[data-session]:not([data-session="${OLDER.id}"]) .history-actions button[title="Move to trash"]').click(), 1)`);
  await waitFor('the confirmation', async () => (await count('.history-row.confirming')) === 1);
  check((await textOf('.history-confirm')) === `Move ${RENAMED} to the trash?`, 'delete asks first', await textOf('.history-confirm'));
  await screenshots('delete');
  await click('.history-row.confirming button', 'Cancel');
  await waitFor('Cancel to keep the session', async () => (await count('.history-row.confirming')) === 0 && (await titles()).length === 2);
  await panel(`(doc.querySelector('[data-session]:not([data-session="${OLDER.id}"]) .history-actions button[title="Move to trash"]').click(), 1)`);
  await click('.history-row.confirming button', 'Move to trash');
  await waitFor('the deleted session to leave the list', async () => (await titles()).join() === OLDER.prompt);

  await ui({ do: 'press', key: 'Escape' });
  await waitFor('Escape to close the history', async () => (await visible('textarea')) && !(await visible('.history')));
}
