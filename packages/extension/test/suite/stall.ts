import * as vscode from 'vscode';

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
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
const workingRow = () => panel<string | null>(`doc.querySelector('.transcript .thinking')?.textContent ?? null`);
const tokensOn = (row: string | null): number | undefined => {
  const match = /^Thinking · ↓ (\d+) tokens$/.exec(row ?? '');
  return match === null ? undefined : Number(match[1]);
};

/** Every text the turn's notice row showed, however briefly, so a one-second retry notice is not missed between polls. */
const recordNotices = () =>
  panel(`(() => {
    const seen = (doc.defaultView.__notices = []);
    new doc.defaultView.MutationObserver(() => {
      const text = doc.querySelector('.transcript .turn-notice')?.textContent;
      if (text && !seen.includes(text)) seen.push(text);
    }).observe(doc.body, { subtree: true, childList: true, characterData: true });
    return 1;
  })()`);

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
  await recordNotices();

  await ui({ do: 'click', selector: 'textarea' });
  await ui({ do: 'type', text: 'Build the pacman maze' });
  await ui({ do: 'press', key: 'Enter' });

  let first: number | undefined;
  await waitFor('the working row to count the thinking', async () => (first = tokensOn(await workingRow())) !== undefined);
  let later: number | undefined;
  await waitFor('the count to rise as the thinking streams', async () => (later = tokensOn(await workingRow())) !== undefined && later > first!, 10_000);
  await ui({ do: 'pointerAway' });
  await ui({ do: 'screenshot', name: 'stall-streaming' });

  // The first try goes quiet; its retry has no response, which the row names once 30 s pass.
  await waitFor('the row to say the retry has had no response', async () => /^No response from the model after 3\ds · waiting up to 2m$/.test((await workingRow()) ?? ''), 120_000);
  await ui({ do: 'screenshot', name: 'stall-no-response' });
  const notices = await panel<string[]>('doc.defaultView.__notices');
  check(notices.includes('Retrying in 1s (the model went quiet)'), 'the quiet try showed its retry', notices);

  await ui({ do: 'release' });
  await waitFor('the answer', async () => (await panel<string>(`doc.querySelector('.transcript .turn .step-text')?.textContent ?? ''`)).includes('Here is the maze.'));
  await waitFor('the turn to end', async () => (await count('.transcript .turn-footer')) === 1);
  check((await workingRow()) === null, 'the working row is gone once the turn ends', await workingRow());
}
