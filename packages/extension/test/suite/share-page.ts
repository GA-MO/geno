import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { DIAGRAM, PAGES, PROMPT, WIDGET_TITLE } from './share-page-fixture.js';

const model = () => process.env['GCODE_FAKE_MODEL']!;
const workspace = () => process.env['GCODE_TEST_WORKSPACE']!;

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
  check(response.ok, `ui ${JSON.stringify(action).slice(0, 200)}`, text);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

const panel = <T>(expression: string): Promise<T> => ui<T>({ do: 'eval', expression });
const workbench = <T>(expression: string): Promise<T> => ui<T>({ do: 'workbench', expression });
const click = (selector: string) => ui({ do: 'click', selector });
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shown = (selector: string) => panel<boolean>(`(() => { const e = doc.querySelector(${JSON.stringify(selector)}); return !!e && !e.hidden; })()`);

const page = (file: string) => path.join(workspace(), file);
const exists = (file: string) => stat(page(file)).then(() => true, () => false);
const pages = () => readdir(path.join(workspace(), 'geno-pages')).then((names) => names.sort(), () => []);

const toasts = () => workbench<{ message: string; buttons: string[] }[]>(
  `[...document.querySelectorAll('.notifications-toasts .notification-list-item')].map((item) => ({
    message: item.querySelector('.notification-list-item-message')?.textContent ?? '',
    buttons: [...item.querySelectorAll('.notification-list-item-buttons-container .monaco-button')].map((b) => b.textContent),
  }))`,
);
const REVEAL = process.platform === 'darwin' ? 'Reveal in Finder' : process.platform === 'win32' ? 'Reveal in File Explorer' : 'Open Containing Folder';

async function saved(file: string): Promise<void> {
  await waitFor(`${file} to be written`, () => exists(file));
  await waitFor(`the notice for ${file}`, async () => (await toasts()).some((t) => t.message === `Saved the page to ${file}.`));
  const toast = (await toasts()).find((t) => t.message === `Saved the page to ${file}.`)!;
  check(JSON.stringify(toast.buttons) === JSON.stringify(['Open in Browser', REVEAL]), 'the notice offers Open in Browser and Reveal', toast.buttons);
  await vscode.commands.executeCommand('notifications.clearAll');
}

async function saveWidget(): Promise<void> {
  await click('.widget[data-widget="tu_bars"] .widget-more');
  await waitFor('the widget menu', () => shown('.widget[data-widget="tu_bars"] .widget-menu'));
  await click('.widget[data-widget="tu_bars"] [data-action="save-page"]');
}

export async function run(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('gcode.chat.focus');

  await click('textarea');
  await ui({ do: 'type', text: PROMPT });
  await ui({ do: 'press', key: 'Enter' });
  await waitFor('the turn to finish', async () => (await count('.turn-footer')) === 1);
  await waitFor('the widget to be drawn', async () => (await count('.widget[data-state="ready"] iframe')) === 1);
  await waitFor('the diagram to be drawn', async () => (await count('.diagram[data-state="rendered"]')) === 1);

  // The widget's Save as Page writes its page under geno-pages and offers to open or reveal it.
  await saveWidget();
  await saved(PAGES.widget);
  const widgetPage = await readFile(page(PAGES.widget), 'utf8');
  check(widgetPage.includes(`<title>${WIDGET_TITLE}</title>`) && widgetPage.includes('sandbox="allow-scripts"'), 'the widget page is named for it and frames it in the sandbox', widgetPage.slice(0, 300));

  // The message menu's Save as page writes the answer, with the diagram the panel drew and the workspace image inlined.
  await waitFor('the message menu button', async () => (await count('.turn .rewind-button')) === 1);
  await click('.turn .rewind-button');
  await waitFor('the message menu', () => shown('.turn .rewind-menu'));
  await click('.turn .rewind-menu [data-action="save-page"]');
  await saved(PAGES.answer);
  const answerPage = await readFile(page(PAGES.answer), 'utf8');
  const images = [...answerPage.matchAll(/<img src="(data:image\/svg\+xml;base64,[^"]+)"/g)].map((m) => Buffer.from(m[1]!.split(',')[1]!, 'base64').toString('utf8'));
  check(images.length === 2, 'the page carries the chart and the diagram as SVG data', images.length);
  check(images.some((svg) => svg.includes('cache hits 92%')), 'the chart is the workspace file');
  check(images.some((svg) => svg.startsWith('<svg') && svg.includes('aria-roledescription="flowchart') && svg.includes('Bundle')), 'the diagram is the drawing the panel made', images.map((svg) => svg.slice(0, 160)));
  check(answerPage.includes(`<h1 class="page-title">${PROMPT}</h1>`) && !answerPage.includes('class="request"'), 'the page is titled with the one-line request');
  check(answerPage.includes('<span class="token keyword">export</span>'), 'the page colors code');
  check(!answerPage.includes(DIAGRAM.split('\n')[1]!), 'the drawn diagram replaces its source');

  // A second save of the same widget asks first. VS Code refuses modal dialogs while extension tests run, so here the
  // question goes unanswered, which must write nothing: chooseName's unit tests cover Replace and Keep Both.
  const before = (await stat(page(PAGES.widget))).mtimeMs;
  await saveWidget();
  await sleep(2000);
  check((await readFile(page(PAGES.widget), 'utf8')) === widgetPage && (await stat(page(PAGES.widget))).mtimeMs === before, 'an unanswered question replaces nothing');
  const names = await pages();
  check(JSON.stringify(names) === JSON.stringify(['build-time-by-step.html', 'why-is-the-build-slow.html']), 'and saves nothing beside it', names);
}
