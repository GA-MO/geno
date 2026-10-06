import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { ANSWER, EDITED, FILES, LANE, MODELS, PROMPT, SWITCHED } from './backends-fixture.js';
import { check, click, count, openPanel, panel, panelWidth, press, screenshots, shown, sleep, textOf, ui, view, waitFor } from './lanes-ui.js';

const disk = (file: string) => readFile(path.join(vscode.workspace.workspaceFolders![0]!.uri.fsPath, file), 'utf8');

type Row = { readonly id: string; readonly name: string; readonly detail: string | null; readonly checked: string | null; readonly disabled: boolean };
const backendRows = () =>
  panel<Row[]>(
    `[...doc.querySelectorAll('#model-menu [data-backend]')].map((e) => ({ id: e.dataset.backend, name: e.querySelector('.model-option-name').textContent,
      detail: e.querySelector('.model-option-detail')?.textContent ?? null, checked: e.getAttribute('aria-checked'), disabled: e.getAttribute('aria-disabled') === 'true' }))`,
  );
const agentModels = () => panel<string[]>(`[...doc.querySelectorAll('#model-menu [data-agent-model]')].map((e) => e.querySelector('.model-option-name').textContent + ':' + e.getAttribute('aria-checked'))`);
/** Whether the menu stays inside the panel and scrolls nothing sideways, and every row's text fits its row. */
const menuFits = () =>
  panel<{ inside: boolean; scroll: boolean; rows: string[] }>(
    `(() => {
      const m = doc.querySelector('#model-menu'); const r = m.getBoundingClientRect();
      const rows = [...m.querySelectorAll('.model-option')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent);
      return { inside: r.left >= 0 && r.right <= doc.documentElement.clientWidth, scroll: m.scrollWidth > m.clientWidth + 1, rows };
    })()`,
  );

export async function run(): Promise<void> {
  await openPanel();
  await panelWidth(420);

  // The model menu lists the backends: Geno current, Cursor ready, Claude Code missing with its reason.
  await click('.composer-model');
  await waitFor('the model menu', async () => await shown('#model-menu'));
  await waitFor('the engine to list its backends', async () => (await count('#model-menu [data-backend]')) === 3);
  const rows = await backendRows();
  check(rows.map((r) => `${r.id}:${r.name}:${r.checked}:${r.disabled}`).join() === 'geno:Geno:true:false,cursor:Cursor:false:false,claude-code:Claude Code:false:true', 'the menu offers Geno, Cursor and Claude Code', rows);
  check(rows[1]!.detail === 'Starts a new chat', 'another backend says it starts a new chat', rows[1]);
  check(rows[2]!.detail?.includes('claude-agent-acp') === true, 'the missing one gives its reason', rows[2]);
  check((await panel<string | null>('doc.activeElement?.dataset.key ?? null')) !== null, 'the current model, not the backend, takes the keyboard', await panel('doc.activeElement?.className'));
  await screenshots('model-menu');
  await panelWidth(300);
  await sleep(300);
  const narrow = await menuFits();
  check(narrow.inside && !narrow.scroll && narrow.rows.length === 0, 'at 300px the menu stays inside the panel and its rows ellipsize', narrow);
  await screenshots('model-menu-300');
  await panelWidth(420);

  // The keys: a missing backend takes the focus but Enter on it does nothing.
  await panel(`doc.querySelector('#model-menu [data-backend="claude-code"]').focus()`);
  await press('Enter');
  await sleep(300);
  check(await shown('#model-menu'), 'Enter on a missing backend keeps the menu open');
  await press('ArrowUp');
  check((await panel<string | null>('doc.activeElement?.dataset.backend ?? null')) === 'cursor', 'ArrowUp moves to Cursor', await panel('doc.activeElement?.dataset.backend ?? null'));

  // Cursor starts a new chat on it, with its own models.
  await press('Enter');
  await waitFor('the button to name Cursor', async () => (await textOf('.model-backend')) === 'Cursor' && (await textOf('.model-name')) === 'Auto');
  await click('.composer-model');
  await waitFor('Cursor’s models', async () => (await count('#model-menu [data-agent-model]')) === MODELS.length);
  check((await agentModels()).join() === MODELS.map((m, i) => `${m}:${i === 0}`).join(), 'the menu lists the agent’s models, Auto current', await agentModels());
  check((await backendRows()).map((r) => `${r.id}:${r.checked}`).join() === 'geno:false,cursor:true,claude-code:false', 'Cursor is the current backend', await backendRows());
  check((await count('#model-menu [data-effort]')) === 0, 'an external session offers no effort');
  await click(`#model-menu [data-agent-model="${SWITCHED.value}"]`);
  await waitFor('the switched model', async () => (await textOf('.model-name')) === SWITCHED.name);

  // A turn: the agent reads, then edits after Allow in the card.
  await click('textarea');
  await ui({ do: 'type', text: PROMPT });
  await press('Enter');
  await waitFor('the permission card', async () => (await count('.permission-open')) === 1);
  const buttons = await panel<string[]>(`[...doc.querySelectorAll('.permission-open .permission-actions button')].map((b) => b.textContent)`);
  check(buttons.join() === 'Allow,Deny', 'the card offers Geno’s allow once and deny, never always', buttons);
  check((await textOf('.permission-open .permission-command'))?.includes('edit a.ts') === true, 'the card names the edit', await textOf('.permission-open .permission-command'));
  await click('.permission-open .permission-actions .button:not(.secondary)');
  await waitFor('the turn to finish', async () => (await count('.turn .turn-footer')) === 1);
  check((await textOf('.transcript'))?.includes(ANSWER) === true, 'the agent’s answer shows', await textOf('.transcript'));
  const steps = await panel<string[]>(`[...doc.querySelectorAll('.turn .calls')].map((c) => c.dataset.step + ':' + [...c.querySelector('.codicon.kind').classList].find((k) => k.startsWith('codicon-')))`);
  check(steps.join() === 'read:codicon-file,edit:codicon-edit', 'the read and edit steps show with their kinds', steps);
  check((await textOf('.turn .turn-head .turn-name')) === 'Geno' && (await textOf('.turn .turn-head .turn-backend')) === 'Cursor', 'the head says Geno · Cursor', await textOf('.turn .turn-head'));
  check((await textOf('.turn .turn-footer .turn-cost')) === 'Cursor plan', 'the footer gives the plan for the cost', await textOf('.turn .turn-footer'));
  check((await textOf('.turn .turn-footer'))?.includes(' in') === false, 'and no token counts', await textOf('.turn .turn-footer'));
  check((await disk('a.ts')) === FILES['a.ts'], 'the edit stayed in the lane');
  await waitFor('the Apply offer', async () => (await textOf('.apply-lane button')) === `Apply changes from lane ${LANE}`);
  await screenshots('cursor-turn');
  await panelWidth(300);
  await sleep(300);
  check(await panel<boolean>(`(() => { const b = doc.querySelector('.apply-lane button').getBoundingClientRect(); return b.right <= doc.documentElement.clientWidth; })()`), 'Apply fits the narrow panel');
  await screenshots('cursor-turn-300');
  await panelWidth(420);

  // The Tasks pane names the agent and its lane.
  await vscode.commands.executeCommand('gcode.chat.tasks');
  await waitFor('the Tasks pane', async () => (await view()) === 'tasks');
  await waitFor('the Cursor task', async () => (await textOf('.task-row .task-backend')) === 'Cursor');
  check((await textOf('.task-row .task-where')) === `Lane ${LANE}`, 'the row gives its lane', await textOf('.task-row .lane-meta'));
  await screenshots('tasks');
  await panelWidth(300);
  await sleep(300);
  check(await panel<boolean>(`doc.querySelector('.task-row').scrollWidth <= doc.querySelector('.task-row').clientWidth + 1`), 'the row fits the narrow panel');
  await screenshots('tasks-300');
  await panelWidth(420);
  await press('Escape');
  await waitFor('the chat again', async () => (await view()) === 'chat');

  // Apply brings the lane's edit into the main checkout, under review.
  await click('.apply-lane button');
  await waitFor('the apply turn with its hunk', async () => (await count('.transcript .hunk[data-hunk] .hunk-actions')) === 1);
  await waitFor('a.ts to take the lane change', async () => (await disk('a.ts')) === EDITED);
  check((await textOf('.turn:last-of-type .request'))?.includes(`Apply lane ${LANE}`) === true, 'the apply is a turn of the same chat', await textOf('.turn:last-of-type .request'));
  check((await count('.apply-lane')) === 0, 'the offer goes once the edit came back');
}
