import { afterAll, describe, expect, it } from 'vitest';
import { BUILTIN_AGENTS, parseWorkflow, previewQuestion, workflowPreview, type TaskRecord, type WorkflowProgress } from '@g-code/core';
import { closeBrowser, openPanel, type Panel } from './harness.js';
import { toolEnd, toolStart, turnStart } from './turns.js';

const THEMES = ['dark', 'light', 'high-contrast'] as const;

const SPEC = parseWorkflow(
  {
    description: 'Review the changes, fix what the review found, then check and verify.',
    input: 'What to focus on',
    maxCostUsd: 0.4,
    steps: [
      { id: 'review', role: 'review', prompt: 'Review {{input}}.', schema: { findings: 'string[]' } },
      { id: 'fix', role: 'worker', prompt: 'Fix:\n{{review.findings}}', maxCostUsd: 0.15, maxTurns: 20 },
      { gate: 'check' },
      { id: 'verify', role: 'review', prompt: 'Did it hold?\n{{fix}}', schema: { pass: 'boolean' } },
      { gate: { field: 'verify.pass', equals: true } },
    ],
  },
  { name: 'review-fix-verify', source: 'workspace', path: '.g-code/workflows/review-fix-verify.json' },
);
if (!SPEC.ok) throw new Error(SPEC.problem);
const PREVIEW = workflowPreview(SPEC.value, 'the login form', BUILTIN_AGENTS, { provider: 'modelstudio', model: 'qwen3.8-flash' });
const OPTIONS = [
  { optionId: 'allow', name: 'Run', kind: 'allow_once' },
  { optionId: 'reject', name: "Don't run", kind: 'reject_once' },
] as const;

async function screenshots(panel: Panel, name: string, before: () => Promise<unknown> = async () => {}): Promise<void> {
  await panel.page.mouse.move(0, 0);
  for (const slug of THEMES) {
    await panel.theme(slug);
    await before();
    await panel.screenshot(`${name}-${slug}`);
  }
  await panel.theme('dark');
}

/** Everything inside `root` that ends right of it, which a 300px panel would cut off. */
const outside = (panel: Panel, root: string) =>
  panel.eval<string[]>(
    `(() => { const c = doc.querySelector('${root}').getBoundingClientRect(); return [...doc.querySelectorAll('${root} *')].filter((e) => e.getClientRects().length > 0 && e.getBoundingClientRect().right > c.right + 0.5).map((e) => e.className || e.tagName); })()`,
  );

async function askToRun(panel: Panel): Promise<void> {
  await panel.host.act(turnStart('t0', '/workflow review-fix-verify the login form'), toolStart('tu_wf', { name: 'workflow', input: { name: 'review-fix-verify', input: 'the login form' } }));
  await panel.host.act({ type: 'permission', id: '0', command: previewQuestion(PREVIEW), reason: 'A workflow starts subagents in the background.', options: OPTIONS, ask: { kind: 'workflow', preview: PREVIEW }, toolId: 'tu_wf' });
  await panel.waitFor('the workflow card', async () => (await panel.count('.permission-open.permission-ask-workflow')) === 1);
}

const progress = (over: Partial<WorkflowProgress>): WorkflowProgress => ({ name: 'review-fix-verify', step: 2, steps: 5, running: ['fix'], spentUsd: 0.0123, capUsd: 0.4, status: 'running', ...over });

const task = (over: Partial<TaskRecord>): TaskRecord => ({
  sessionId: 'wf-1',
  title: 'Workflow review-fix-verify',
  workspace: '/work/app',
  lane: null,
  status: 'running',
  startedAt: Date.now() - 65_000,
  endedAt: null,
  ...over,
});

afterAll(closeBrowser);

describe('a workflow in the chat panel', () => {
  it('asks with each step, its estimate and caps, and the total cap, and sends Run', async () => {
    const panel = await openPanel();
    await askToRun(panel);
    const card = '.permission-ask-workflow';
    expect(await panel.eval(`doc.querySelector('${card} .permission-title').textContent`)).toBe('Run this workflow?');
    expect(await panel.eval(`doc.querySelector('${card} .workflow-name').textContent`)).toBe('review-fix-verify Review the changes, fix what the review found, then check and verify.');
    expect(await panel.eval(`doc.querySelector('${card} .workflow-input').textContent`)).toBe('Input the login form');
    const steps = await panel.eval<string[][]>(`[...doc.querySelectorAll('${card} .workflow-step')].map((s) => [...s.children].map((c) => c.textContent))`);
    const each = `About $${PREVIEW.rows[0]!.estimateUsd!.toFixed(4)}`;
    expect(steps).toEqual([
      ['review', 'review · qwen3.8-flash · read-only', `${each} · up to $0.05 and 8 model calls`],
      ['fix', 'worker · qwen3.8-flash · can edit', `${each} · up to $0.15 and 20 model calls`],
      ['check', 'Gate', "Runs the project's check"],
      ['verify', 'review · qwen3.8-flash · read-only', `${each} · up to $0.05 and 8 model calls`],
      ['verify.pass is true', 'Gate on a field', 'Free: reads an earlier step'],
    ]);
    expect(await panel.eval(`doc.querySelector('${card} .workflow-total').textContent`)).toBe(`About $${PREVIEW.estimateUsd!.toFixed(2)}, at most $0.25. The run stops cleanly at its total cap of $0.40.`);
    expect(await panel.eval(`[...doc.querySelectorAll('${card} .permission-actions button')].map((b) => b.textContent)`)).toEqual(['Run', "Don't run"]);
    await screenshots(panel, 'workflow-card', () => panel.eval(`(doc.querySelector('${card}').scrollIntoView({ block: 'start' }), 1)`));

    await panel.page.setViewportSize({ width: 300, height: 794 });
    await panel.frame();
    expect(await outside(panel, card), 'nothing on the card runs past its edge at 300px').toEqual([]);
    await screenshots(panel, 'workflow-card-300', () => panel.eval(`(doc.querySelector('${card}').scrollIntoView({ block: 'start' }), 1)`));

    await panel.click(`${card} .permission-actions button`, 'Run');
    expect(await panel.host.next('permission')).toMatchObject({ type: 'permission', id: '0', optionId: 'allow' });
    await panel.host.act({ type: 'permission-done', id: '0', optionId: 'allow' }, toolEnd('tu_wf', 'completed', 'Started workflow review-fix-verify in the background as session wf-1.'));
    await panel.waitFor('the card to settle', async () => (await panel.count('.permission-chosen.permission-ask-workflow')) === 1);
    expect(await panel.eval(`doc.querySelector('.permission-ask-workflow .permission-outcome').textContent`)).toBe('Started, in Tasks');
    await panel.close();
  });

  it("says Not run once the user says Don't run", async () => {
    const panel = await openPanel();
    await askToRun(panel);
    await panel.click('.permission-ask-workflow .permission-actions button', "Don't run");
    expect(await panel.host.next('permission')).toMatchObject({ optionId: 'reject' });
    await panel.host.act({ type: 'permission-done', id: '0', optionId: 'reject' });
    await panel.waitFor('the card to settle', async () => (await panel.count('.permission-chosen.permission-ask-workflow')) === 1);
    expect(await panel.eval(`doc.querySelector('.permission-ask-workflow .permission-outcome').textContent`)).toBe('Not run');
    await panel.close();
  });

  it('shows the run in Tasks with its step, its running steps and what it spent, and why it stopped', async () => {
    const panel = await openPanel();
    const children = [task({ sessionId: 'c-1', title: 'worker: Fix', parent: 'wf-1', kind: 'subagent' })];
    await panel.host.post({ type: 'tasks', tasks: [task({ workflow: progress({}), usage: { model: 'qwen3.8-flash', inputTokens: 0, outputTokens: 0, costUsd: 0 } }), ...children], shown: undefined, seen: {} });
    await panel.host.post({ type: 'show-tasks' });
    const row = '.task-row[data-task="wf-1"]';
    await panel.waitFor('the workflow row', async () => (await panel.count(row)) === 1);
    await panel.click('.tasks-fold');
    await panel.waitFor('Working to open', async () => (await panel.eval<string>(`doc.querySelector('.tasks-fold').getAttribute('aria-expanded')`)) === 'true');
    expect(await panel.eval(`doc.querySelector('${row} .task-workflow').textContent`)).toBe('Step 2 of 5: fix · $0.01 of $0.40');
    expect(await panel.eval(`doc.querySelector('${row}').textContent.includes('1 agent running')`)).toBe(true);
    expect(await panel.count(`${row} .lane-cost`), 'its progress line says what it spent').toBe(0);
    expect(await panel.eval(`[...doc.querySelectorAll('${row} .lane-actions button')].map((b) => b.textContent)`), 'a workflow takes no message; its steps do').toEqual(['Open', 'Stop']);
    await screenshots(panel, 'workflow-tasks');

    await panel.page.setViewportSize({ width: 300, height: 794 });
    await panel.frame();
    expect(await outside(panel, row), 'the row fits a 300px panel').toEqual([]);
    await screenshots(panel, 'workflow-tasks-300');

    const stop = 'stopped at fix, which hit its cost cap';
    await panel.host.post({ type: 'tasks', tasks: [task({ status: 'done', endedAt: Date.now(), workflow: progress({ status: 'stopped', running: [], spentUsd: 0.17, stop }) })], shown: undefined, seen: {} });
    await panel.waitFor('the stopped line', async () => (await panel.eval<string | null>(`doc.querySelector('${row} .task-workflow')?.textContent ?? null`)) === `Step 2 of 5: ${stop} · $0.17 of $0.40`);
    await screenshots(panel, 'workflow-tasks-stopped');
    await panel.close();
  });
});
