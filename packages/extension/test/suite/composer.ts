import * as vscode from 'vscode';
import { PROMPTS, THEMES } from './composer-fixture.js';
import { panelWidth, rowFits } from './lanes-ui.js';

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
const textOf = (selector: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
/** Shown: in the layout and not inside anything hidden. */
const shown = (selector: string) => panel<boolean>(`(() => { const e = doc.querySelector(${JSON.stringify(selector)}); return e !== null && e.getClientRects().length > 0; })()`);
const attr = (selector: string, name: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)}) ?? null`);
const draft = () => panel<string>('doc.querySelector("textarea").value');
const turns = () => count('.turn');
const footers = () => count('.turn-footer');
const trayChips = () =>
  panel<string[]>(`[...doc.querySelectorAll('.tray .tray-chip:not([hidden]), .tray .attachment-chip')].map((c) => c.classList.contains('browser-chip') ? 'browser' : c.classList.contains('queued-chip') ? 'queued' : c.dataset.attachment)`);

/** Narrows the panel to about 300px, screenshots the row as `name`, checks nothing in it overlaps, and widens it again. */
async function rowAt300(name: string): Promise<void> {
  const before = await panel<number>('doc.defaultView.innerWidth');
  const narrow = await panelWidth(300);
  check(Math.abs(narrow - 300) <= 4, 'the panel narrows to about 300px', narrow);
  await sleep(300);
  await screenshots(name);
  const row = await rowFits();
  check(row.fits, `nothing in the ${name} row overlaps or leaves it at ${narrow}px`, row);
  await panelWidth(before);
  await sleep(300);
}

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

/** Types into the composer as a user would, after a click into it. */
async function typeDraft(text: string): Promise<void> {
  await click('textarea');
  await ui({ do: 'type', text });
}

async function clear(): Promise<void> {
  await click('textarea');
  await ui({ do: 'press', key: 'selectAll', modifiers: ['meta'] });
  await ui({ do: 'press', key: 'Backspace' });
}

/** A key the textarea gets from an IME, which the page cannot tell from a typed one but by its flags. */
const imeEnter = (isComposing: boolean) =>
  panel(`doc.querySelector('textarea').dispatchEvent(new (doc.defaultView.KeyboardEvent)('keydown', { key: 'Enter', isComposing: ${isComposing}, bubbles: true, cancelable: true }))`);
const composition = (type: 'compositionstart' | 'compositionend') =>
  panel(`doc.querySelector('textarea').dispatchEvent(new (doc.defaultView.CompositionEvent)('${type}', { data: 'สวัสดี', bubbles: true }))`);

const paste = (name: string, base64: string, type: string) =>
  panel(`(() => {
    const w = doc.defaultView;
    const bytes = Uint8Array.from(w.atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0));
    const data = new w.DataTransfer();
    data.items.add(new w.File([bytes], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} }));
    doc.querySelector('textarea').dispatchEvent(new w.ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    return 1;
  })()`);

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

/** A 1034×1239 screenshot-sized PNG, drawn by the panel itself so the fixture needs no binary file. */
const screenshotPng = () =>
  panel<string>(`(() => {
    const c = doc.createElement('canvas');
    c.width = 1034;
    c.height = 1239;
    const g = c.getContext('2d');
    g.fillStyle = '#1d3557';
    g.fillRect(0, 0, 1034, 1239);
    g.fillStyle = '#f4f1ea';
    g.fillRect(80, 80, 874, 300);
    return c.toDataURL('image/png').split(',')[1];
  })()`);

export async function run(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  for (let i = 0; i < 5; i++) await vscode.commands.executeCommand('workbench.action.decreaseViewWidth');

  // Idle: the bottom row, left to right, then right.
  const row = await panel<{ left: string[]; right: string[] }>(
    `({ left: [...doc.querySelectorAll('.toolbar-left > *')].map((e) => e.className.split(' ').at(-1)), right: [...doc.querySelectorAll('.toolbar-right > *:not([hidden])')].map((e) => e.className.split(' ').at(-1)) })`,
  );
  check(row.left.join() === 'context-add,slash-button,mode-picker', '+, / and the mode sit bottom left', row.left);
  check(row.right.join() === 'context-ring,composer-model,send-more,send', 'the ring, the model, the send menu and Send sit bottom right', row.right);
  check(!(await shown('.tray')), 'the tray hides while it holds nothing');
  check((await attr('textarea', 'placeholder')) === 'Describe the change you want, @ to add context, / for commands', 'the empty chat asks for a change');
  check((await attr('.context-ring', 'aria-label')) === 'Context: nothing yet', 'the ring is empty before any call', await attr('.context-ring', 'aria-label'));
  check((await textOf('.model-name')) === 'qwen3.8-flash', 'the model button names the model', await textOf('.model-name'));
  check(!(await shown('.model-effort')), 'a chat with no session yet names no effort');
  check((await textOf('.mode-picker .mode-name')) === 'Auto', 'the mode pill reads Auto', await textOf('.mode-picker .mode-name'));

  await click('.context-add');
  await waitFor('+ to open the @ menu with Attach file…', async () => (await panel<string | null>(`doc.querySelector('.mention')?.dataset.action ?? null`)) === 'attach');
  await ui({ do: 'press', key: 'Escape' });
  await clear();
  await click('.slash-button');
  await waitFor('/ to open the command picker', async () => (await count('.command-option')) > 0);
  check((await draft()) === '/', 'the / button starts the draft with /', await draft());
  check((await panel<boolean>('doc.activeElement === doc.querySelector("textarea")')), 'the picker keeps the keyboard in the composer');
  await ui({ do: 'type', text: 'hist' });
  await waitFor('typing to filter the picker', async () => (await panel<string[]>(`[...doc.querySelectorAll('.command-option')].map((o) => o.dataset.command)`)).join() === 'history');
  await ui({ do: 'press', key: 'Escape' });
  await clear();
  await typeDraft('fix the header');
  await click('.slash-button');
  check((await draft()) === '/ fix the header', 'with a draft, / goes in front of it', await draft());
  await clear();

  // An IME's Enter commits its composition, and never sends.
  await typeDraft('สวัสดี');
  await composition('compositionstart');
  await imeEnter(true);
  await imeEnter(false);
  await sleep(500);
  check((await turns()) === 0 && (await draft()) === 'สวัสดี', 'Enter while an IME composes sends nothing', { turns: await turns(), draft: await draft() });
  await composition('compositionend');
  await ui({ do: 'press', key: 'Enter', modifiers: ['shift'] });
  check((await draft()) === 'สวัสดี\n', 'Shift+Enter still makes a newline', await draft());
  await clear();

  // One menu for model and effort.
  await click('.composer-model');
  await waitFor('the model menu', async () => await shown('#model-menu'));
  await waitFor('the session to offer its efforts', async () => (await count('#model-menu [data-effort]')) > 0);
  check((await textOf('.model-effort')) === 'Medium', 'the effort shows beside the model', await textOf('.model-effort'));
  const menu = await panel<{ models: string[]; efforts: string[]; note: string | null; focused: string | null }>(
    `({ models: [...doc.querySelectorAll('#model-menu [data-model]')].map((e) => e.dataset.provider + '/' + e.dataset.model + ':' + e.getAttribute('aria-checked')),
        efforts: [...doc.querySelectorAll('#model-menu [data-effort]')].map((e) => e.dataset.effort + ':' + e.getAttribute('aria-checked')),
        note: doc.querySelector('#model-menu .menu-note')?.textContent ?? null,
        focused: doc.activeElement?.dataset.model ?? null })`,
  );
  check(menu.models.join() === 'modelstudio/qwen3.8-flash:true,modelstudio/qwen3.7-plus:false', 'the menu offers the ready provider\'s models, the current one checked', menu.models);
  check(menu.efforts.join() === 'low:false,medium:true,high:false,xhigh:false,max:false', 'and the efforts the engine offers', menu.efforts);
  check(menu.note === 'A change mid-chat rewrites Model Studio’s cache once.', 'with U21\'s note on the cache', menu.note);
  check(menu.focused === 'qwen3.8-flash', 'the current model takes the keyboard', menu.focused);
  await screenshots('menu');
  await ui({ do: 'press', key: 'Escape' });
  check(!(await shown('#model-menu')), 'Escape closes the menu');
  await click('.composer-model');
  await click('#model-menu [data-effort="high"]');
  await waitFor('the engine to take the effort', async () => (await textOf('.model-effort')) === 'High');
  await click('.composer-model');
  await click('#model-menu [data-action="models"]');
  await waitFor('Models and Keys to open', async () => (await panel<string>('doc.body.dataset.view')) === 'settings');
  await ui({ do: 'press', key: 'Escape' });
  await waitFor('the chat again', async () => (await panel<string>('doc.body.dataset.view')) === 'chat');
  await screenshots('idle');
  await rowAt300('idle-300');

  // The browser and attachments in the tray.
  await typeDraft(PROMPTS.browse);
  await ui({ do: 'press', key: 'Enter' });
  await waitFor('the browser turn to finish', async () => (await footers()) === 1);
  const host = process.env['GCODE_PAGE_HOST']!;
  await waitFor('the browser chip', async () => (await textOf('.browser-chip:not([hidden]) .tray-label')) === `Browser · ${host}`);
  check((await panel<boolean>(`getComputedStyle(doc.querySelector('.browser-globe')).color !== getComputedStyle(doc.querySelector('.browser-chip')).color`)), 'the globe is green');
  check((await attr('.context-ring', 'aria-label')) === 'Context: 1,042 of 1,000,000 tokens (0%)', 'the ring gives the context after the last call', await attr('.context-ring', 'aria-label'));
  await paste('Screenshot 1.png', await screenshotPng(), 'image/png');
  await dropUris([vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, 'notes.md').toString()]);
  await waitFor('two attachments ready', async () => (await panel<number>(`doc.querySelectorAll('.attachment-chip.attachment-ready').length`)) === 2);
  check((await trayChips()).join() === 'browser,Screenshot 1.png,notes.md', 'the tray holds the browser, the image and the file in one row', await trayChips());
  const image = await textOf('.attachment-chip[data-attachment="Screenshot 1.png"] .attachment-detail');
  check(image === '1034×1239', 'the image chip gives its dimensions', image);
  const sideways = await panel<{ rows: number; scrolls: string }>(
    `(() => { const t = doc.querySelector('.tray'); const tops = new Set([...t.querySelectorAll('.tray-chip:not([hidden]), .attachment-chip')].map((c) => Math.round(c.getBoundingClientRect().top))); return { rows: tops.size, scrolls: getComputedStyle(t).overflowX }; })()`,
  );
  check(sideways.rows === 1 && sideways.scrolls === 'auto', 'the chips stay in one row that scrolls sideways', sideways);
  await screenshots('attachments');
  await click('.attachment-chip[data-attachment="Screenshot 1.png"] .chip-remove');
  await click('.attachment-chip[data-attachment="notes.md"] .chip-remove');

  // Running: time, cost, Stop, and a follow-up queued.
  await typeDraft(PROMPTS.run);
  await ui({ do: 'press', key: 'Enter' });
  await waitFor('the running status', async () => await shown('.run-status'));
  check(await shown('button.stop'), 'Stop replaces Send');
  check(!(await shown('button.send')), 'and Send hides');
  check((await attr('textarea', 'placeholder')) === 'Queue a follow-up…', 'the placeholder offers a queued follow-up', await attr('textarea', 'placeholder'));
  check((await count('.activity-pill')) === 0, 'no pill while only the chat itself runs', await count('.activity-pill'));
  const first = await textOf('.run-elapsed');
  await waitFor('the clock to tick', async () => (await textOf('.run-elapsed')) !== first, 5000);
  check(/^0:0\d$/.test((await textOf('.run-elapsed'))!), 'the clock reads minutes and seconds', await textOf('.run-elapsed'));
  await waitFor('the cost after the first call', async () => await shown('.run-cost'));
  const cost = await panel<{ text: string; title: string }>(`({ text: doc.querySelector('.run-cost').textContent, title: doc.querySelector('.run-cost').title })`);
  check(/^(<฿0\.01|฿\d+\.\d\d)$/.test(cost.text) && /^\$0\.\d{4} at ฿33 to the US dollar$/.test(cost.title), 'the cost shows in baht with USD in the tooltip', cost);
  check((await attr('.context-ring', 'aria-label')) === 'Context: 1,030 of 1,000,000 tokens (0%)', 'the ring follows each call', await attr('.context-ring', 'aria-label'));
  await typeDraft(PROMPTS.queued);
  await ui({ do: 'press', key: 'Enter' });
  await waitFor('the queued chip', async () => (await textOf('.queued-chip:not([hidden]) .tray-label')) === PROMPTS.queued);
  check((await draft()) === '' && (await turns()) === 2, 'queuing empties the composer and starts no turn', { draft: await draft(), turns: await turns() });
  await screenshots('running');
  await rowAt300('running-300');
  await ui({ do: 'release' });
  await waitFor('the queued follow-up to go once the turn finishes', async () => (await turns()) === 3 && (await footers()) === 3);
  check((await textOf('.turn:last-of-type .request-bubble')) === PROMPTS.queued, 'the follow-up was sent as typed', await textOf('.turn:last-of-type .request-bubble'));
  check(!(await shown('.queued-chip')) && !(await shown('.run-status')), 'the queue and the running status clear');

  // A stopped turn gives its queued follow-up back to the composer.
  await typeDraft(PROMPTS.stalled);
  await ui({ do: 'press', key: 'Enter' });
  await waitFor('the stalled turn', async () => await shown('button.stop'));
  await typeDraft(PROMPTS.stalledQueue);
  await ui({ do: 'press', key: 'Enter' });
  await waitFor('the queued chip again', async () => await shown('.queued-chip'));
  await click('button.stop');
  await waitFor('the follow-up back in the composer', async () => (await draft()) === PROMPTS.stalledQueue);
  check((await turns()) === 4, 'a stopped turn sends no queued follow-up', await turns());
  await clear();

  // The browser chip's × turns the browser off, as the MCP pane's switch does.
  await click('.browser-chip .chip-remove');
  await waitFor('the browser chip to leave', async () => !(await shown('.browser-chip')));
  check(vscode.workspace.getConfiguration('gcode').get('browser.enabled') === false, 'it writes gcode.browser.enabled');

  // /model opens Models and Keys.
  await typeDraft('/model');
  await ui({ do: 'press', key: 'Enter' });
  await waitFor('/model to open Models and Keys', async () => (await panel<string>('doc.body.dataset.view')) === 'settings');
  await ui({ do: 'press', key: 'Escape' });

  // Choosing another model writes the chat role.
  await click('.composer-model');
  await click('#model-menu [data-model="qwen3.7-plus"]');
  await waitFor('the model setting', async () => vscode.workspace.getConfiguration('gcode').get('model') === 'qwen3.7-plus');
  await waitFor('the button to name it', async () => (await textOf('.model-name')) === 'qwen3.7-plus');
}
