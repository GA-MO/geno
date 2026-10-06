import * as vscode from 'vscode';
import { ANSWERS, MARKER, PROMPTS, THEMES } from './compact-fixture.js';

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
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
const textOf = (selector: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const attr = (selector: string, name: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)}) ?? null`);
const shown = (selector: string) => panel<boolean>(`(() => { const e = doc.querySelector(${JSON.stringify(selector)}); return e !== null && e.getClientRects().length > 0; })()`);
const turns = () => count('.transcript .turn');
const footers = () => count('.transcript .turn-footer');
const panelWidth = (target: number) => ui<number>({ do: 'resize', width: target });
const turn = (n: number) => `.transcript .turn:nth-of-type(${n})`;

const dropUris = (uris: readonly string[]) =>
  panel(`(() => {
    const w = doc.defaultView;
    const data = new w.DataTransfer();
    data.setData('text/uri-list', ${JSON.stringify(uris.join('\r\n'))});
    const form = doc.querySelector('.composer');
    form.dispatchEvent(new w.DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
    form.dispatchEvent(new w.DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    return 1;
  })()`);

type Divider = { readonly title: string; readonly numbers: string; readonly expanded: string | null; readonly isButton: boolean; readonly body: string; readonly summaryHeads: readonly string[]; readonly rail: readonly string[] };

/** The divider of turn `n` as the user sees it, and the turn's rail of step kinds. */
const dividerOf = (n: number) =>
  panel<Divider | null>(`(() => {
    const t = doc.querySelector(${JSON.stringify(turn(n))});
    const d = t?.querySelector('.compact');
    if (!d) return null;
    const head = d.querySelector('.compact-head');
    const body = d.querySelector('.compact-body');
    return {
      title: d.querySelector('.compact-title').textContent,
      numbers: d.querySelector('.compact-numbers').textContent,
      expanded: head.getAttribute('aria-expanded'),
      isButton: head.tagName === 'BUTTON',
      body: body.getClientRects().length > 0 ? body.innerText : '',
      summaryHeads: [...d.querySelectorAll('.compact-summary h2')].map((e) => e.textContent),
      rail: [...t.querySelectorAll(':scope > .rail > .step')].map((s) => [...s.classList].find((c) => c.startsWith('step-') && c !== 'step').slice(5)),
    };
  })()`);

/** "850,012 → about 21,403 tokens" as its two numbers. */
const countsOf = (numbers: string): readonly [number, number] => {
  const match = /^([\d,]+) → about ([\d,]+) tokens$/.exec(numbers);
  check(match !== null, 'the divider gives the counts before and about after', numbers);
  return [Number(match![1]!.replaceAll(',', '')), Number(match![2]!.replaceAll(',', ''))];
};

const offer = () =>
  panel<{ shown: boolean; text: string; disabled: string | null; title: string; ring: string; ringShown: boolean } | null>(`(() => {
    const b = doc.querySelector('.compact-offer');
    return b && { shown: b.getClientRects().length > 0, text: b.textContent, disabled: b.getAttribute('aria-disabled'), title: b.title, ring: doc.querySelector('.context-ring[role="img"]').title, ringShown: doc.querySelector('.context-ring[role="img"]').getClientRects().length > 0 };
  })()`);

/** Model text in the transcript that is the compaction's words for other clients: the panel must draw only the divider. */
const fallbackShown = () => panel<boolean>(`[...doc.querySelectorAll('.transcript .markdown')].some((e) => e.textContent.includes('[Context compacted'))`);

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

/** At about 300px, what `selector` matches stays inside the panel, with no sideways scroll. */
async function fitsAt300(selector: string, name: string): Promise<void> {
  const width = await panelWidth(300);
  check(Math.abs(width - 300) <= 4, 'the panel narrows to about 300px', width);
  await sleep(300);
  const fits = await panel<{ overflow: number; outside: string[] }>(
    `(() => {
      const log = doc.querySelector('.transcript');
      const box = doc.body.getBoundingClientRect();
      const parts = [...doc.querySelectorAll(${JSON.stringify(`${selector}, ${selector} *`)})].filter((e) => e.getClientRects().length > 0);
      const outside = parts.filter((e) => { const r = e.getBoundingClientRect(); return r.right > box.right + 0.5 || r.left < box.left - 0.5; }).map((e) => e.className || e.tagName);
      return { overflow: log.scrollWidth - log.clientWidth, outside };
    })()`,
  );
  check(fits.overflow <= 0 && fits.outside.length === 0, `${selector} fits at ${width}px`, fits);
  await screenshots(name);
  await panelWidth(420);
}

async function type(text: string): Promise<void> {
  await click('textarea');
  await ui({ do: 'type', text });
}

async function send(text: string): Promise<void> {
  await type(text);
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
  check((await offer())?.shown === false, 'a new chat offers no Compact', await offer());

  const log = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, 'build.log');
  await dropUris([log.toString()]);
  await waitFor('the build log to be attached', async () => (await count('.attachment-chip.attachment-ready')) === 1);
  await send(`${PROMPTS.first}`);
  await waitFor('the first turn to finish', async () => (await footers()) === 1);
  const high = await offer();
  check(high?.shown === true && !high.ringShown && high.text === 'Compact' && high.disabled === null, 'past 80% the ring becomes the Compact button', high);
  check(/^Context: 850,\d{3} of 1,000,000 tokens \(85%\)\. Compact summarizes the older turns to free it\.$/.test(high!.title), 'its tooltip keeps the numbers', high!.title);
  await screenshots('ring-compact');
  await fitsAt300('.input-toolbar', 'narrow-300-ring-compact');

  await type('a draft Compact must keep');
  await click('.compact-offer');
  await waitFor('the /compact turn', async () => (await turns()) === 2);
  check((await textOf(`${turn(2)} .request-bubble .command-chip`)) === '/compact', 'it runs as /compact, with its chip', await textOf(`${turn(2)} .request-bubble`));
  check((await attr(`${turn(2)} .command-chip`, 'data-route')) === 'engine', 'routed to the engine');
  check((await panel<string>(`doc.querySelector('textarea').value`)) === 'a draft Compact must keep', 'the draft stays', await panel<string>(`doc.querySelector('textarea').value`));
  await waitFor('the passing notice', async () => (await textOf(`${turn(2)} .turn-notice`)) === 'Compacting the context');
  const held = await offer();
  check(held?.disabled === 'true' && /^Context: 850,[0-9]{3} of 1,000,000 tokens \(85%\)\. A turn is running\./.test(held.title), 'while it runs, Compact is held with its reason', held);
  await ui({ do: 'release', name: 'manual' });
  await waitFor('the /compact turn to finish', async () => (await footers()) === 2);
  await panel(`(() => { const t = doc.querySelector('textarea'); t.value = ''; t.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true })); return 1; })()`);

  const manual = await dividerOf(2);
  check(manual !== null && manual.title === 'Context compacted' && manual.isButton && manual.expanded === 'false', 'the divider lands, folded, as a button', manual);
  const [before, after] = countsOf(manual!.numbers);
  check(before >= 850_000 && after < 40_000, 'the counts drop from the 85% the ring showed', manual!.numbers);
  check(manual!.rail.join() === 'compact', 'the /compact turn holds the divider alone', manual!.rail);
  check((await count(`${turn(2)} .turn-notice`)) === 0, 'the divider ends the notice');
  check(!(await fallbackShown()), "the chunk's words for other clients are not drawn as model text");
  await waitFor('the plain ring to come back', async () => (await offer())?.shown === false && (await offer())?.ringShown === true);
  check(/^Context: [\d,]+ of 1,000,000 tokens \([0-4]%\)$/.test((await offer())!.ring), 'the ring shows the smaller context', (await offer())!.ring);
  await screenshots('divider');

  await click(`${turn(2)} .compact-head`);
  await waitFor('the divider to open', async () => (await dividerOf(2))?.expanded === 'true');
  const opened = (await dividerOf(2))!;
  check(opened.summaryHeads.join() === 'Goal,Progress,Decisions,Next steps', 'the summary renders as markdown', opened);
  check(opened.body.includes('Read build.log and a.ts; the build is clean.'), 'with the summary text', opened.body);
  check(/Read\s*a\.ts/.test(opened.body), 'and the files read', opened.body);
  await screenshots('divider-open');
  await fitsAt300(`${turn(2)} .compact`, 'narrow-300-divider-open');

  await panel(`(doc.querySelector(${JSON.stringify(`${turn(2)} .compact-head`)}).focus(), 1)`);
  await press('Enter');
  await waitFor('Enter to fold it', async () => (await dividerOf(2))?.expanded === 'false');
  check(!(await shown(`${turn(2)} .compact-body`)), 'folded, the summary hides');
  await press('Space');
  await waitFor('Space to open it', async () => (await dividerOf(2))?.expanded === 'true');
  await press('Space');
  await waitFor('and fold it again', async () => (await dividerOf(2))?.expanded === 'false');

  await send(PROMPTS.logs);
  await waitFor('the logs turn to finish', async () => (await footers()) === 3);
  check((await dividerOf(3)) === null, 'reading the logs fits under the threshold');
  await send(PROMPTS.next);
  await waitFor('the auto compaction notice', async () => (await textOf(`${turn(4)} .turn-notice`)) === 'Compacting the context');
  await ui({ do: 'release', name: 'auto' });
  await waitFor('the last turn to finish', async () => (await footers()) === 4);
  const auto = (await dividerOf(4))!;
  check(auto !== null && auto.rail.join() === 'compact,text', 'the auto compaction shows inside its turn, before the answer', auto);
  const [autoBefore, autoAfter] = countsOf(auto.numbers);
  check(autoBefore >= 45_000 && autoAfter < autoBefore, 'from what the last call measured to less', auto.numbers);
  await click(`${turn(4)} .compact-head`);
  await waitFor('the auto divider to open', async () => (await dividerOf(4))?.expanded === 'true');
  check((await dividerOf(4))!.body.startsWith('Geno compacted on its own before the context filled.'), 'it says Geno compacted on its own', (await dividerOf(4))!.body);
  check((await textOf(`${turn(4)} .step-text .markdown`))?.includes(ANSWERS.next) === true, 'the answer follows it');
  await click(`${turn(4)} .compact-head`);
  check(!(await fallbackShown()), 'no divider shows as model text');

  // A reload, by way of the history: the replay draws the same dividers in the same turns.
  await vscode.commands.executeCommand('gcode.chat.new');
  await waitFor('a new chat', async () => (await turns()) === 0);
  await vscode.commands.executeCommand('gcode.chat.history');
  await waitFor('the session in the history', async () => (await count('.history-row')) >= 1);
  await panel(`([...doc.querySelectorAll('.history-row')].find((r) => r.querySelector('.history-row-title')?.textContent.includes(${JSON.stringify(MARKER)})).querySelector('.history-open').click(), 1)`);
  await waitFor('the session to load', async () => (await turns()) === 4 && (await footers()) === 4);
  check((await textOf(`${turn(2)} .request-bubble .command-chip`)) === '/compact', 'the /compact turn replays with its chip');
  const replayedManual = (await dividerOf(2))!;
  check(replayedManual.numbers === manual!.numbers && replayedManual.rail.join() === 'compact', 'the replay draws the same /compact divider', replayedManual);
  const replayedAuto = (await dividerOf(4))!;
  check(replayedAuto.numbers === auto.numbers && replayedAuto.rail.join() === 'compact,text', 'and the same auto divider inside its turn', replayedAuto);
  check((await count('.transcript .compact')) === 2, 'and no other');
  check(!(await fallbackShown()), 'the replay draws no divider as model text');
  await click(`${turn(2)} .compact-head`);
  await waitFor('the replayed divider to open', async () => (await dividerOf(2))?.expanded === 'true');
  check((await dividerOf(2))!.summaryHeads.join() === 'Goal,Progress,Decisions,Next steps', 'opened, the replay shows the same summary');
}
