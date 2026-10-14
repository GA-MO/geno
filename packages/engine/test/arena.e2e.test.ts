import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import {
  ARENA_COMPARE_METHOD,
  ARENA_NEW_METHOD,
  ARENA_PICK_METHOD,
  ARENA_PREVIEW_METHOD,
  ARENA_UPDATE_METHOD,
  ARENAS_METHOD,
  hunkIdOf,
  LANE_APPLY_META,
  LANE_GRAFT_META,
  REVIEW_METHOD,
  SEEDS,
  TASKS_CAPABILITY,
  TASKS_METHOD,
  type TasksResponse,
  type ArenaCompareResponse,
  type ArenaNewResponse,
  type ArenaPreviewResponse,
  type ArenaRun,
  type ArenasResponse,
  type ArenaUpdate,
  type ReviewResponse,
} from '@g-code/core';
import type { Io } from '../src/command.js';
import { mcpSessions } from '../src/mcp/sessions.js';
import { engineShared, gcodeAgent } from '../src/serve.js';
import { openStore } from '../src/store.js';
import { answer, handBack, httpError, sseBody, toolCall, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand } from './helpers.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const A_TS = 'one\ntwo\nthree\n';
const B_TS = 'x\n';
const TASK = 'Make line two louder';
const edit = (id: string, file: string, from: string, to: string) => ({ id, name: 'edit', input: { path: file, old_str: from, new_str: to } });

/** Each lane's turns by step, keyed by what its prompt says; the plain lane has no seed text. */
const read = (id: string, file: string) => ({ id, name: 'read', input: { path: file } });
type Scripts = Readonly<Record<'A' | 'B' | 'C' | 'review', readonly Reply[]>>;
const SCRIPTS: Scripts = {
  A: [toolCall('Reading.', [read('tu_a0', 'a.ts')], usage), toolCall('Editing.', [edit('tu_a1', 'a.ts', 'two', 'TWO')], usage), toolCall('And a line.', [edit('tu_a2', 'a.ts', 'three', 'three\nfour')], usage), answer('Done in A.', usage)],
  B: [toolCall('Reading.', [read('tu_b0', 'a.ts'), read('tu_b00', 'b.ts')], usage), toolCall('Editing.', [edit('tu_b1', 'a.ts', 'two', 'Two'), edit('tu_b2', 'b.ts', 'x', 'y')], usage), answer('Done in B.', usage)],
  C: [toolCall('Reading.', [read('tu_c0', 'a.ts')], usage), toolCall('Editing.', [edit('tu_c1', 'a.ts', 'two', 'BAD')], usage), answer('Done in C.', usage)],
  review: [
    handBack(
      ['B is the smaller change.', '```json', '{"ranking": [{"lane": "B", "reason": "Smallest change that does it."}, {"lane": "A", "reason": "Adds an unasked line."}], "summary": "B wins on scope."}', '```'].join('\n'),
      usage,
    ),
  ],
};

function router(scripts: Scripts) {
  const requests: { script: keyof Scripts; body: string }[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const body = String(init?.body);
    const parsed = JSON.parse(body) as { messages: { content: unknown }[] };
    const first = JSON.stringify(parsed.messages[0]?.content);
    const script: keyof Scripts = first.includes('lanes each tried the task') ? 'review' : first.includes(SEEDS.minimal.text) ? 'B' : first.includes(SEEDS.idiomatic.text) ? 'C' : 'A';
    requests.push({ script, body });
    const step = (parsed.messages as { role?: string }[]).filter((m) => m.role === 'assistant').length;
    const reply = scripts[script][step];
    if (reply === undefined) throw new Error(`no step ${step} for ${script}`);
    if (reply.failure !== undefined) return new Response(JSON.stringify(reply.failure.body), { status: reply.failure.status, headers: { 'content-type': 'application/json' } });
    return new Response(sseBody(reply), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch, requests };
}

async function setup(scripts = SCRIPTS) {
  const repo = await realpath(makeRepo('main', [{ message: 'start', files: { 'a.ts': A_TS, 'b.ts': B_TS, '.gcode.json': '{ "check": "! grep -q BAD a.ts" }\n' } }]));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const env = { GCODE_HOME: home, GCODE_PROVIDER: 'modelstudio', DASHSCOPE_API_KEY: 'sk-fake', DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic', GCODE_RG: rgCommand(), PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home };
  const model = router(scripts);
  const io: Io = { env, cwd: repo, out: () => {}, err: () => {}, write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch: model.fetch };
  const store = openStore(env);
  const runs: ArenaRun[] = [];
  const writes: acp.WriteTextFileRequest[] = [];
  const window = acp
    .client({ name: 'test-window' })
    .onRequest(acp.methods.client.fs.readTextFile, ({ params }) => ({ content: readFileSync(params.path, 'utf8') }))
    .onRequest(acp.methods.client.fs.writeTextFile, ({ params }) => {
      writes.push(params);
      writeFileSync(params.path, params.content);
      return {};
    })
    .onNotification(ARENA_UPDATE_METHOD, (raw) => raw as ArenaUpdate, ({ params }) => void runs.push(params.run));
  const connection = window.connect(gcodeAgent(io, store, { maxTurns: 10, maxCostUsd: 1 }, mcpSessions(store, env), engineShared(io)));
  await connection.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, _meta: { [TASKS_CAPABILITY]: true } },
  });
  const settled = async () => {
    while (!runs.some((run) => run.status !== 'running' && run.status !== 'ranking')) await new Promise((resolve) => setTimeout(resolve, 20));
    return runs.find((run) => run.status !== 'running' && run.status !== 'ranking')!;
  };
  return { repo, home, agent: connection.agent, model, runs, writes, settled };
}

describe('the Arena over ACP', () => {
  it('previews, runs best-of-3, checks each lane, ranks the passing ones, compares, picks, applies the winner and grafts a hunk', async () => {
    const { repo, home, agent, model, runs, writes, settled } = await setup();
    const { sessionId: chat } = await agent.request(acp.methods.agent.session.new, { cwd: repo, mcpServers: [] });

    const preview = await agent.request<ArenaPreviewResponse>(ARENA_PREVIEW_METHOD, { cwd: repo, n: 3 });
    expect(preview.preview).toEqual({ n: 3, perLaneUsd: 0.032, reviewMaxUsd: 0.05, totalUsd: 3 * 0.032 + 0.05, basis: { kind: 'default' } });
    expect(preview.variants.map((v) => v.seed)).toEqual(['plain', 'minimal', 'idiomatic']);
    await expect(agent.request(ARENA_PREVIEW_METHOD, { cwd: repo, n: 5 })).rejects.toThrow(/2 to 4/);

    const { run: started } = await agent.request<ArenaNewResponse>(ARENA_NEW_METHOD, { cwd: repo, task: TASK, n: 3 });
    expect(started.lanes.map((l) => [l.letter, l.lane, l.status])).toEqual([
      ['A', 'make-line-two-louder-a', 'running'],
      ['B', 'make-line-two-louder-b', 'running'],
      ['C', 'make-line-two-louder-c', 'running'],
    ]);
    const ranked = await settled();
    expect(readFileSync(path.join(repo, 'a.ts'), 'utf8')).toBe(A_TS);
    expect(writes).toEqual([]);

    expect(ranked.status).toBe('ranked');
    expect(ranked.lanes.map((l) => [l.letter, l.status, l.check?.outcome, l.rank, l.reason])).toEqual([
      ['A', 'passed', 'passed', 2, 'Adds an unasked line.'],
      ['B', 'passed', 'passed', 1, 'Smallest change that does it.'],
      ['C', 'failed', 'failed', null, null],
    ]);
    expect(ranked.lanes.every((l) => l.turns > 0 && (l.costUsd ?? 0) > 0)).toBe(true);
    expect(ranked.summary).toBe('B wins on scope.');
    expect(ranked.review?.report).toMatch(/^<subagent_report agent="review" session="[^"]+" status="done" turns="1" cost="\$\d+\.\d{4}" duration="\d+s">/);
    expect(runs.map((r) => r.status)).toContain('ranking');

    // The run is a task of its own, and its lanes roll up into it.
    const { tasks } = await agent.request<TasksResponse>(TASKS_METHOD, {});
    expect(tasks.find((t) => t.sessionId === started.id)).toMatchObject({ kind: 'arena', status: 'done', parent: null, title: `Best of 3: ${TASK}` });
    expect(started.lanes.map((l) => tasks.find((t) => t.sessionId === l.sessionId)?.parent)).toEqual([started.id, started.id, started.id]);

    // The review saw the two passing lanes' diffs and not the failed one's, and the chat's model was never called for it.
    const reviews = model.requests.filter((r) => r.script === 'review');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.body).toContain('## Lane A (make-line-two-louder-a): As asked');
    expect(reviews[0]!.body).toContain('## Lane B (make-line-two-louder-b): Minimal change');
    expect(reviews[0]!.body).not.toContain('Lane C');
    expect(reviews[0]!.body).toContain('+Two');

    const listed = await agent.request<ArenasResponse>(ARENAS_METHOD, { cwd: repo });
    expect(listed.arenas.map((r) => [r.id, r.status])).toEqual([[ranked.id, 'ranked']]);

    const compare = await agent.request<ArenaCompareResponse>(ARENA_COMPARE_METHOD, { cwd: repo, id: ranked.id });
    expect(compare.diffs.map((d) => [d.lane, d.changes.map((c) => [c.path, c.hunks.length])])).toEqual([
      ['make-line-two-louder-a', [['a.ts', 2]]],
      ['make-line-two-louder-b', [['a.ts', 1], ['b.ts', 1]]],
      ['make-line-two-louder-c', [['a.ts', 1]]],
    ]);

    await expect(agent.request(ARENA_PICK_METHOD, { cwd: repo, id: ranked.id, lane: 'make-line-two-louder-c' })).rejects.toThrow(/did not pass/);
    const picked = await agent.request<ArenaNewResponse>(ARENA_PICK_METHOD, { cwd: repo, id: ranked.id, lane: 'make-line-two-louder-b' });
    expect(picked.run.winner).toBe('make-line-two-louder-b');

    const applied = await agent.request(acp.methods.agent.session.prompt, { sessionId: chat, prompt: [{ type: 'text', text: 'Apply lane make-line-two-louder-b' }], _meta: { [LANE_APPLY_META]: 'make-line-two-louder-b' } });
    expect(applied.stopReason).toBe('end_turn');
    expect(readFileSync(path.join(repo, 'a.ts'), 'utf8')).toBe('one\nTwo\nthree\n');
    expect(readFileSync(path.join(repo, 'b.ts'), 'utf8')).toBe('y\n');

    // A's added line grafts cleanly over the winner; A's own take on line two overlaps the winner's and conflicts.
    const [aChange] = compare.diffs[0]!.changes;
    const graft = (hunks: string[]) =>
      agent.request(acp.methods.agent.session.prompt, { sessionId: chat, prompt: [{ type: 'text', text: 'Graft from lane A' }], _meta: { [LANE_GRAFT_META]: { lane: 'make-line-two-louder-a', hunks } } });
    await graft([hunkIdOf(aChange!, 0)]);
    expect(readFileSync(path.join(repo, 'a.ts'), 'utf8')).toBe('one\nTwo\nthree\n');
    await graft([hunkIdOf(aChange!, 1)]);
    expect(readFileSync(path.join(repo, 'a.ts'), 'utf8')).toBe('one\nTwo\nthree\nfour\n');
    await expect(graft(['0000000000000000:0'])).rejects.toThrow(/changed since the compare/);

    const review = await agent.request<ReviewResponse>(REVIEW_METHOD, { sessionId: chat, decisions: [] });
    expect(review.hunks.map((h) => [path.basename(h.path), h.oldText, h.newText, h.status])).toEqual([
      ['a.ts', 'two\n', 'Two\n', 'pending'],
      ['b.ts', 'x\n', 'y\n', 'pending'],
      ['a.ts', '', 'four\n', 'pending'],
    ]);
  });

  it('counts a lane whose turn ended on a model error as failed, though its edit would pass the check', async () => {
    const BAD_REQUEST = httpError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages.2.content.0: unexpected tool_use_id' } });
    const { repo, agent, settled } = await setup({ ...SCRIPTS, A: [toolCall('Editing.', [edit('tu_a1', 'a.ts', 'two', 'TWO')], usage), BAD_REQUEST] });
    await agent.request<ArenaNewResponse>(ARENA_NEW_METHOD, { cwd: repo, task: TASK, n: 2 });
    const ended = await settled();
    expect(ended.lanes.map((l) => [l.letter, l.status])).toEqual([
      ['A', 'failed'],
      ['B', 'passed'],
    ]);
  });
});
