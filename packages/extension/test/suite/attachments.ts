import * as vscode from 'vscode';
import { IMAGES, PROMPT } from './attachments-fixture.js';
import { THEMES } from './panel-fixture.js';
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
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uriOf = (name: string) => vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0]!.uri, name);
const base64Of = async (name: string) => Buffer.from(await vscode.workspace.fs.readFile(uriOf(name))).toString('base64');

/** Each chip as `name:state:detail`. */
const chips = () =>
  panel<string[]>(
    `[...doc.querySelectorAll('.attachment-chip')].map((e) => e.dataset.attachment + ':' + e.className.match(/attachment-(reading|ready|rejected)/)[1] + ':' + e.querySelector('.attachment-detail').textContent)`,
  );

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

/** Whether the first image matching `selector` loaded, as its pixel width; 0 while it has not. */
const loadedWidth = (selector: string) => panel<number>(`(() => { const img = doc.querySelector(${JSON.stringify(selector)}); return img && img.complete ? img.naturalWidth : 0; })()`);

async function useTheme(theme: string): Promise<void> {
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
  await sleep(1500);
  await vscode.commands.executeCommand('notifications.clearAll');
  await sleep(300);
}

async function screenshots(name: string): Promise<void> {
  if (!SHOOTING) return;
  await ui({ do: 'pointerAway' });
  for (const [slug, theme] of Object.entries(THEMES)) {
    await useTheme(theme);
    await ui({ do: 'screenshot', name: `${name}-${slug}` });
  }
  await useTheme(THEMES.dark);
}

export async function run(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('gcode.chat.focus');

  const csp = await panel<string>(`doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? ''`);
  const imageSources = csp.match(/img-src ([^;]*)/)?.[1]?.split(' ') ?? [];
  check(imageSources.includes('data:') && imageSources.every((source) => source === 'data:' || source === "'self'" || source.endsWith('.vscode-cdn.net')), 'images load only from the webview and data URLs', csp);

  await ui({ do: 'click', selector: '.context-add' });
  await waitFor('the + menu to offer Attach file…', async () => (await panel<string | null>(`doc.querySelector('.mention')?.dataset.action ?? null`)) === 'attach');
  check((await panel<string>(`doc.querySelector('.mention .mention-label').textContent`)) === 'Attach file…', 'Attach file… is the first row');
  await ui({ do: 'press', key: 'Escape' });
  await ui({ do: 'press', key: 'Backspace' });
  check((await panel<string>('doc.querySelector("textarea").value')) === '', 'the composer is empty again');

  await paste(IMAGES.flag, await base64Of(IMAGES.flag), 'image/png');
  await paste(IMAGES.big, await base64Of(IMAGES.big), 'image/png');
  await dropUris([uriOf('notes.md').toString(), uriOf('app.bin').toString()]);
  await waitFor('four chips, none still reading', async () => {
    const all = await chips();
    return all.length === 4 && !all.some((c) => c.includes(':reading:'));
  });
  const shown = await chips();
  check(shown[0]!.startsWith('flag.png:ready:320×160'), 'the pasted image is ready at its own size', shown);
  check(shown[1]!.startsWith('big.png:ready:1568×784'), 'a big image is scaled so its long side is 1568', shown);
  check(shown.includes('notes.md:ready:61 B'), 'the dropped text file is ready', shown);
  check(shown.includes('app.bin:rejected:Not attached'), 'the dropped binary file is refused', shown);
  const note = await panel<string>(`doc.querySelector('.attachment-note').textContent`);
  check(note === 'app.bin is a binary file; attach an image or a text file.', 'the refusal says why', note);
  check(await panel<boolean>(`doc.querySelector('.attachment-chip .thumb img').src.startsWith('data:image/')`), 'an image chip shows its thumbnail');

  await ui({ do: 'click', selector: '.attachment-chip[data-attachment="app.bin"] .chip-remove' });
  await ui({ do: 'click', selector: '.attachment-chip[data-attachment="big.png"] .chip-remove' });
  check((await chips()).map((c) => c.split(':')[0]).join() === 'flag.png,notes.md', 'removing chips takes them away', await chips());

  await ui({ do: 'click', selector: 'textarea' });
  await ui({ do: 'type', text: PROMPT });
  await screenshots('composer');

  await ui({ do: 'press', key: 'Enter' });
  await waitFor('the turn to finish', async () => (await count('.turn-footer')) === 1);
  check((await count('.attachment-chip')) === 0, 'sending clears the chips');
  check((await count('.sent-attachments .thumb img')) === 1, 'the sent image shows above the prompt');
  check((await panel<string>(`doc.querySelector('.sent-file .attachment-name').textContent`)) === 'notes.md', 'the sent file shows above the prompt');
  await waitFor('the read thumbnail to load', async () => (await loadedWidth('.step-images img')) === 240);
  check(await panel<boolean>(`doc.querySelector('.step-images img').src.startsWith('https://file+')`), 'the thumbnail comes from the workspace through the webview');
  await waitFor('the inline workspace image to load', async () => (await loadedWidth('.inline-image img')) === 240);
  check((await count('.blocked-image')) === 1, 'the remote image is a link with a note');
  check((await count('img[src*="example.com"]')) === 0, 'the remote image never loads');

  await panel(`(doc.querySelector('.turn').scrollIntoView({ block: 'start' }), 1)`);
  await screenshots('sent');
  await panel(`(doc.querySelector('.step-images').scrollIntoView({ block: 'center' }), 1)`);
  await screenshots('read');

  await ui({ do: 'click', selector: '.step-images .thumb' });
  await waitFor('the shot to open in an editor tab', async () => vscode.window.tabGroups.activeTabGroup.activeTab?.label === IMAGES.shot);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await ui({ do: 'click', selector: '.sent-attachments .thumb' });
  await waitFor('the pasted image to open from the attachments folder', async () => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input as { uri?: vscode.Uri } | undefined;
    return input?.uri?.path.includes('/attachments/') === true && input.uri.path.endsWith('.png');
  });
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', undefined, vscode.ConfigurationTarget.Global);
}
