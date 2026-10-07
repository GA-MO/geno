import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { onMac } from './mac-only.js';
import { THEMES } from './panel-fixture.js';
import { DOCS, GROW_TITLE, LOADING, PROMPTS, SPEED_TITLE } from './widget-fixture.js';

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
  check(response.ok, `ui ${JSON.stringify(action).slice(0, 200)}`, text);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

const panel = <T>(expression: string): Promise<T> => ui<T>({ do: 'eval', expression });
const tab = <T>(expression: string): Promise<T> => ui<T>({ do: 'evalTab', expression });
const widget = <T>(name: string, expression: string): Promise<T> => ui<T>({ do: 'widget', name, expression });
const workbench = <T>(expression: string): Promise<T> => ui<T>({ do: 'workbench', expression });
const click = (selector: string, text?: string) => ui({ do: 'click', selector, ...(text === undefined ? {} : { text }) });
const clickWidget = (name: string, selector: string) => ui({ do: 'clickWidget', name, selector });
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPEED = 'widget-tu_speed';
const GROW = 'widget-tu_grow';

/** The frame's height in the panel, and the height of what the widget drew. */
const heights = async (name: string) => ({
  frame: await panel<number>(`doc.querySelector('iframe[name=${JSON.stringify(name)}]').getBoundingClientRect().height`),
  content: (await widget<number>(name, `Math.ceil(document.getElementById('geno-root').getBoundingClientRect().height)`))!,
});

async function sized(name: string): Promise<{ frame: number; content: number }> {
  let last = { frame: 0, content: -1 };
  await waitFor(`${name} to take its content's height`, async () => {
    last = await heights(name);
    return Math.abs(last.frame - last.content) <= 1 && last.content > 24;
  });
  return last;
}

async function useTheme(theme: string): Promise<void> {
  if (vscode.workspace.getConfiguration('workbench').get('colorTheme') === theme) return;
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
  await sleep(800);
}

async function screenshots(name: string): Promise<void> {
  for (const [slug, theme] of Object.entries(THEMES)) {
    await useTheme(theme);
    await vscode.commands.executeCommand('notifications.clearAll');
    await sleep(500);
    await ui({ do: 'screenshot', name: `${name}-${slug}` });
  }
  await useTheme(THEMES.dark);
}

async function send(prompt: string): Promise<void> {
  await click('textarea');
  await ui({ do: 'type', text: prompt });
  await ui({ do: 'press', key: 'Enter' });
}

const turnsDone = (n: number) => waitFor(`turn ${n} to finish`, async () => (await count('.turn-footer')) === n);

async function openMenu(item: string): Promise<void> {
  await click(`.widget[data-widget="tu_speed"] .widget-more`);
  await waitFor('the menu to open', async () => panel<boolean>(`!doc.querySelector('.widget[data-widget="tu_speed"] .widget-menu').hidden`));
  await click(`.widget[data-widget="tu_speed"] [data-action="${item}"]`);
}

/** Anything the panel's CSP refuses from now on is recorded, so the test can see what it was. */
const recordViolations = () =>
  panel(`(doc.defaultView.violations = [], doc.addEventListener('securitypolicyviolation', (e) =>
    doc.defaultView.violations.push({ directive: e.violatedDirective, blocked: e.blockedURI })), 1)`);

async function checkViolations(): Promise<void> {
  const violations = await panel<{ directive: string; blocked: string }[]>('doc.defaultView.violations');
  check(!violations.some((v) => v.directive.startsWith('script') || v.blocked.startsWith('http')), 'the panel refuses no script and no remote load', violations);
}

const widgetTabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('gcode.widget'));

export async function run(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('gcode.chat.focus');
  for (let i = 0; i < 2; i++) await vscode.commands.executeCommand('workbench.action.decreaseViewWidth');
  await recordViolations();

  // While the model writes: the step, its loading line and the pencil.
  await send(PROMPTS.speed);
  await waitFor('the widget step while the model writes it', async () => (await count('.widget[data-state="drafting"]')) === 1);
  await waitFor('the first loading line', async () => (await panel<string>(`doc.querySelector('.widget-loading-line').textContent`)) === `${LOADING[0]}…`);
  check((await panel<string>(`doc.querySelector('.widget-title').textContent`)) === SPEED_TITLE, 'the step shows the title as soon as it streams');
  await waitFor('the working dino to take its pencil', async () => (await panel<string>(`doc.querySelector('.turn:last-child').dataset.working ?? ''`)) === 'writing');
  check((await count('.widget-frame')) === 0, 'nothing is drawn before the call runs');
  await screenshots('loading');
  await waitFor('the second loading line', async () => (await panel<string>(`doc.querySelector('.widget-loading-line').textContent`)) === `${LOADING[1]}…`, 6000);
  await ui({ do: 'release' });

  // The widget, sized to what it drew, in the panel's theme.
  await turnsDone(1);
  await waitFor('the widget to be drawn', async () => (await count('.widget[data-state="ready"] iframe.widget-frame')) === 1);
  const frameAttrs = await panel<{ sandbox: string; name: string }>(`(() => { const f = doc.querySelector('iframe.widget-frame'); return { sandbox: f.getAttribute('sandbox'), name: f.name }; })()`);
  check(frameAttrs.sandbox === 'allow-scripts' && frameAttrs.name === SPEED, 'the frame is sandboxed with scripts only', frameAttrs);
  await sized(SPEED);
  const look = await widget<Record<string, string>>(
    SPEED,
    `(() => { const s = getComputedStyle(document.documentElement); return { fg: s.getPropertyValue('--fg').trim(), chart: s.getPropertyValue('--chart-1').trim(), scheme: s.colorScheme, rows: String(document.querySelectorAll('tbody tr').length) }; })()`,
  );
  check(look.fg === 'rgb(220, 220, 220)' && look.chart === '#3987e5' && look.scheme === 'dark', 'the widget gets dark glass and the palette', look);
  check(look.rows === '5', "the widget's script ran", look);
  check((await count('.turn:last-child .widget')) === 1 && (await count('.turn-fold')) === 1, 'a compact turn folds its work but keeps the widget in view');
  await widget(SPEED, `(window.alive = 'still the same frame', 1)`);
  await screenshots('widget');
  await useTheme(THEMES.light);
  await waitFor('the widget to take light glass', async () => (await widget<string>(SPEED, `getComputedStyle(document.documentElement).getPropertyValue('--fg').trim()`)) === 'rgb(28, 28, 28)');
  check((await widget<string>(SPEED, 'window.alive')) === 'still the same frame', 'a theme change restyles the frame without loading it again');
  await useTheme(THEMES.dark);

  // The ⋯ menu.
  await click('.widget[data-widget="tu_speed"] .widget-more');
  await waitFor('the menu to open', async () => panel<boolean>(`!doc.querySelector('.widget-menu').hidden`));
  const items = await panel<string[]>(`[...doc.querySelectorAll('.widget-menu-item')].map((i) => i.textContent)`);
  check(JSON.stringify(items) === JSON.stringify(['Copy as Image', 'Save as Page', 'Open in Editor']), 'the menu offers the three actions', items);
  check((await panel<string>(`doc.activeElement.dataset.action`)) === 'copy-image', 'the menu takes the keyboard on its first item');
  await screenshots('menu');
  await ui({ do: 'press', key: 'Escape' });
  await waitFor('Escape to close the menu', async () => panel<boolean>(`doc.querySelector('.widget-menu').hidden && doc.activeElement.classList.contains('widget-more')`));

  // Copy as image puts a PNG on the clipboard.
  await openMenu('copy-image');
  await waitFor('the copy to finish', async () => (await panel<string>(`doc.querySelector('.widget[data-widget="tu_speed"] .widget-head').dataset.flash ?? ''`)) === 'Copied');
  await onMac('the clipboard is read through osascript', async () => {
    const { stdout } = await promisify(execFile)('osascript', ['-e', 'clipboard info']);
    check(stdout.includes('PNGf'), 'the clipboard holds a PNG', stdout);
  });

  // Open in Editor shows it in a tab of its own.
  await openMenu('open');
  await waitFor('the widget tab', async () => widgetTabs().length === 1);
  check(widgetTabs()[0]!.label === SPEED_TITLE, 'the tab is named for the widget', widgetTabs()[0]!.label);
  await waitFor('the tab to draw the widget', async () => (await tab<number>(`doc.querySelectorAll('.widget-stage iframe.widget-frame[sandbox="allow-scripts"]').length`)) === 1);
  await waitFor('the tab frame to take its height', async () => (await tab<number>(`doc.querySelector('.widget-stage iframe').getBoundingClientRect().height`)) > 150);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('gcode.chat.focus');

  // A widget that grows: inline handlers work, the frame follows its content, and links ask first.
  await send(PROMPTS.grow);
  await turnsDone(2);
  await waitFor('the second widget', async () => (await count('.widget[data-state="ready"] iframe')) === 2);
  const before = await sized(GROW);
  await sleep(1000);
  check((await count('.widget-link-ask')) === 0, 'a link the widget sends on its own, without a click in it, asks nothing');
  for (let i = 0; i < 3; i++) await clickWidget(GROW, '#more');
  await waitFor('three rows', async () => (await widget<number>(GROW, `document.querySelectorAll('.row').length`)) === 3);
  const after = await sized(GROW);
  check(after.frame > before.frame + 60, 'the frame grows with its content', { before, after });
  check((await widget<string>(GROW, `getComputedStyle(document.getElementById('swatch')).color`)) === 'rgb(57, 135, 229)', 'the first series color is the palette blue');
  await clickWidget(GROW, '#docs');
  const question = '.widget[data-widget="tu_grow"] .widget-link-ask';
  await waitFor('the link question under the widget', async () => (await panel<string | null>(`doc.querySelector('${question} .widget-link-href')?.textContent ?? null`)) === DOCS);
  check((await panel<string>(`doc.activeElement.dataset.link ?? ''`)) === 'cancel', 'the question takes the keyboard on Cancel');
  await screenshots('link');
  await click(`${question} [data-link="cancel"]`);
  await waitFor('Cancel to close the question', async () => (await count(question)) === 0);
  check(widgetTabs().length === 0, 'cancelling opened nothing');

  // A reload of the panel draws both widgets again, from the transcript.
  await checkViolations();
  await vscode.commands.executeCommand('workbench.action.webview.reloadWebviewAction');
  await sleep(1500);
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('both widgets after the reload', async () => (await count('.widget[data-state="ready"] iframe')) === 2, 30_000);
  await recordViolations();
  await sized(SPEED);
  await sized(GROW);

  // A session loaded from the history draws them from the stored files.
  await vscode.commands.executeCommand('gcode.chat.new');
  await waitFor('an empty chat', async () => (await count('.turn')) === 0);
  await vscode.commands.executeCommand('gcode.chat.history');
  await waitFor('the history', async () => (await count('.history-row:not(.current) .history-open')) === 1);
  await click('.history-row:not(.current) .history-open');
  await waitFor('both widgets in the loaded session', async () => (await count('.widget[data-state="ready"] iframe')) === 2, 30_000);
  await sized(SPEED);
  check((await widget<number>(SPEED, `document.querySelectorAll('tbody tr').length`)) === 5, 'the loaded widget runs its script');
  check((await panel<string>(`doc.querySelectorAll('.widget-title')[1].textContent`)) === GROW_TITLE, 'the loaded widget keeps its title');
  await checkViolations();
}
