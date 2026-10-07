import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TASK_UPDATE_METHOD,
  TASKS_CAPABILITY,
  WORKFLOW_META,
  WORKFLOWS_CAPABILITY,
  type ChildStartEvent,
  type TaskUpdate,
  type TurnEvent,
  type WorkflowPreview,
  ENVIRONMENT_HEADING,
} from '@g-code/core';
import type { Io } from '../src/command.js';
import { engineShared, gcodeAgent } from '../src/serve.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore, type Store } from '../src/store.js';
import { answer, fakeTransport, handBack, loadTools, toolCall, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand } from './helpers.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 15_000 });

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
// At qwen3.8-flash's $0.15 per million input tokens, one call of these costs $0.03.
const costly = { input: 200_000, cacheRead: 0, cacheWrite: 0 };
const LIMITS = { maxTurns: 10, maxCostUsd: 1 };
const FAST = { batchMs: 200, secondMs: 20 };
const OUTER_MS = 10_000;
const PARENT = 'Run the workflow';

async function until(done: () => boolean | Promise<boolean>, step: string, ms = OUTER_MS): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${step}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type Body = { readonly messages: { readonly role: string; readonly content: unknown }[] };
type Script = (n: number, body: Body) => Reply | Promise<Reply>;

/** One scripted model per conversation, picked by a marker in its first message: a step's task, or the parent's prompt. */
function models(scripts: Readonly<Record<string, Script>>) {
  const requests = new Map<string, Body[]>(Object.keys(scripts).map((marker) => [marker, []]));
  const at = new Map<string, number[]>(Object.keys(scripts).map((marker) => [marker, []]));
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Body;
    const marker = Object.keys(scripts).find((m) => JSON.stringify(body.messages[0]).includes(m));
    if (marker === undefined) throw new Error(`no fake model for ${JSON.stringify(body.messages[0]).slice(0, 200)}`);
    requests.get(marker)!.push(body);
    at.get(marker)!.push(Date.now());
    const aborted = new Promise<never>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
    const reply = await Promise.race([scripts[marker]!(requests.get(marker)!.length - 1, body), aborted]);
    return fakeTransport([reply]).fetch(input, init);
  };
  return { fetch, requests: (marker: string) => requests.get(marker)!, at: (marker: string) => at.get(marker)! };
}

const texts = (body: Body): string[] =>
  (body.messages.at(-1)!.content as { type: string; text?: string }[]).flatMap((b) => (b.type === 'text' && !b.text!.startsWith(ENVIRONMENT_HEADING) ? [b.text!] : []));

const WORKFLOWS: Readonly<Record<string, unknown>> = {
  three: {
    description: 'Review, fix, check and verify.',
    input: 'What to focus on',
    maxCostUsd: 0.4,
    steps: [
      { id: 'review', role: 'review', prompt: '[review] Review {{input}}.', schema: { findings: 'string[]' } },
      { id: 'fix', role: 'worker', prompt: ['[fix] Fix these:', '{{review.findings}}'], maxCostUsd: 0.15, maxTurns: 5 },
      { gate: 'check' },
      { id: 'verify', role: 'review', prompt: '[verify] Did the fix hold?\n{{fix}}', schema: { pass: 'boolean' } },
      { gate: { field: 'verify.pass', equals: true } },
    ],
  },
  fanout: {
    description: 'Three looks at once, then a summary.',
    steps: [
      { parallel: [{ id: 'one', role: 'explore', prompt: '[p1] look one' }, { id: 'two', role: 'explore', prompt: '[p2] look two' }, { id: 'three', role: 'explore', prompt: '[p3] look three' }] },
      { id: 'sum', role: 'plan', prompt: '[sum] Sum up:\n{{parallel}}' },
    ],
  },
  capped: {
    description: 'A fix that runs out of money.',
    steps: [
      { id: 'look', role: 'explore', prompt: '[look] look' },
      { id: 'fix', role: 'worker', prompt: '[costly] fix', maxCostUsd: 0.02 },
      { id: 'after', role: 'review', prompt: '[after] never' },
    ],
  },
  slow: { description: 'One slow look.', steps: [{ id: 'hang', role: 'explore', prompt: '[hang] look slowly' }, { id: 'after', role: 'review', prompt: '[after] never' }] },
};

async function fixture() {
  const files: Record<string, string> = { 'a.ts': 'export const alpha = 1;\n', '.gcode.json': '{ "check": "test -f a.ts" }\n' };
  for (const [name, spec] of Object.entries(WORKFLOWS)) files[`.g-code/workflows/${name}.json`] = `${JSON.stringify(spec, null, 2)}\n`;
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files }]));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const env = {
    GCODE_HOME: home,
    HOME: home,
    GCODE_PROVIDER: 'modelstudio',
    DASHSCOPE_API_KEY: 'sk-fake',
    DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
    GCODE_RG: rgCommand(),
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    GCODE_WAKE_POLICY: JSON.stringify(FAST),
  };
  return { workspace, env };
}

type Heard = { readonly updates: acp.SessionNotification[]; readonly tasks: TaskUpdate[]; readonly cards: acp.RequestPermissionRequest[] };
type Window = { readonly ctx: acp.ClientContext; readonly sessionId: string; readonly store: Store; prompt(text: string): Promise<acp.PromptResponse> };

const shared: { kill?: () => Promise<void> } = {};
afterEach(async () => {
  await shared.kill?.();
});

/** One editor window that shows Tasks and workflows, answers cards with `answer`, and stays connected through `scenario`. */
async function serve<T>(fetch: typeof globalThis.fetch, scenario: (window: Window, heard: Heard) => Promise<T>, answerCard: (card: acp.RequestPermissionRequest) => string = (card) => card.options[0]!.optionId) {
  const { workspace, env } = await fixture();
  const store = openStore(env);
  const io: Io = { env, cwd: workspace, out: () => {}, err: () => {}, write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch };
  const heard: Heard = { updates: [], tasks: [], cards: [] };
  const client = acp
    .client({ name: 'test-editor' })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      heard.cards.push(params);
      return { outcome: { outcome: 'selected', optionId: answerCard(params) } };
    })
    .onNotification(acp.methods.client.session.update, ({ params }) => void heard.updates.push(params))
    .onNotification(TASK_UPDATE_METHOD, (raw) => raw as TaskUpdate, ({ params }) => void heard.tasks.push(params));
  const engine = engineShared(io);
  shared.kill = () => engine.jobs.kill('engine-exit', 'all');
  const { sessionId, result } = await client.connectWith(gcodeAgent(io, store, LIMITS, undefined, engine), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { subagents: {}, _meta: { [TASKS_CAPABILITY]: true, [WORKFLOWS_CAPABILITY]: true } },
    });
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
    await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: 'auto' });
    const window: Window = { ctx, sessionId, store, prompt: (text) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] }) };
    return { sessionId, result: await scenario(window, heard) };
  });
  return { sessionId, result, store, heard };
}

const logOf = async (store: Store, sessionId: string): Promise<TurnEvent[]> => [...(await readSessionLog(sessionFile(store, sessionId as never))).events];
const workflowTask = (heard: Heard, name: string) => heard.tasks.findLast((u) => u.task.workflow?.name === name)?.task;
const wokenWith = (heard: Heard, sessionId: string) =>
  heard.updates.some((u) => u.sessionId === sessionId && u.update.sessionUpdate === 'user_message_chunk' && JSON.stringify(u.update).includes('woke'));

describe('gcode serve: workflows', () => {
  it('runs review, fix, check and verify from /workflow, with the preview first and the report back in the parent', async () => {
    const model = models({
      // Each step hands back through report, so the JSON blocks readFields parses arrive in report calls.
      '[review]': () => handBack('Two findings.\n\n```json\n{"findings": ["a.ts:1 name it better", "a.ts:1 add a type"]}\n```', usage),
      '[fix]': () => handBack('Renamed and typed it.', usage),
      '[verify]': () => handBack('It holds.\n\n```json\n{"pass": true}\n```', usage),
      [PARENT]: () => answer('The workflow finished: review, fix and verify all passed.', usage),
    });
    const { result, store, heard, sessionId } = await serve(model.fetch, async (window, heard) => {
      const response = await window.prompt('/workflow three the alpha export');
      const requestsAfterPrompt = model.requests(PARENT).length;
      await until(() => workflowTask(heard, 'three')?.status === 'done', 'the workflow to finish');
      await until(() => model.requests(PARENT).length === 1 && wokenWith(heard, window.sessionId), 'the starting session to wake with the report');
      return { response, requestsAfterPrompt, task: workflowTask(heard, 'three')! };
    });

    expect(result.response.stopReason).toBe('end_turn');
    expect(result.requestsAfterPrompt, '/workflow calls no model in the starting session').toBe(0);
    expect(heard.cards).toHaveLength(1);
    const card = heard.cards[0]!;
    expect(card.toolCall.title).toMatch(/^Run workflow three: 4 steps, about \$0\.\d+, at most \$0\.25 \(cap \$0\.40\)\?$/);
    const preview = card.toolCall._meta?.[WORKFLOW_META] as WorkflowPreview;
    expect(preview.rows.map((row) => [row.label, row.role, row.caps?.maxCostUsd])).toEqual([
      ['review', 'review', 0.05],
      ['fix', 'worker', 0.15],
      ['check', undefined, undefined],
      ['verify', 'review', 0.05],
      ['verify.pass is true', undefined, undefined],
    ]);
    expect(preview.input).toBe('the alpha export');

    expect(model.requests('[review]').map((body) => texts(body)[0])).toEqual([
      '[review] Review the alpha export.\n\nEnd your report with one JSON block in a ```json fence, of exactly this shape: {"findings": ["text"]}',
    ]);
    expect(texts(model.requests('[fix]')[0]!)[0]).toBe('[fix] Fix these:\n["a.ts:1 name it better","a.ts:1 add a type"]');
    expect(texts(model.requests('[verify]')[0]!)[0]).toContain('Renamed and typed it.');

    const workflowId = result.task.sessionId;
    expect(result.task.title).toBe('Workflow three');
    expect(result.task.workflow).toMatchObject({ name: 'three', status: 'done', steps: 5, capUsd: 0.4 });
    const steps = heard.tasks.flatMap((u) => (u.task.workflow?.name === 'three' && u.task.workflow.running.length > 0 ? [u.task.workflow.running.join(',')] : []));
    expect([...new Set(steps)], 'Tasks follows each step').toEqual(['review', 'fix', 'gate', 'verify']);

    const events = await logOf(store, workflowId);
    const issued = events.filter((e) => e.kind === 'assistant');
    expect(issued.every((e) => e.kind === 'assistant' && e.issuedBy === 'user' && e.costUsd === 0), 'every round is issued, never a model call').toBe(true);
    expect(issued).toHaveLength(5);
    const starts = events.filter((e): e is ChildStartEvent => e.kind === 'child-start');
    expect(starts.map((e) => [e.role, e.caps.maxCostUsd, e.caps.maxTurns])).toEqual([
      ['review', 0.05, 8],
      ['worker', 0.15, 5],
      ['review', 0.05, 8],
    ]);
    expect(events.some((e) => e.kind === 'tool-result' && e.name === 'check' && 'output' in e && e.output.startsWith('check `test -f a.ts` passed'))).toBe(true);

    const parent = await logOf(store, sessionId);
    const report = parent.find((e) => e.kind === 'user' && e.from === 'child');
    expect(report?.kind === 'user' && report.content).toMatch(new RegExp(`<subagent_report agent="workflow three" session="${workflowId}" status="done" turns="3" cost="\\$\\d+\\.\\d{4}" duration="\\d+s">`));
    expect(report?.kind === 'user' && report.content).toContain('Workflow three finished: 4 steps ran');
    const woken = texts(model.requests(PARENT)[0]!).join('\n');
    expect(woken).toContain('The last report, from verify:');
    expect(woken).toContain('woke: 1 task finished');
  });

  it('runs a parallel fan-out of 3 at once, then the step that joins them', async () => {
    const delay = (text: string) => async () => (await new Promise((resolve) => setTimeout(resolve, 400)), answer(text, usage));
    const model = models({
      '[p1]': delay('one: fine'),
      '[p2]': delay('two: fine'),
      '[p3]': delay('three: fine'),
      '[sum]': () => answer('All three are fine.', usage),
      [PARENT]: () => answer('Done.', usage),
    });
    const { result, heard } = await serve(model.fetch, async (window, heard) => {
      await window.prompt('/workflow fanout');
      await until(() => workflowTask(heard, 'fanout')?.status === 'done', 'the workflow to finish');
      return workflowTask(heard, 'fanout')!;
    });
    const starts = ['[p1]', '[p2]', '[p3]'].map((m) => model.at(m)[0]!);
    expect(Math.max(...starts) - Math.min(...starts), 'the three branches start together').toBeLessThan(300);
    expect(model.at('[sum]')[0]! - Math.max(...starts), 'the join waits for them').toBeGreaterThanOrEqual(350);
    expect(texts(model.requests('[sum]')[0]!)[0]).toContain('one:\n<subagent_report agent="explore"');
    expect(result.workflow?.status).toBe('done');
    expect(heard.tasks.some((u) => u.task.workflow?.running.length === 3), 'Tasks shows all three running').toBe(true);
  });

  it('stops at a step that hits its cost cap, runs nothing after it, and reports what ran', async () => {
    const model = models({
      '[look]': () => answer('Looked.', usage),
      '[costly]': () => toolCall('Reading.', [{ id: 'tu_r', name: 'read', input: { path: 'a.ts' } }], costly),
      '[after]': () => answer('never', usage),
      [PARENT]: () => answer('It stopped.', usage),
    });
    const { result, store, sessionId } = await serve(model.fetch, async (window, heard) => {
      await window.prompt('/workflow capped');
      await until(() => workflowTask(heard, 'capped')?.status === 'done', 'the workflow to end');
      await until(() => model.requests(PARENT).length === 1, 'the starting session to wake');
      return workflowTask(heard, 'capped')!;
    });
    expect(model.requests('[costly]').length).toBe(1);
    expect(model.requests('[after]'), 'the step after the cap never runs').toEqual([]);
    expect(result.workflow).toMatchObject({ status: 'stopped', stop: 'stopped at fix, which hit its cost cap' });
    const parent = await logOf(store, sessionId);
    const report = parent.find((e) => e.kind === 'user' && e.from === 'child');
    const text = report?.kind === 'user' ? report.content : '';
    expect(text).toContain('status="capped" partial="true"');
    expect(text).toContain('Workflow capped stopped at fix, which hit its cost cap. 2 steps ran');
    expect(text).toContain('- fix (worker): capped (stopped at its cost cap), 1 model call, $0.03');
    expect(text).toContain('Did not run: after.');
  });

  it('cancels from Tasks: the running step is cancelled, nothing after it runs, and the parent hears it', async () => {
    let started = () => {};
    const hanging = new Promise<void>((resolve) => (started = resolve));
    const model = models({
      '[hang]': () => (started(), new Promise<Reply>(() => {})),
      '[after]': () => answer('never', usage),
      [PARENT]: () => answer('Cancelled.', usage),
    });
    const { result, store, sessionId } = await serve(model.fetch, async (window, heard) => {
      await window.prompt('/workflow slow');
      await hanging;
      const id = workflowTask(heard, 'slow')!.sessionId;
      await window.ctx.notify(acp.methods.agent.session.cancel, { sessionId: id });
      await until(() => workflowTask(heard, 'slow')?.status === 'stopped', 'the workflow to stop');
      await until(async () => (await logOf(window.store, window.sessionId)).some((e) => e.kind === 'user' && e.from === 'child'), 'the report in the parent');
      return { id, task: workflowTask(heard, 'slow')! };
    });
    expect(result.task.workflow).toMatchObject({ status: 'cancelled', stop: 'was cancelled' });
    expect(model.requests('[after]')).toEqual([]);
    const events = await logOf(store, result.id);
    expect(events.find((e) => e.kind === 'child-end')).toMatchObject({ end: { kind: 'cancelled' } });
    const parent = await logOf(store, sessionId);
    const report = parent.find((e) => e.kind === 'user' && e.from === 'child');
    expect(report?.kind === 'user' && report.content).toContain('Workflow slow was cancelled.');
  });

  it("runs nothing when the user says Don't run", async () => {
    const model = models({ '[review]': () => answer('never', usage), [PARENT]: () => answer('never', usage) });
    const { heard, store, sessionId } = await serve(
      model.fetch,
      async (window) => window.prompt('/workflow three'),
      () => 'reject',
    );
    expect(heard.cards).toHaveLength(1);
    expect(model.requests('[review]')).toEqual([]);
    expect(heard.tasks.some((u) => u.task.workflow !== undefined)).toBe(false);
    const result = (await logOf(store, sessionId)).find((e) => e.kind === 'tool-result');
    expect(result?.kind === 'tool-result' && 'output' in result && result.output).toContain('The user did not run the workflow.');
  });

  it('lets the model load the workflow tool and start one, which asks the user the same way', async () => {
    const model = models({
      '[p1]': () => answer('one', usage),
      '[p2]': () => answer('two', usage),
      '[p3]': () => answer('three', usage),
      '[sum]': () => answer('Summed.', usage),
      '[model-parent]': (n) =>
        n === 0
          ? toolCall('Loading it.', [loadTools('workflow')], usage)
          : n === 1
            ? toolCall('Starting it.', [{ id: 'tu_wf', name: 'workflow', input: { name: 'fanout' } }], usage)
            : answer(n === 2 ? 'It runs in the background.' : 'The fan-out is done.', usage),
    });
    const { heard, result } = await serve(model.fetch, async (window, heard) => {
      await window.prompt('[model-parent] run the fanout workflow');
      await until(() => workflowTask(heard, 'fanout')?.status === 'done', 'the workflow to finish');
      await until(() => model.requests('[model-parent]').length === 4, 'the woken turn');
      return texts(model.requests('[model-parent]')[3]!).join('\n');
    });
    expect(heard.cards.map((card) => card.toolCall.title)).toEqual([expect.stringMatching(/^Run workflow fanout: 4 steps/)]);
    expect(result).toContain('<subagent_report agent="workflow fanout"');
  });

  it("B/B-72 ends the model's turn when the user says Don't run, and tells it to wait for the user", async () => {
    const model = models({
      '[model-parent]': (n) =>
        n === 0
          ? toolCall('Loading it.', [loadTools('workflow')], usage)
          : n === 1
            ? toolCall('Starting it.', [{ id: 'tu_wf', name: 'workflow', input: { name: 'fanout' } }], usage)
            : answer('I will do the looks myself instead.', usage),
      '[p1]': () => answer('never', usage),
    });
    const { heard, store, sessionId } = await serve(model.fetch, async (window) => window.prompt('[model-parent] run the fanout workflow'), () => 'reject');
    expect(heard.cards).toHaveLength(1);
    expect(model.requests('[model-parent]')).toHaveLength(2);
    expect(model.requests('[p1]')).toEqual([]);
    const result = (await logOf(store, sessionId)).findLast((e) => e.kind === 'tool-result');
    expect(result).toMatchObject({ status: 'rejected', output: expect.stringMatching(/wait for the user/) });
  });

  it('lists the workflows for /workflow with no name, and names the one it does not know', async () => {
    const model = models({ [PARENT]: () => answer('never', usage), 'List the workflows': () => answer('never', usage) });
    const { store, sessionId } = await serve(model.fetch, async (window) => {
      await window.prompt('/workflow');
      await window.prompt('/workflow nope');
    });
    const outputs = (await logOf(store, sessionId)).flatMap((e) => (e.kind === 'tool-result' && 'output' in e ? [e.output] : []));
    expect(outputs[0]).toContain('- capped: A fix that runs out of money.');
    expect(outputs[0]).toContain('- three: Review, fix, check and verify. Input: What to focus on');
    expect(outputs[1]).toContain('no workflow nope; the workflows are capped, fanout, slow, three');
  });
});
