import * as vscode from 'vscode';

const PROMPT =
  "Explain this repo's agent request flow, from the chat panel to the model and back, as a diagram of about ten steps. Read at most two files, do not edit anything and do not run commands.";

async function ui<T = unknown>(action: Record<string, unknown>): Promise<T> {
  const response = await fetch(process.env['GCODE_TEST_UI']!, { method: 'POST', body: JSON.stringify(action) });
  const text = await response.text();
  if (!response.ok) throw new Error(`ui ${JSON.stringify(action)}: ${text}`);
  return (text === '' ? undefined : JSON.parse(text)) as T;
}

const panel = <T>(expression: string): Promise<T> => ui<T>({ do: 'eval', expression });

async function waitFor(what: string, probe: () => Promise<boolean>, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await probe().catch(() => false))) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Asks the real model for a diagram through the panel, as a user types it, and reports what the panel drew. */
export async function run(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel', () => panel<boolean>(`doc.querySelector('.transcript') !== null`), 30_000);
  for (let i = 0; i < 5; i++) await vscode.commands.executeCommand('workbench.action.decreaseViewWidth');
  await ui({ do: 'click', selector: 'textarea' });
  await ui({ do: 'type', text: PROMPT });
  await ui({ do: 'press', key: 'Enter' });
  await waitFor('the turn to end', () => panel<boolean>(`doc.querySelector('.turn-footer') !== null`), 300_000);
  await waitFor('every diagram to settle', () => panel<boolean>(`doc.querySelector('.diagram[data-state="pending"]') === null`), 60_000);
  const result = await panel<{ diagrams: { state: string; label: string; nodes: number; note: string | null; source: string }[]; footer: string; text: string }>(`({
    diagrams: [...doc.querySelectorAll('.diagram')].map((d) => ({
      state: d.dataset.state,
      label: d.getAttribute('aria-label'),
      nodes: d.querySelectorAll('svg .node, svg .actor-top, svg .messageText').length,
      note: d.querySelector('.diagram-note')?.textContent ?? null,
      source: d.querySelector('.code-block code')?.textContent ?? null,
    })),
    footer: doc.querySelector('.turn-footer')?.textContent ?? '',
    text: [...doc.querySelectorAll('.markdown > p')].map((p) => p.textContent).join('\\n').slice(0, 600),
  })`);
  await panel(`(doc.querySelector('.diagram')?.scrollIntoView({ block: 'start' }), 1)`);
  await new Promise((r) => setTimeout(r, 800));
  await ui({ do: 'screenshot' });
  await ui({ do: 'report', result });
  if (!result.diagrams.some((d) => d.state === 'rendered')) throw new Error(`the model's answer drew no diagram: ${JSON.stringify(result)}`);
}
