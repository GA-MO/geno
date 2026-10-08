import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { TASK_UPDATE_METHOD, TASKS_CAPABILITY, WORKFLOW_META, WORKFLOWS_CAPABILITY, type TaskUpdate, type WorkflowPreview } from '@g-code/core';
import { engineShared, gcodeAgent } from '../../src/serve.js';
import { appendJournal, journalFile, readJournal } from '../../src/workflows.js';
import { report, say, scripted, to, WIRES, type Wire } from './scripted.js';
import type { ScriptEntry } from '../fake-model.js';

const THREE = {
  description: 'Look twice, then judge.',
  input: 'What to look at',
  steps: [
    { id: 'one', role: 'explore', prompt: '[one] Look at {{input}}.' },
    { id: 'two', role: 'explore', prompt: '[two] Look again.' },
    { id: 'three', role: 'review', prompt: '[three] Judge what they saw:\n{{one}}', schema: { pass: 'boolean' } },
  ],
};
const FILE = '.g-code/workflows/three.json';
const PARENT = 'Run the workflow three';
const PASS = 'It holds.\n\n```json\n{"pass": true}\n```';

async function until(done: () => boolean | Promise<boolean>, what: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** An editor window that shows Tasks and workflows and runs every card; each `/workflow three` waits for its run's end and the woken turn. */
async function workflowWindow(wire: Wire, script: readonly ScriptEntry[]) {
  const run = await scripted(wire, script, { 'a.ts': 'export const alpha = 1;\n', [FILE]: `${JSON.stringify(THREE, null, 2)}\n` });
  run.env['GCODE_WAKE_POLICY'] = JSON.stringify({ batchMs: 50, secondMs: 20 });
  const asked = (marker: string) => run.openings().filter((opening) => opening.first.includes(marker)).length;
  const cards: acp.RequestPermissionRequest[] = [];
  const tasks: TaskUpdate[] = [];
  const runs = () => [...new Set(tasks.flatMap((u) => (u.task.workflow?.name === 'three' ? [u.task.sessionId] : [])))];
  const ended = (id: string) => tasks.some((u) => u.task.sessionId === id && u.task.workflow !== undefined && u.task.workflow.status !== 'running');
  const editor = acp
    .client({ name: 'conformance' })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      cards.push(params);
      return { outcome: { outcome: 'selected', optionId: params.options[0]!.optionId } };
    })
    .onNotification(acp.methods.client.session.update, () => {})
    .onNotification(TASK_UPDATE_METHOD, (raw) => raw as TaskUpdate, ({ params }) => void tasks.push(params));

  type Window = { readonly start: (args: string) => Promise<string>; readonly running: () => string | undefined };
  const session = async <T,>(scenario: (window: Window) => Promise<T>): Promise<T> => {
    const engine = engineShared(run.io);
    try {
      return await editor.connectWith(gcodeAgent(run.io, run.store, { maxTurns: 10, maxCostUsd: 1 }, undefined, engine), async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { _meta: { [TASKS_CAPABILITY]: true, [WORKFLOWS_CAPABILITY]: true } } });
        const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: run.workspace, mcpServers: [] });
        await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: 'auto' });
        const start = async (args: string) => {
          const before = new Set(runs());
          const woken = asked(PARENT);
          const turn = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: `/workflow three ${args}` }] });
          expect(turn.stopReason).toBe('end_turn');
          const idle = async () => {
            const last = (await run.events(sessionId)).findLast((e) => e.kind === 'assistant' || e.kind === 'user');
            return last?.kind === 'assistant' && last.stopReason === 'end_turn';
          };
          await until(async () => runs().some((id) => !before.has(id) && ended(id)) && asked(PARENT) > woken && (await idle()), `/workflow three ${args} to end and its woken turn to finish`);
          return runs().find((id) => !before.has(id))!;
        };
        return scenario({ start, running: () => runs().find((id) => !ended(id)) });
      });
    } finally {
      await engine.jobs.kill('engine-exit', 'all');
    }
  };
  /** The text of the parent's last woken request: the run's report. */
  const lastReport = () => run.seen().at(-1)!.text;
  const journal = async (id: string) => (await readJournal(journalFile(run.store, id))).map((entry) => entry.step);
  const question = (n: number) => cards[n]!.toolCall.title;
  const preview = (n: number) => cards[n]!.toolCall._meta?.[WORKFLOW_META] as WorkflowPreview;
  return { run, asked, session, lastReport, journal, question, preview };
}

const steps = (w: { asked: (marker: string) => number }) => ['[one]', '[two]', '[three]'].map(w.asked);

describe.each(WIRES)('workflow resume on the %s wire', (wire: Wire) => {
  it('T-WF-02 step 3 fails, its cause is fixed, and a resume replays steps 1 and 2 with no model call; resuming again converges', async () => {
    let release = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const w = await workflowWindow(wire, [
      to('[one]', report('alpha is in a.ts:1.')),
      to('[two]', report('Nothing else.')),
      to('[three]', async () => (await released, report('Looks fine to me.'))),
      to(PARENT, say('Step three failed.')),
      to('[three]', report(PASS)),
      to(PARENT, say('Resumed and finished.')),
      to('[three]', report(PASS)),
      to(PARENT, say('Resumed the first run again.')),
      to(PARENT, say('Nothing ran.')),
    ]);

    const result = await w.session(async ({ start, running }) => {
      const firstRun = start('a.ts');
      await until(() => w.asked('[three]') === 1, 'step three to ask its model');
      const inFlight = await w.journal(running()!);
      release();
      const first = await firstRun;
      const failedReport = w.lastReport();
      const second = await start(`--resume ${first}`);
      const secondReport = w.lastReport();
      const afterSecond = steps(w);
      const again = await start(`--resume ${first}`);
      const afterAgain = steps(w);
      const whole = await start(`--resume ${second}`);
      return { first, second, again, whole, inFlight, failedReport, secondReport, afterSecond, afterAgain, wholeReport: w.lastReport() };
    });

    expect(result.inFlight, 'steps 1 and 2 are journaled before step 3 starts, so a crash in step 3 keeps them').toEqual(['one', 'two']);
    expect(result.failedReport).toContain('Workflow three stopped at three: its report has no JSON block with pass (boolean).');
    expect(result.failedReport).toContain('Empty results: 0.');
    expect(result.failedReport).toMatch(/Read step session \S+ before diagnosing three\./);
    expect(await w.journal(result.first)).toEqual(['one', 'two']);

    expect(w.question(1)).toMatch(new RegExp(`^Resume workflow three from run ${result.first}: 3 steps, 2 replayed with no model call, `));
    expect(w.preview(1).input, 'a resume keeps the run input').toBe('a.ts');
    expect(result.afterSecond, 'steps 1 and 2 make no model call on resume').toEqual([1, 1, 2]);
    expect(result.secondReport).toContain(`Workflow three finished: 3 steps ran,`);
    expect(result.secondReport).toContain(`Resumed from run ${result.first}: 2 replayed with no model call.`);
    expect(result.secondReport).toMatch(/- one \(explore\): replayed, no model call, session \S+/);
    expect(await w.journal(result.second), 'the resumed run journals its replays too').toEqual(['one', 'two', 'three']);

    expect(result.afterAgain, 'resuming the first run twice replays the same').toEqual([1, 1, 3]);
    expect(steps(w), 'resuming the resumed run makes no model call').toEqual([1, 1, 3]);
    expect(result.wholeReport).toContain(`Resumed from run ${result.second}: 3 replayed with no model call.`);
    expect(w.run.seen().filter((seen) => seen.text.includes('<subagent_report agent="workflow three"'))).toHaveLength(4);
  });

  it('T-WF-02 a changed prompt for step 2 runs step 2 again and every step after it', async () => {
    const w = await workflowWindow(wire, [
      to('[one]', report('alpha is in a.ts:1.')),
      to('[two]', report('Nothing else.')),
      to('[three]', report(PASS)),
      to(PARENT, say('Done.')),
      to('[two]', report('Still nothing.')),
      to('[three]', report(PASS)),
      to(PARENT, say('Done again.')),
    ]);
    const result = await w.session(async ({ start }) => {
      const first = await start('a.ts');
      const changed = { ...THREE, steps: THREE.steps.map((step) => (step.id === 'two' ? { ...step, prompt: '[two] Look again, closer.' } : step)) };
      writeFileSync(path.join(w.run.workspace, FILE), JSON.stringify(changed));
      const second = await start(`--resume ${first}`);
      return { first, second, report: w.lastReport() };
    });
    expect(steps(w), 'step 1 replays; step 2 and step 3, whose key still matches, run').toEqual([1, 2, 2]);
    expect(w.question(1)).toContain(`from run ${result.first}: 3 steps, 1 replayed with no model call`);
    expect(result.report).toContain(`Resumed from run ${result.first}: 1 replayed with no model call.`);
    expect(await w.journal(result.second)).toEqual(['one', 'two', 'three']);
  });
});

describe('the journal', () => {
  it('reads what a crash left: a line torn while it was written is skipped, so its step runs again, and a run with none has none', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'gcode-journal-')), 'run', 'workflow-journal.jsonl');
    expect(await readJournal(file)).toEqual([]);
    await appendJournal(file, [{ key: 'sha256:1', step: 'one', child: 'c1', result: 'saw it' }]);
    appendFileSync(file, '{"key":"sha256:2","st');
    expect(await readJournal(file)).toEqual([{ key: 'sha256:1', step: 'one', child: 'c1', result: 'saw it' }]);
  });
});
