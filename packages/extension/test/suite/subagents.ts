import * as vscode from 'vscode';
import { ANSWERS, MARKERS, PROMPTS, THEMES } from './subagents-fixture.js';
import { rowFits } from './lanes-ui.js';
import { SHOOTING } from './shooting.js';

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
const press = (key: string) => ui({ do: 'press', key });
const textOf = (selector: string) => panel<string | null>(`doc.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
const count = (selector: string) => panel<number>(`doc.querySelectorAll(${JSON.stringify(selector)}).length`);
const shown = (selector: string) => panel<boolean>(`(() => { const e = doc.querySelector(${JSON.stringify(selector)}); return e !== null && e.getClientRects().length > 0; })()`);
const view = () => panel<string>('doc.body.dataset.view');
const focused = () => panel<string | null>('doc.activeElement?.dataset.focus ?? null');

/** The agent step whose call names `marker`, as a selector for its child row. */
const rowOf = (marker: string) =>
  panel<string>(
    `(() => { const step = [...doc.querySelectorAll('.step-agent')].find((s) => s.querySelector('.step-target')?.textContent.includes(${JSON.stringify(marker)})); return step?.querySelector('.child-row')?.dataset.child ?? ''; })()`,
  );
const row = (id: string, inner = '') => `.child-row[data-child="${id}"] ${inner}`.trim();

/** What each agent step nests: its call's target and, per child row, its role, model, state and whether a helper dino stands in it. */
const nesting = () =>
  panel<{ target: string; rows: { role: string; model: string; state: string; helper: boolean; cancel: boolean; time: string }[] }[]>(
    `[...doc.querySelectorAll('.transcript .step-agent')].map((step) => ({
      target: step.querySelector('.step-target').textContent,
      rows: [...step.querySelectorAll('.child-row')].map((r) => ({
        role: r.querySelector('.child-role').textContent,
        model: r.querySelector('.child-model').textContent,
        state: [...r.classList].find((c) => c.startsWith('child-') && c !== 'child-row'),
        helper: r.querySelector('.helper-slot canvas.helper-dino') !== null,
        cancel: r.querySelector('.child-cancel') !== null,
        time: r.querySelector('.child-time').textContent,
      })),
    }))`,
  );

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


/** Drags the side bar's edge until the panel is `target` px wide; the width it got. */
const panelWidth = (target: number) => ui<number>({ do: 'resize', width: target });

/** The pill's shown words, its hidden parts left out. */
const pillText = () => panel<string | null>(`doc.querySelector('.activity-pill')?.innerText.trim() ?? null`);

export async function run(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
  await vscode.commands.executeCommand('notifications.clearAll');
  await vscode.commands.executeCommand('workbench.view.extension.gcode');
  await vscode.commands.executeCommand('gcode.chat.focus');
  await waitFor('the panel to render', async () => (await count('.transcript')) === 1);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await panelWidth(420);

  // Two explorers start under the parent's two agent calls.
  await click('textarea');
  await ui({ do: 'type', text: PROMPTS.explore });
  await press('Enter');
  await waitFor('two children on the rail', async () => (await count('.transcript .child-row.child-running')) === 2);
  const alpha = await rowOf(MARKERS.alpha);
  const beta = await rowOf(MARKERS.beta);
  check(alpha !== '' && beta !== '' && alpha !== beta, 'each child sits under its own agent call', { alpha, beta });
  const nested = await nesting();
  check(nested.length === 2 && nested.every((step) => step.rows.length === 1), 'one child row under each agent step', nested);
  for (const step of nested) {
    const [child] = step.rows;
    check(child!.role === 'explore' && child!.model === 'qwen3.8-flash' && child!.state === 'child-running', 'a row names the role and model of a running child', child);
    check(child!.helper && child!.cancel, 'a running child has its helper dino and a Cancel button', child);
    check(/^0:\d\d$/.test(child!.time), 'and its clock', child);
  }
  check(/^Delegat/.test((await textOf('.step-agent .step-verb'))!), 'the agent step says it delegated', await textOf('.step-agent .step-verb'));

  // The row's one pill counts the running children, and the label names the latest step.
  await waitFor('the pill', async () => (await pillText()) === '2 running', 30_000);
  check((await count('.activity-pill')) === 1, 'one pill');
  await waitFor('a label for the latest step', async () => /^explore: /.test((await textOf('.activity-label')) ?? ''), 30_000);
  check(!(await shown('.activity-label')), 'at 420px the label gives its room to the pill');
  const wide = await rowFits();
  check(wide.fits, 'the running row fits at 420px with the pill', wide);
  await click('.activity-pill');
  await waitFor('the pill to open Tasks', async () => (await view()) === 'tasks');
  await press('Escape');
  await waitFor('the chat again', async () => (await view()) === 'chat');
  await screenshots('running');

  // At about 300px the bottom row still fits, pill and all.
  const narrow = await panelWidth(300);
  check(Math.abs(narrow - 300) <= 4, 'the panel narrows to about 300px', narrow);
  await sleep(300);
  const fits = await rowFits();
  check(fits.fits, `the bottom row fits at ${narrow}px with the pill`, fits);
  check(await shown('.activity-pill'), 'the pill still shows when narrow');
  check(!(await shown('.activity-label')), 'the label goes before the pill does');
  await screenshots('narrow-300');
  await panelWidth(420);

  // A child's row opens its transcript in the side view, and Back returns to the chat.
  await click(row(alpha, '.child-open'));
  await waitFor('the side view', async () => (await view()) === 'child');
  check(!(await shown('.transcript')) && !(await shown('.composer')), 'the side view takes the chat and the composer\'s place');
  check((await textOf('.child-view .child-title .child-role')) === 'explore', 'it names the role', await textOf('.child-view .child-title .child-role'));
  check((await textOf('.child-view .child-title .child-model')) === 'qwen3.8-flash', 'and the model');
  check((await textOf('.child-view .child-state'))?.trim() === 'Running', 'and that it runs', await textOf('.child-view .child-state'));
  check((await textOf('.child-view .child-task'))!.includes(MARKERS.alpha), 'and its task', await textOf('.child-view .child-task'));
  await waitFor("alpha's own read on its rail", async () => (await count('.child-view .child-rail .calls[data-step="read"]')) === 1);
  check((await count('.child-view .child-cancel')) === 1, 'a running child offers Cancel in its view too');
  check((await focused()) === 'child-back', 'Back takes the keyboard', await focused());
  await screenshots('child');
  await click('.child-view .child-back');
  await waitFor('the chat again', async () => (await view()) === 'chat');
  check(await shown('.transcript'), 'Back shows the chat');
  check((await focused()) === `child:${alpha}`, 'with the keyboard on the child that was open', await focused());

  // A row opens its child too, and Escape comes back.
  await click(row(alpha, '.child-open'));
  await waitFor('the side view from the row', async () => (await view()) === 'child');
  await press('Escape');
  await waitFor('Escape back to the chat', async () => (await view()) === 'chat');
  check(await shown('button.stop'), 'Escape in the side view went back and did not stop the turn');

  // One child ends; the pill counts the other.
  await ui({ do: 'release', name: 'beta' });
  await waitFor('beta to end', async () => (await count(`.child-row.child-done[data-child="${beta}"]`)) === 1);
  await waitFor('the pill to count one', async () => (await pillText()) === '1 running', 30_000);
  check((await textOf(row(beta, '.child-cost'))) !== null, 'an ended child shows its cost', await textOf(row(beta, '.child-cost')));
  check((await count(row(beta, '.helper-dino'))) === 0 && (await count(row(beta, '.child-cancel'))) === 0, 'an ended child has no helper and no Cancel');

  await ui({ do: 'release', name: 'alpha' });
  await waitFor('the turn to finish', async () => (await count('.turn-footer')) === 1);
  check((await count('.activity-pill')) === 0, 'the pill leaves with the last child');
  check((await count('.transcript .child-row.child-done')) === 2, 'both children done', await nesting());
  check((await count('.helper-dino')) === 0, 'no helper dino once they ended');
  check((await textOf('.turn .step-text:last-of-type'))?.includes(ANSWERS.parent) === true, 'the parent answered from both reports', await textOf('.turn .step-text:last-of-type'));
  await click(row(alpha, '.child-open'));
  await waitFor('the done child', async () => (await view()) === 'child');
  check((await textOf('.child-view .child-state'))?.trim() === 'Done', 'its view says done', await textOf('.child-view .child-state'));
  check((await textOf('.child-view .child-rail'))!.includes(ANSWERS.alpha), 'and shows its answer', await textOf('.child-view .child-rail'));
  await screenshots('child-done');
  await click('.child-view .child-back');
  await waitFor('the chat', async () => (await view()) === 'chat');
  await screenshots('done');

  // Cancel stops one child; the parent goes on with what it had.
  await click('textarea');
  await ui({ do: 'type', text: PROMPTS.cancel });
  await press('Enter');
  await waitFor('gamma to run', async () => (await count('.turn:last-of-type .child-row.child-running')) === 1);
  const gamma = await rowOf(MARKERS.gamma);
  await click(row(gamma, '.child-cancel'));
  await waitFor('gamma to be cancelled', async () => (await count(`.child-row.child-cancelled[data-child="${gamma}"]`)) === 1, 30_000);
  await waitFor('the parent to finish after the cancel', async () => (await count('.turn-footer')) === 2);
  check((await count('.turn:last-of-type .ending-stopped')) === 0, 'cancelling a child does not stop the turn');
  check((await textOf('.turn:last-of-type'))!.includes(ANSWERS.cancelled), 'the parent answered after the cancel', await textOf('.turn:last-of-type'));
  check((await panel<string | null>(`doc.querySelector('.child-row[data-child="${gamma}"] .child-open').title`))!.includes('Cancelled'), 'the row says it was cancelled');
}
