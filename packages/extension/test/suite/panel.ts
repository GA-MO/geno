import { access, readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { CODE, EDITS, FILES, KEEP, PROMPTS, THEMES, TOOL_IDS } from './panel-fixture.js';

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

/** Asks the test, which holds the DevTools connection, to act on the window as a user would. */
async function ui<T = unknown>(action: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${model()}/ui`, { method: 'POST', body: JSON.stringify(action) });
  const text = await response.text();
  check(response.ok, `ui ${JSON.stringify(action)}`, text);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

/** Evaluates an expression over the panel's document, bound as `doc`. */
const panel = <T>(expression: string): Promise<T> => ui<T>({ do: 'eval', expression });
const click = (selector: string, text?: string) => ui({ do: 'click', selector, ...(text === undefined ? {} : { text }) });
const textOf = (selector: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);

const folder = () => vscode.workspace.workspaceFolders![0]!.uri;
const uriOf = (name: string) => vscode.Uri.joinPath(folder(), name);
const disk = (name: keyof typeof FILES) => readFile(uriOf(name).fsPath, 'utf8');
const exists = (name: string) => access(uriOf(name).fsPath).then(() => true, () => false);
const replaced = (text: string, edit: { old_str: string; new_str: string }) => text.replace(edit.old_str, edit.new_str);

async function lenses(name: keyof typeof FILES): Promise<{ title: string; id: string }[]> {
  const found = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uriOf(name));
  return found.filter((lens) => lens.command?.command.startsWith('gcode.review.')).map((lens) => ({ title: lens.command!.title, id: lens.command!.arguments![0] as string }));
}

async function showPanel(): Promise<void> {
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1);
}

async function screenshots(name: string): Promise<void> {
  for (const [slug, theme] of Object.entries(THEMES)) {
    await vscode.workspace.getConfiguration('workbench').update('colorTheme', theme, vscode.ConfigurationTarget.Global);
    await new Promise((r) => setTimeout(r, 1500));
    // VS Code says extensions are disabled in a test window, and says it again after a theme change.
    await vscode.commands.executeCommand('notifications.clearAll');
    await new Promise((r) => setTimeout(r, 300));
    await ui({ do: 'screenshot', name: `${name}-${slug}` });
  }
  await vscode.workspace.getConfiguration('workbench').update('colorTheme', THEMES.dark, vscode.ConfigurationTarget.Global);
}

const footers = () => count('.turn-footer');

async function sendWithEnter(prompt: string): Promise<void> {
  await click('textarea');
  await ui({ do: 'type', text: prompt });
  await ui({ do: 'press', key: 'Enter' });
}

export async function run(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await showPanel();
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  // Room for the screenshots, about the width people give a chat view. The resize commands act on the editor
  // part when the focus is in a webview, so narrowing the editor widens the side bar.
  await vscode.commands.executeCommand('gcode.chat.focus');
  for (let i = 0; i < 5; i++) await vscode.commands.executeCommand('workbench.action.decreaseViewWidth');

  check((await textOf('.empty-model'))?.includes('qwen3.8-flash') === true, 'the empty state names the model', await textOf('.empty-model'));
  check((await count('.example')) === 3, 'the empty state offers three example prompts');
  await screenshots('empty');

  const example = (await panel<string[]>(`[...doc.querySelectorAll('.example')].map((e) => e.textContent)`))[1]!;
  await click('.example', example);
  check((await panel<string>('doc.querySelector("textarea").value')) === example, 'an example prompt fills the composer', await panel('doc.querySelector("textarea").value'));
  check((await footers()) === 0, 'an example prompt does not send');
  await vscode.commands.executeCommand('workbench.view.explorer');
  await showPanel();
  await waitFor('the draft to survive the panel being hidden', async () => (await panel<string>('doc.querySelector("textarea").value')) === example);
  await click('textarea');
  await ui({ do: 'press', key: 'selectAll', modifiers: ['meta'] });
  await ui({ do: 'press', key: 'Backspace' });
  await ui({ do: 'type', text: 'first line' });
  await ui({ do: 'press', key: 'Enter', modifiers: ['shift'] });
  await ui({ do: 'type', text: 'second line' });
  check((await panel<string>('doc.querySelector("textarea").value')) === 'first line\nsecond line', 'Shift+Enter adds a newline and does not send');
  check((await panel<number>('doc.querySelector("textarea").offsetHeight')) > 30, 'the composer grows with its text');
  await ui({ do: 'press', key: 'selectAll', modifiers: ['meta'] });
  await ui({ do: 'press', key: 'Backspace' });

  await ui({ do: 'type', text: PROMPTS.edit });
  await click('button.send');
  await waitFor('the first turn to finish', async () => (await footers()) === 1);
  check((await disk('a.ts')) === replaced(FILES['a.ts'], EDITS.addOrder), 'the edit to a.ts is on disk', await disk('a.ts'));
  check((await textOf('.request-bubble')) === PROMPTS.edit, 'the user message shows', await textOf('.request-bubble'));
  check((await count('.tool-row')) === 4 && (await count('.edit-card')) === 3, 'four tool rows and three edit cards', [await count('.tool-row'), await count('.edit-card')]);
  check((await textOf(`[data-tool="${TOOL_IDS.read}"] .tool-label`)) === 'Read', 'a finished read row says Read');
  check((await textOf(`[data-tool="${TOOL_IDS.read}"] .tool-duration`))?.match(/^\d+(ms|\.\ds|s)$/) !== null, 'a finished row shows its duration', await textOf(`[data-tool="${TOOL_IDS.read}"] .tool-duration`));
  check((await count('.code-block .token.keyword')) > 0, 'the code block is highlighted');
  check((await count('.markdown li strong')) === 3, 'the list renders as markdown');
  const footer = await textOf('.turn-footer');
  check(footer?.match(/qwen3\.8-flash.*in.*out.*\$/) !== null, 'the footer shows model, tokens and cost', footer);
  const header = await ui<string>({ do: 'evalPage', expression: `[...document.querySelectorAll('.pane-header .description')].map((d) => d.textContent).join('|')` });
  check(/\$\d/.test(header), 'the view header shows the session total', header);

  await click('.code-block .copy');
  await waitFor('the copy button to put the code on the clipboard', async () => (await vscode.env.clipboard.readText()) === CODE);

  await click(`[data-tool="${TOOL_IDS.read}"] .tool-row`);
  await waitFor('the read row to expand', async () => (await textOf(`[data-tool="${TOOL_IDS.read}"] .tool-output`))?.includes('export function add') === true);

  await sendWithEnter(PROMPTS.remove);
  await waitFor('the permission card', async () => (await count('.permission-open')) === 1);
  check((await textOf('.permission-open .permission-command')) === 'rm -rf build', 'the card shows the full command', await textOf('.permission-open .permission-command'));
  check((await textOf('.permission-open .permission-reason'))?.includes('inside the workspace') === true, 'the card gives the reason');
  check((await panel<string>('doc.activeElement?.textContent ?? ""')) === 'Allow', 'Allow takes keyboard focus', await panel('doc.activeElement?.textContent'));
  check(await panel<boolean>('doc.querySelector("button.send").hidden && !doc.querySelector("button.stop").hidden'), 'Stop replaces Send while the turn runs');
  await screenshots('transcript');
  await panel(`(doc.querySelector('.turn').scrollIntoView(), 1)`);
  await screenshots('transcript-top');
  await click('.permission-open button', 'Deny');
  await waitFor('the denied turn to finish', async () => (await footers()) === 2);
  check(await exists('build/out.js'), 'Deny keeps the build folder');
  check((await textOf('.permission-outcome')) === 'Denied', 'the card records the denial', await textOf('.permission-outcome'));

  await sendWithEnter(PROMPTS.removeAgain);
  await waitFor('the second permission card', async () => (await count('.permission-open')) === 1);
  await click('.permission-open button', 'Allow');
  await waitFor('the allowed turn to finish', async () => (await footers()) === 3);
  check(!(await exists('build')), 'Allow lets rm -rf build run');

  await sendWithEnter(PROMPTS.stopByButton);
  await waitFor('the stalled answer to start streaming', async () => (await textOf('.turn:last-child .markdown'))?.startsWith('Once') === true);
  await click('button.stop');
  await waitFor('Stop to end the turn', async () => (await textOf('.turn:last-child .turn-footer'))?.includes('Stopped') === true);
  await sendWithEnter(PROMPTS.stopByEscape);
  await waitFor('the second stalled answer to start streaming', async () => (await textOf('.turn:last-child .markdown'))?.startsWith('Once') === true);
  await ui({ do: 'press', key: 'Escape' });
  await waitFor('Escape to end the turn', async () => (await textOf('.turn:last-child .turn-footer'))?.includes('Stopped') === true);

  const [a] = await lenses('a.ts');
  const [b] = await lenses('b.ts');
  const [c] = await lenses('c.ts');
  check(a !== undefined && b !== undefined && c !== undefined, 'every edited file has Keep and Undo lenses');
  check((await count(`[data-hunk="${a!.id}"]`)) === 1, 'the panel names the hunk by the id the CodeLens uses');
  await click(`[data-hunk="${a!.id}"] button`, 'Keep');
  await waitFor('Keep in the panel to clear the a.ts lenses', async () => (await lenses('a.ts')).length === 0);
  check((await disk('a.ts')) === replaced(FILES['a.ts'], EDITS.addOrder), 'Keep leaves the edit on disk');
  await waitFor('the a.ts card to say Kept', async () => (await textOf(`[data-hunk="${a!.id}"] .decision`)) === 'Kept');
  await click(`[data-hunk="${b!.id}"] button`, 'Undo');
  await waitFor('Undo in the panel to restore b.ts', async () => (await disk('b.ts')) === FILES['b.ts']);
  check((await lenses('b.ts')).length === 0, 'Undo in the panel clears the b.ts lenses');
  await waitFor('the b.ts card to say Undone', async () => (await textOf(`[data-hunk="${b!.id}"] .decision`)) === 'Undone');
  await vscode.commands.executeCommand(KEEP, c!.id);
  await waitFor('a CodeLens Keep to show in the panel', async () => (await textOf(`[data-hunk="${c!.id}"] .decision`)) === 'Kept');
  await new Promise((r) => setTimeout(r, 1500));
  await ui({ do: 'screenshot', name: 'reviewed-dark' });

  // The view's focus command shows the panel and focuses its frame. A test window never holds the OS focus,
  // so the frame's focus event does not fire here; the suite delivers the one a focused window gets.
  await vscode.commands.executeCommand('workbench.view.explorer');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the focus command to show the panel', async () => (await count('.turn')) === 5);
  check((await panel<string>('doc.activeElement?.tagName')) !== 'TEXTAREA', 'the composer starts without focus in a window without focus');
  await panel(`(doc.defaultView.dispatchEvent(new FocusEvent('focus')), 1)`);
  await waitFor('focus on the panel to put the cursor in the composer', () => panel<boolean>(`doc.activeElement?.tagName === 'TEXTAREA'`));
}
