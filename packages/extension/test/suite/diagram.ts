import * as vscode from 'vscode';
import { THEMES } from './panel-fixture.js';
import { BROKEN, FLOW_LABELS, FLOWCHART, PROMPTS, SEQUENCE } from './diagram-fixture.js';
import { SHOOTING } from './shooting.js';

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
const tab = <T>(expression: string): Promise<T> => ui<T>({ do: 'evalTab', expression });
const click = (selector: string, text?: string) => ui({ do: 'click', selector, ...(text === undefined ? {} : { text }) });
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The ids of the drawn SVGs; every drawing gets a new one, so a change means the diagrams were drawn again. */
const drawingIds = () => panel<string[]>(`[...doc.querySelectorAll('.diagram[data-state="rendered"] svg')].map((s) => s.id)`);

async function redrawn(what: string, before: readonly string[]): Promise<void> {
  await waitFor(what, async () => {
    const ids = await drawingIds();
    return ids.length === before.length && ids.every((id, i) => id !== before[i]);
  });
}

/** Every label of a flowchart node, with its text's box and its shape's box on screen, so the test can see that each fits. */
const FLOW_NODES = `[...doc.querySelectorAll('.diagram[data-state="rendered"] svg')].find((s) => s.getAttribute('aria-roledescription') === 'flowchart-v2')
  ?.querySelectorAll('.node') ?? []`;
const nodeBoxes = () =>
  panel<{ text: string; label: DOMRect; shape: DOMRect }[]>(`[...${FLOW_NODES}].map((n) => {
    const box = (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
    return { text: n.textContent.replace(/\\s+/g, ''), label: box(n.querySelector('text')), shape: box(n.querySelector('rect, polygon, path')) };
  })`);

/** Switches the color theme and waits for the drawn diagrams to be drawn again in it. */
async function useTheme(theme: string): Promise<void> {
  if (vscode.workspace.getConfiguration('workbench').get('colorTheme') === theme) return;
  const before = await drawingIds();
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
  if (before.length > 0) await redrawn(`the diagrams to redraw in ${theme}`, before);
}

async function screenshots(name: string): Promise<void> {
  if (!SHOOTING) return;
  for (const [slug, theme] of Object.entries(THEMES)) {
    await useTheme(theme);
    await sleep(800);
    await vscode.commands.executeCommand('notifications.clearAll');
    await sleep(300);
    await ui({ do: 'screenshot', name: `${name}-${slug}` });
  }
  await useTheme(THEMES.dark);
}

async function send(prompt: string, turns: number): Promise<void> {
  await click('textarea');
  await ui({ do: 'type', text: prompt });
  await ui({ do: 'press', key: 'Enter' });
  await waitFor(`turn ${turns} to finish`, async () => (await count('.turn-footer')) === turns);
}

const diagramTabs = () =>
  vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('gcode.diagram'));

export async function run(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('gcode.chat.focus');
  for (let i = 0; i < 5; i++) await vscode.commands.executeCommand('workbench.action.decreaseViewWidth');

  // Anything the panel's CSP refuses from here on is recorded, so the test can see what it was.
  await panel(`(doc.defaultView.violations = [], doc.addEventListener('securitypolicyviolation', (e) =>
    doc.defaultView.violations.push({ directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile, sample: e.sample })), 1)`);
  const diagramLoads = () => panel<string[]>(`doc.defaultView.performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/dist/diagram/'))`);
  check((await diagramLoads()).length === 0, 'the diagram library is not loaded before a diagram arrives', await diagramLoads());

  await send(PROMPTS.flowchart, 1);
  await waitFor('the flowchart to be drawn', async () => (await count('.diagram[data-state="rendered"] svg')) === 1);
  const loads = await diagramLoads();
  check(loads.some((n) => n.endsWith('/dist/diagram/render.js')), 'the first diagram loads the diagram chunk', loads);
  const boxes = await nodeBoxes();
  check(boxes.length === FLOW_LABELS.length, 'the flowchart draws a node per step', boxes.map((b) => b.text));
  for (const label of FLOW_LABELS) check(boxes.some((b) => b.text === label.replace(/\s+/g, '')), `the flowchart shows "${label}"`, boxes.map((b) => b.text));
  for (const { text, label, shape } of boxes) {
    const inside = label.x >= shape.x - 1 && label.y >= shape.y - 1 && label.x + label.width <= shape.x + shape.width + 1 && label.y + label.height <= shape.y + shape.height + 1;
    check(inside, `the label "${text}" fits inside its node`, { label, shape });
  }
  const fill = await panel<string>(`getComputedStyle(doc.querySelector('.diagram svg .node rect')).fill`);
  check(fill !== 'rgb(0, 0, 0)' && fill !== 'none', 'the node fill comes from the theme', fill);
  check((await panel<string>(`doc.querySelector('.diagram').getAttribute('aria-label')`)) === 'Flowchart', 'the diagram is labelled by its type');
  check((await count('.markdown p')) >= 2, 'the text around the diagram renders as markdown');

  await send(PROMPTS.sequence, 2);
  await waitFor('the sequence diagram to be drawn', async () => (await count('.diagram[data-state="rendered"] svg')) === 2);
  const sequence = await panel<{ actors: string[]; messages: string[] }>(`(() => {
    const svg = doc.querySelectorAll('.diagram[data-state="rendered"] svg')[1];
    return {
      actors: [...new Set([...svg.querySelectorAll('text.actor')].map((t) => t.textContent.trim()))],
      messages: [...svg.querySelectorAll('.messageText')].map((t) => t.textContent.trim()),
    };
  })()`);
  check(['Webview', 'Extension', 'Engine', 'Model', 'Session log'].every((a) => sequence.actors.includes(a)), 'the sequence diagram shows every participant', sequence.actors);
  check(sequence.messages.length === 8 && sequence.messages[0] === 'send(text)', 'the sequence diagram shows every message in order', sequence.messages);

  const scales = await panel<number[]>(`[...doc.querySelectorAll('.diagram[data-state="rendered"] svg')].map((s) => s.getBoundingClientRect().width / s.viewBox.baseVal.width)`);
  check(scales.every((scale) => scale >= 0.74), 'no diagram shrinks below three quarters of its size', scales);

  await send(PROMPTS.broken, 3);
  await waitFor('the broken diagram to fail', async () => (await count('.diagram[data-state="failed"]')) === 1);
  const failed = await panel<{ code: string; note: string; svgs: number }>(`(() => {
    const d = doc.querySelector('.diagram[data-state="failed"]');
    return { code: d.querySelector('.code-block code').textContent, note: d.querySelector('.diagram-error').textContent, svgs: d.querySelectorAll('svg').length };
  })()`);
  check(failed.code === BROKEN, 'a broken diagram shows its source as a code block', failed.code);
  check(/^Could not draw this diagram: Parse error on line \d/.test(failed.note), 'a broken diagram says why in a muted line', failed.note);
  check(failed.svgs === 0, 'a broken diagram draws nothing', failed.svgs);
  check((await count('.diagram[data-state="rendered"]')) === 2, 'a broken diagram leaves the others drawn');

  await click('.diagram[data-state="rendered"] .diagram-toolbar .copy');
  await waitFor('the copy button to put the flowchart source on the clipboard', async () => (await vscode.env.clipboard.readText()) === FLOWCHART);

  const ids = await drawingIds();
  await vscode.commands.executeCommand('gcode.chat.focus');
  await vscode.commands.executeCommand('workbench.action.decreaseViewWidth');
  await redrawn('the diagrams to redraw when the panel is resized', ids);

  await screenshots('diagrams');
  await panel(`(doc.querySelectorAll('.turn')[1].scrollIntoView(), 1)`);
  await screenshots('sequence');
  await panel(`(doc.querySelectorAll('.turn')[2].scrollIntoView(), 1)`);
  await screenshots('broken');

  await click('.diagram[data-state="rendered"] .diagram-toolbar .open');
  await waitFor('the flowchart to open in an editor tab', async () => diagramTabs().length === 1);
  check(diagramTabs()[0]!.label === 'Flowchart', 'the tab is named for the diagram type', diagramTabs()[0]!.label);
  await waitFor('the tab to draw the diagram', () => tab<boolean>(`doc.querySelector('.diagram-stage .diagram[data-state="rendered"] svg') !== null`));
  check((await tab<string>(`doc.querySelector('.zoom-level').textContent`)) === 'Fit', 'the tab starts fitted');
  await ui({ do: 'clickTab', selector: '.zoom-level' });
  await waitFor('the zoom to switch to actual size', async () => (await tab<string>(`doc.querySelector('.zoom-level').textContent`)) === '100%');
  const actual = await tab<{ shown: number; natural: number }>(`(() => { const s = doc.querySelector('.diagram-stage svg'); return { shown: s.getBoundingClientRect().width, natural: s.viewBox.baseVal.width }; })()`);
  check(Math.abs(actual.shown - actual.natural) < 1, 'actual size shows the drawing at its natural width', actual);
  await ui({ do: 'clickTab', selector: 'button[aria-label="Zoom in"]' });
  await waitFor('zoom in to enlarge the drawing', async () => (await tab<string>(`doc.querySelector('.zoom-level').textContent`)) === '150%');
  await ui({ do: 'clickTab', selector: '.zoom-level' });
  await sleep(500);
  await ui({ do: 'screenshot', name: 'tab-dark' });
  await click('.diagram[data-state="rendered"] .diagram-toolbar .open');
  await sleep(500);
  check(diagramTabs().length === 1, 'opening the same diagram again shows its tab instead of another');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');

  const violations = await panel<{ directive: string; blocked: string; source: string; sample: string }[]>('doc.defaultView.violations');
  check(
    violations.every((v) => v.directive === 'style-src-elem' && v.blocked === 'inline' && v.source.includes('/dist/diagram/')),
    'the CSP refuses nothing but the style elements of the parse DOMPurify does in an inert document',
    violations,
  );
  check(!violations.some((v) => v.directive.startsWith('script') || v.blocked.startsWith('http')), 'no script or remote load is refused');
}
