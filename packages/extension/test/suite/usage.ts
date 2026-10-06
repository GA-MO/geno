import * as vscode from 'vscode';
import { ANSWERS, PROMPTS, THEMES, type ShownRow, type ShownSpend } from './usage-fixture.js';

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
const footers = () => count('.transcript .turn-footer');
const focused = () => panel<string | null>('doc.activeElement?.dataset.focus ?? null');
const panelWidth = (target: number) => ui<number>({ do: 'resize', width: target });

const turn = (n: number) => `.transcript .turn:nth-of-type(${n})`;

const rows = () =>
  panel<ShownRow[]>(
    `[...doc.querySelectorAll('.usage-card .usage-row')].map((r) => ({ label: r.querySelector('.usage-label').textContent, tokens: r.querySelector('.usage-tokens').textContent, percent: r.querySelector('.usage-percent').textContent, baht: r.querySelector('.usage-baht').textContent, usd: r.querySelector('.usage-usd').textContent }))`,
  );

async function useTheme(theme: string): Promise<void> {
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
  await sleep(1500);
  await vscode.commands.executeCommand('notifications.clearAll');
  await sleep(300);
}

async function screenshots(name: string): Promise<void> {
  await ui({ do: 'pointerAway' });
  await panel(`(doc.querySelector('.usage-card')?.scrollIntoView({ block: 'start' }), 1)`);
  for (const [slug, theme] of Object.entries(THEMES)) {
    await useTheme(theme);
    await ui({ do: 'screenshot', name: `${name}-${slug}` });
  }
  await useTheme(THEMES.dark);
}

async function narrow(name: string): Promise<void> {
  const width = await panelWidth(300);
  check(Math.abs(width - 300) <= 4, 'the panel narrows to about 300px', width);
  await sleep(300);
  const fits = await panel<{ overflow: number; outside: string[]; clipped: string[] }>(
    `(() => {
      const log = doc.querySelector('.transcript');
      const box = log.getBoundingClientRect();
      const all = [...log.querySelectorAll('.usage-card *, .turn-usage')].filter((e) => e.getClientRects().length > 0);
      const outside = all.filter((e) => {
        const r = e.getBoundingClientRect();
        return r.right > box.right + 0.5 || r.left < box.left - 0.5;
      }).map((e) => e.className || e.tagName);
      const clipped = [...log.querySelectorAll('.usage-percent, .usage-tokens, .usage-cost, .usage-tab')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.className);
      return { overflow: log.scrollWidth - log.clientWidth, outside, clipped };
    })()`,
  );
  check(fits.overflow <= 0 && fits.outside.length === 0 && fits.clipped.length === 0, `the breakdown fits at ${width}px`, fits);
  await screenshots(name);
  await panelWidth(420);
}

async function send(text: string): Promise<void> {
  await click('textarea');
  await ui({ do: 'type', text });
  await press('Enter');
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

  await send(PROMPTS.read);
  await waitFor('the first turn to end', async () => (await footers()) === 1);
  check((await textOf(turn(1)))?.includes(ANSWERS.read) === true, 'the first answer shows', await textOf(turn(1)));
  await send(PROMPTS.again);
  await waitFor('the second turn to end', async () => (await footers()) === 2);
  await waitFor('a usage button on each footer', async () => (await count('.turn-footer .turn-usage')) === 2);
  check((await textOf(`${turn(1)} .turn-footer`))?.match(/qwen3\.8-flash.*in.*out.*\$/) !== null, 'the footer still shows model, tokens and cost', await textOf(`${turn(1)} .turn-footer`));

  // The first turn read a file, so its breakdown has the file and the tool result apart from the prompt.
  await click(`${turn(1)} .turn-usage`);
  await waitFor('the turn breakdown', async () => (await count(`${turn(1)} .usage-card .usage-row`)) > 0);
  check((await panel<string>(`doc.querySelector(${JSON.stringify(`${turn(1)} .turn-usage`)}).getAttribute('aria-expanded')`)) === 'true', 'the usage line says it is open');
  const turnRows = await rows();
  const labels = turnRows.map((r) => r.label);
  for (const label of ['Tool definitions', 'System prompt', 'New prompt', 'Earlier replies', 'Files read this turn', 'Output']) check(labels.includes(label), `the turn shows ${label}`, labels);
  const driver = (await textOf(`${turn(1)} .usage-driver`)) ?? '';
  check(/^[A-Z].* (is|are) \d+% of the cost$/.test(driver), 'it names the biggest driver', driver);
  check((await count(`${turn(1)} .usage-row.driver`)) === 1, 'and marks its row');
  check(((await textOf(`${turn(1)} .usage-note`)) ?? '').startsWith("The provider's token count"), 'it says what the numbers rest on');
  check(/^Cache read \S+ · write \S+ · uncached \S+ · output \S+$/.test((await textOf(`${turn(1)} .usage-cache`)) ?? ''), 'and how the input billed', await textOf(`${turn(1)} .usage-cache`));
  await screenshots('turn');
  await narrow('narrow-300-turn');

  await click(`${turn(1)} .usage-tab[data-tab="session"]`);
  await waitFor('the session view', async () => (await count(`${turn(1)} .usage-top-turn`)) === 2);
  const session = await rows();
  const total = (await textOf(`${turn(1)} .usage-session-total`)) ?? '';
  check(/^2 turns · ฿\d+\.\d\d\$/.test(total), 'the session view totals both turns', total);
  const top = await panel<string[]>(`[...doc.querySelectorAll('.usage-top-prompt')].map((e) => e.textContent)`);
  check(top.includes(PROMPTS.read) && top.includes(PROMPTS.again), 'and lists the costliest turns', top);
  await screenshots('session');
  await narrow('narrow-300-session');

  await panel(`(doc.querySelector(${JSON.stringify(`${turn(1)} .usage-tab.selected`)}).focus(), 1)`);
  await press('Escape');
  await waitFor('Escape to close the breakdown', async () => !(await shown('.usage-card')));
  await waitFor('the keyboard back on the usage line', async () => (await focused())?.startsWith('usage:') === true);

  const report: ShownSpend = { turn: turnRows, driver, session, total, top };
  const sent = await fetch(`${model()}/report`, { method: 'POST', body: JSON.stringify(report) });
  check(sent.ok, 'the test took the panel’s numbers');
}
