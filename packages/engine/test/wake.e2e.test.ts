import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect as connectSocket, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_STOP_METHOD,
  DRAFT_METHOD,
  NOT_USER_LINE,
  openSchedulesOf,
  placeTask,
  REWIND_TURN_METHOD,
  TASK_UPDATE_METHOD,
  TASKS_CAPABILITY,
  type TaskUpdate,
  TURN_SEQ_META,
  type TurnEvent,
  WAKE_CANCEL_METHOD,
  WAKE_META,
  type WakeMark,
} from '@g-code/core';
import type { Io } from '../src/command.js';
import { engineShared, gcodeAgent } from '../src/serve.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore, type Store } from '../src/store.js';
import { answer, fakeTransport, loadTools, sseBody, toolCall, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand } from './helpers.js';

// A wake that never comes must fail here in seconds, never leave a worker waiting.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 15_000 });

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const LIMITS = { maxTurns: 10, maxCostUsd: 1 };
// A batch gathers for 300ms, and a wake-up's minute lasts 1.2s, so the tests wake in milliseconds where the product waits in seconds.
const FAST = { batchMs: 300, secondMs: 20 };
const OUTER_MS = 8000;

function within<T>(work: Promise<T>, step: string, ms = OUTER_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${step}`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function until(done: () => boolean | Promise<boolean>, step: string, ms = OUTER_MS): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${step}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Body = { readonly messages: { readonly role: string; readonly content: unknown }[] };
type Script = (n: number, body: Body) => Reply | Promise<Reply>;

/** One scripted model per conversation, picked by a marker in its first message; each request is recorded. */
function models(scripts: Readonly<Record<string, Script>>) {
  const requests = new Map<string, Body[]>(Object.keys(scripts).map((marker) => [marker, []]));
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Body;
    const marker = Object.keys(scripts).find((m) => JSON.stringify(body.messages[0]).includes(m));
    if (marker === undefined) throw new Error(`no fake model for ${JSON.stringify(body.messages[0]).slice(0, 200)}`);
    const seen = requests.get(marker)!;
    seen.push(body);
    return fakeTransport([await scripts[marker]!(seen.length - 1, body)]).fetch(input, init);
  };
  return { fetch, requests: (marker: string) => requests.get(marker)! };
}

const texts = (body: Body): string[] => (body.messages.at(-1)!.content as { type: string; text?: string }[]).flatMap((b) => (b.type === 'text' ? [b.text!] : []));

async function fixture(env: Record<string, string> = {}) {
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'export const alpha = 1;\n', '.gcode.json': '{ "agentTool": ["ask", "auto"] }\n' } }]));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  return {
    workspace,
    env: {
      GCODE_HOME: home,
      HOME: home,
      GCODE_PROVIDER: 'modelstudio',
      DASHSCOPE_API_KEY: 'sk-fake',
      DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
      GCODE_RG: rgCommand(),
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      GCODE_WAKE_POLICY: JSON.stringify(FAST),
      ...env,
    },
  };
}

type Window = {
  readonly ctx: acp.ClientContext;
  readonly sessionId: string;
  readonly store: Store;
  readonly workspace: string;
  prompt(text: string): Promise<acp.PromptResponse>;
  draft(typing: boolean): Promise<void>;
};

const logOf = async (store: Store, sessionId: string): Promise<TurnEvent[]> => [...(await readSessionLog(sessionFile(store, sessionId as never))).events];
const wakePrompts = (events: readonly TurnEvent[]) => events.filter((e) => e.kind === 'user' && e.from === 'wake');

/**
 * Serves one session to an editor window that shows the Tasks list and says yes to every command, and runs
 * `scenario` while the window stays connected, so the engine has a window to run woken turns for.
 */
async function serve<T>(fetch: typeof globalThis.fetch, scenario: (window: Window, heard: { updates: acp.SessionNotification[]; tasks: TaskUpdate[] }) => Promise<T>, env: Record<string, string> = {}) {
  const { workspace, env: fullEnv } = await fixture(env);
  const store = openStore(fullEnv);
  const io: Io = { env: fullEnv, cwd: workspace, out: () => {}, err: () => {}, write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch };
  const heard = { updates: [] as acp.SessionNotification[], tasks: [] as TaskUpdate[] };
  const client = acp
    .client({ name: 'test-editor' })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => ({
      outcome: { outcome: 'selected', optionId: params.options.find((o) => o.kind === 'allow_once')?.optionId ?? params.options[0]!.optionId },
    }))
    .onNotification(acp.methods.client.session.update, ({ params }) => void heard.updates.push(params))
    .onNotification(TASK_UPDATE_METHOD, (raw) => raw as TaskUpdate, ({ params }) => void heard.tasks.push(params));
  const shared = engineShared(io);
  const { sessionId, result } = await client.connectWith(gcodeAgent(io, store, LIMITS, undefined, shared), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { subagents: {}, _meta: { [TASKS_CAPABILITY]: true } },
    });
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
    const window: Window = {
      ctx,
      sessionId,
      store,
      workspace,
      prompt: (text) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] }),
      draft: (typing) => ctx.notify(DRAFT_METHOD, { sessionId, typing }),
    };
    const result = await scenario(window, heard);
    await shared.jobs.kill('engine-exit', 'all');
    return { sessionId, result };
  });
  return { sessionId, result, store, workspace, heard, events: await logOf(store, sessionId) };
}

const wakeMarks = (updates: readonly acp.SessionNotification[]) =>
  updates.flatMap(({ update }) => (update.sessionUpdate === 'user_message_chunk' && update._meta?.[WAKE_META] !== undefined ? [update._meta[WAKE_META] as WakeMark] : []));

const lastTask = (tasks: readonly TaskUpdate[], sessionId: string) => tasks.findLast((u) => u.task.sessionId === sessionId)?.task;

describe('gcode serve: waking a session when its background work reports', () => {
  it('ends a turn with two background children running, and one woken turn carries both reports', async () => {
    let release1 = () => {};
    let release2 = () => {};
    const released1 = new Promise<void>((resolve) => (release1 = resolve));
    const released2 = new Promise<void>((resolve) => (release2 = resolve));
    const model = models({
      '[parent]': (n) => {
        if (n === 0) {
          return toolCall('Starting two explorers.', [
            { id: 'tu_a', name: 'agent', input: { agent: 'explore', task: '[c1] where is alpha', background: true } },
            { id: 'tu_b', name: 'agent', input: { agent: 'explore', task: '[c2] where is beta', background: true } },
          ], usage);
        }
        return answer(n === 1 ? 'Both explorers are running; I will read their reports when they come.' : 'alpha is in a.ts, and beta is nowhere.', usage);
      },
      '[c1]': async () => (await released1, answer('a.ts:1 defines alpha.', usage)),
      '[c2]': async () => (await released2, answer('No file defines beta.', usage)),
    });
    const { result, events, heard, sessionId } = await serve(model.fetch, async (window, heard) => {
      const ended = await within(window.prompt('[parent] find alpha and beta, in the background'), 'the turn to end while its children run');
      const requestsAtEnd = model.requests('[parent]').length;
      const taskAtEnd = lastTask(heard.tasks, window.sessionId);
      // The second report comes within the batch window of the first.
      release1();
      await sleep(FAST.batchMs / 2);
      release2();
      await until(() => model.requests('[parent]').length === 3, 'the woken turn to call the model');
      await until(() => lastTask(heard.tasks, window.sessionId)?.status === 'done' && model.requests('[parent]').length === 3, 'the woken turn to end');
      await sleep(FAST.batchMs * 3);
      return { ended, requestsAtEnd, taskAtEnd };
    });

    expect(result.ended.stopReason, 'the first turn ends while its children still run').toBe('end_turn');
    expect(result.requestsAtEnd).toBe(2);
    expect(result.taskAtEnd?.wake?.waitsFor.map((w) => w.kind)).toEqual(['children', 'children']);
    expect(placeTask({ task: result.taskAtEnd!, children: [], seenAt: undefined }).attention, 'a session waiting to be woken is still at work').toEqual({ kind: 'working' });
    expect(model.requests('[parent]'), 'one wake for both reports, and nothing after').toHaveLength(3);
    const woken = texts(model.requests('[parent]')[2]!);
    expect(woken.filter((t) => t.startsWith(`${NOT_USER_LINE}\n<subagent_report`))).toHaveLength(2);
    expect(woken.join('\n')).toContain('a.ts:1 defines alpha.');
    expect(woken.join('\n')).toContain('No file defines beta.');
    expect(woken.at(-1)).toContain('Geno started this turn by itself (woke: 2 tasks finished)');
    expect(wakePrompts(events)).toHaveLength(1);
    expect(wakeMarks(heard.updates).map((m) => m.label)).toEqual(['woke: 2 tasks finished']);
    expect(lastTask(heard.tasks, sessionId)?.wake, 'nothing is left to wake for').toBeUndefined();
  });

  it("resumes a finished background child on message_agent, keeps its Tasks row, and the child's new report wakes the session", async () => {
    let childId = '';
    const model = models({
      '[parent]': (n, body) => {
        if (n === 0) return toolCall('Starting an explorer.', [{ id: 'tu_a', name: 'agent', input: { agent: 'explore', task: '[c1] where is alpha', background: true } }, loadTools('message_agent')], usage);
        if (n === 1) {
          childId = /session ([0-9a-f-]{36})/.exec(JSON.stringify(body.messages.at(-1)!.content))![1]!;
          return answer('The explorer is running.', usage);
        }
        if (n === 2) return toolCall('Asking it about beta too.', [{ id: 'tu_m', name: 'message_agent', input: { agent_session: childId, text: 'and beta?' } }], usage);
        return answer(n === 3 ? 'It is looking for beta.' : 'alpha is in a.ts, and beta is nowhere.', usage);
      },
      '[c1]': (n) => toolCall('', [{ id: `tu_report_${n}`, name: 'report', input: { message: n === 0 ? 'a.ts:1 defines alpha.' : 'No file defines beta.' } }], usage),
    });
    const { result, events, heard } = await serve(model.fetch, async (window, heard) => {
      const ended = await within(window.prompt('[parent] find alpha, in the background'), 'the first turn to end while its child runs');
      await until(() => model.requests('[parent]').length === 5, 'the resumed child to wake the session a second time');
      await until(() => lastTask(heard.tasks, window.sessionId)?.status === 'done', 'the second woken turn to end');
      return { ended };
    });

    expect(result.ended.stopReason).toBe('end_turn');
    const parent = model.requests('[parent]');
    const messaged = (parent[3]!.messages.at(-1)!.content as { type: string; content?: unknown }[]).find((b) => b.type === 'tool_result');
    expect(JSON.stringify(messaged?.content)).toMatch(/Resumed explore in the background as subagent session/);
    const [first, resumed] = model.requests('[c1]');
    expect(resumed!.messages.length, "the resumed child's request holds its first run").toBeGreaterThan(first!.messages.length);
    expect(texts(resumed!).join('\n')).toContain('<parent_message>\nand beta?\n</parent_message>');
    expect(texts(parent[4]!).join('\n')).toContain('No file defines beta.');
    expect(wakePrompts(events), 'one wake for each report').toHaveLength(2);
    const rows = heard.tasks.filter((u) => u.task.sessionId === childId).map((u) => u.task.status);
    expect(rows.filter((status, i) => status !== rows[i - 1]), 'one row for the child: running, done, running again, done').toEqual(['running', 'done', 'running', 'done']);
  });

  it('holds a wake while the user types, and wakes once the draft clears', async () => {
    const model = models({
      '[parent]': (n) => {
        if (n === 0) return toolCall('Building in the background.', [{ id: 'tu_bg', name: 'bash', input: { command: 'while [ ! -f go ]; do sleep 0.05; done; echo built', run_in_background: true } }], usage);
        return answer(n === 1 ? 'The build runs; I will look when it ends.' : 'The build finished: built.', usage);
      },
    });
    const { result, events } = await serve(model.fetch, async (window) => {
      await within(window.prompt('[parent] build it'), 'the first turn to end');
      await window.draft(true);
      await writeFile(path.join(window.workspace, 'go'), '');
      const log = sessionFile(window.store, window.sessionId as never);
      await until(async () => (await readFile(log, 'utf8')).includes('"background-end"'), 'the build to end');
      await sleep(FAST.batchMs * 4);
      const whileTyping = model.requests('[parent]').length;
      const clearedAt = Date.now();
      await window.draft(false);
      await until(() => model.requests('[parent]').length === 3, 'the wake after the draft cleared');
      return { whileTyping, wokeAfterMs: Date.now() - clearedAt };
    });

    expect(result.whileTyping, 'no wake while the user types').toBe(2);
    expect(result.wokeAfterMs, 'the wake waits a batch window after the draft cleared').toBeGreaterThanOrEqual(FAST.batchMs - 20);
    const woken = texts(model.requests('[parent]')[2]!);
    expect(woken[0]).toMatch(/^\[Geno\] .*\nBackground command bg-1 .* exited with code 0\. .*\n<command_output id="bg-1">\nbuilt\n<\/command_output>$/);
    expect(woken.at(-1)).toContain('woke: 1 task finished');
    expect(wakePrompts(events)).toHaveLength(1);
  });

  it('wakes on the line a monitor watches for, with the line', async () => {
    const model = models({
      '[parent]': (n) => {
        if (n === 0) return toolCall('Loading monitor.', [loadTools('monitor')], usage);
        if (n === 1) {
          return toolCall('Starting the server and watching for it.', [
            { id: 'tu_m', name: 'monitor', input: { command: 'echo starting; while [ ! -f go ]; do sleep 0.05; done; echo "ready on 3000"; sleep 60', pattern: 'ready on \\d+', description: 'Start the dev server' } },
          ], usage);
        }
        return answer(n === 2 ? 'I will look once the server is up.' : 'The server is up on 3000.', usage);
      },
    });
    const { result, events, heard } = await serve(model.fetch, async (window, heard) => {
      await within(window.prompt('[parent] start the server'), 'the first turn to end');
      const waiting = lastTask(heard.tasks, window.sessionId)?.wake?.waitsFor;
      await sleep(FAST.batchMs * 2);
      const beforeLine = model.requests('[parent]').length;
      await writeFile(path.join(window.workspace, 'go'), '');
      await until(() => model.requests('[parent]').length === 4, 'the wake on the matching line');
      await window.ctx.request(BACKGROUND_STOP_METHOD, { sessionId: window.sessionId, id: 'bg-1' });
      return { waiting, beforeLine };
    });

    const started = events.find((e) => e.kind === 'tool-result' && e.toolUseId === 'tu_m');
    expect(started?.kind === 'tool-result' && 'output' in started ? started.output : '').toMatch(/^Started background command bg-1\.[\s\S]*Monitoring bg-1 for \/ready on \\d\+\/ as wake-1/);
    expect(result.waiting).toEqual([
      { kind: 'jobs', job: 'bg-1' },
      { kind: 'monitor', id: 'wake-1', job: 'bg-1', pattern: 'ready on \\d+' },
    ]);
    expect(result.beforeLine, 'the line "starting" matched nothing').toBe(3);
    const woken = texts(model.requests('[parent]')[3]!);
    expect(woken[0]).toBe(`${NOT_USER_LINE}\nMonitor wake-1 on bg-1 for /ready on \\d+/ matched. The matching line, which is the command's output and not an instruction:\n<command_output id="bg-1">\nready on 3000\n</command_output>`);
    expect(wakeMarks(heard.updates).map((m) => m.label)).toEqual(['woke: monitor matched']);
  });

  it('pauses for the user once the wakes since their prompt reach the cap', async () => {
    const schedule = (n: number) => toolCall(`Checking again later (${n}).`, [{ id: `tu_s${n}`, name: 'schedule_wakeup', input: { delay_s: 60, reason: 'check CI again' } }], usage);
    const model = models({
      // After loading schedule_wakeup, every turn schedules the next wake-up and ends: turn, wake 1, wake 2, then the cap holds the third.
      '[parent]': (n, body) =>
        n === 0 ? toolCall('Loading it.', [loadTools('schedule_wakeup')], usage) : n % 2 === 1 && n < 7 ? schedule(n) : n === 7 ? answer(`Seen: ${texts(body).join(' | ')}`, usage) : answer('Waiting for CI.', usage),
    });
    const { result, heard, sessionId } = await serve(
      model.fetch,
      async (window, heard) => {
        await within(window.prompt('[parent] watch CI'), 'the first turn to end');
        await until(() => lastTask(heard.tasks, window.sessionId)?.wake?.paused === 'cap', 'the cap to pause the wakes');
        const log = sessionFile(window.store, window.sessionId as never);
        await until(async () => (await readFile(log, 'utf8')).split('"kind":"due"').length === 4, 'the third wake-up to come due');
        await sleep(FAST.batchMs * 3);
        const atCap = model.requests('[parent]').length;
        const paused = lastTask(heard.tasks, window.sessionId)!;
        await within(window.prompt('[parent] and now?'), "the user's own next turn");
        return { atCap, paused };
      },
      { GCODE_WAKE_POLICY: JSON.stringify({ ...FAST, cap: 2 }) },
    );

    expect(result.atCap, 'two wakes, and no third').toBe(7);
    expect(placeTask({ task: result.paused, children: [], seenAt: Date.now() }).attention).toEqual({ kind: 'needs-you', reason: 'paused', at: sessionId });
    expect(wakeMarks(heard.updates).map((m) => m.label)).toEqual(['woke: scheduled', 'woke: scheduled']);
    const next = texts(model.requests('[parent]')[7]!).join('\n');
    expect(next, "the held wake-up joins the user's next turn").toContain(`${NOT_USER_LINE}\nScheduled wake-up wake-3 is due: check CI again`);
    expect(next).toContain('and now?');
  });

  it('cancels the wake-up of a turn a rewind cuts', async () => {
    const model = models({
      '[parent]': (n) =>
        n === 0
          ? toolCall('Loading it.', [loadTools('schedule_wakeup')], usage)
          : n === 1
            ? toolCall('Checking later.', [{ id: 'tu_s', name: 'schedule_wakeup', input: { delay_s: 60, reason: 'check CI' } }], usage)
            : answer('I will check CI later.', usage),
    });
    const { result, events, store, sessionId } = await serve(model.fetch, async (window) => {
      const ended = await within(window.prompt('[parent] watch CI'), 'the turn to end');
      const turnSeq = ended._meta?.[TURN_SEQ_META] as number;
      await window.ctx.request(REWIND_TURN_METHOD, { sessionId: window.sessionId, turnSeq, choice: { kind: 'conversation' } });
      // The wake-up was due 1.2s after it was set.
      await sleep(60 * FAST.secondMs + FAST.batchMs * 4);
      return { calls: model.requests('[parent]').length };
    });

    expect(result.calls, 'no woken turn after the rewind').toBe(3);
    expect(openSchedulesOf(events)).toEqual([]);
    const log = await readFile(sessionFile(store, sessionId as never), 'utf8');
    expect(log, 'the wake-up was set before the rewind').toContain('"kind":"scheduled"');
    expect(log).not.toContain('"kind":"due"');
  });

  it("stops waiting on the Tasks list's Cancel: the command runs on and wakes nothing", async () => {
    const model = models({
      '[parent]': (n) => (n === 0 ? toolCall('Building.', [{ id: 'tu_bg', name: 'bash', input: { command: 'while [ ! -f go ]; do sleep 0.05; done; echo built', run_in_background: true } }], usage) : answer('Building.', usage)),
    });
    const { result, events } = await serve(model.fetch, async (window, heard) => {
      await within(window.prompt('[parent] build it'), 'the turn to end');
      const before = lastTask(heard.tasks, window.sessionId)?.wake?.waitsFor;
      await window.ctx.request(WAKE_CANCEL_METHOD, { sessionId: window.sessionId });
      await until(() => lastTask(heard.tasks, window.sessionId)?.wake === undefined, 'the task to stop waiting');
      await writeFile(path.join(window.workspace, 'go'), '');
      const log = sessionFile(window.store, window.sessionId as never);
      await until(async () => (await readFile(log, 'utf8')).includes('"background-end"'), 'the build to end');
      await sleep(FAST.batchMs * 4);
      return { before, calls: model.requests('[parent]').length };
    });

    expect(result.before).toEqual([{ kind: 'jobs', job: 'bg-1' }]);
    expect(result.calls).toBe(2);
    expect(events.map((e) => e.kind).slice(-2)).toEqual(['wake', 'background-end']);
  });
});

/** A model on a real port for engines in their own processes: it answers its replies in order and records each request. */
async function modelServer(replies: readonly Reply[]) {
  const posts: { readonly at: number; readonly body: Body }[] = [];
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let text = '';
      req.setEncoding('utf8').on('data', (chunk: string) => (text += chunk));
      req.on('end', () => resolve(text));
    });
  const server: Server = createServer(async (req, res) => {
    if (req.method === 'HEAD') return void res.writeHead(404).end();
    const body = JSON.parse(await read(req)) as Body;
    posts.push({ at: Date.now(), body });
    const reply = replies[posts.length - 1];
    if (reply === undefined) return void res.writeHead(500).end('no reply');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseBody(reply));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/apps/anthropic`, posts, stop: () => server.close() };
}

const engines: ChildProcess[] = [];
const servers: { stop(): void }[] = [];
afterEach(() => {
  for (const engine of engines.splice(0)) engine.kill('SIGKILL');
  for (const server of servers.splice(0)) server.stop();
});

/** An editor window on an engine's Unix socket that hears the Tasks list. */
async function dial(socket: string) {
  const tasks: TaskUpdate[] = [];
  const app = acp.client({ name: 'test-window' }).onNotification(TASK_UPDATE_METHOD, (raw) => raw as TaskUpdate, ({ params }) => void tasks.push(params));
  for (;;) {
    const wire = await new Promise<Socket | undefined>((resolve) => {
      const s = connectSocket(socket);
      s.once('connect', () => resolve(s));
      s.once('error', () => resolve(undefined));
    });
    if (wire !== undefined) {
      const connection = app.connect(acp.ndJsonStream(Writable.toWeb(wire) as WritableStream<Uint8Array>, Readable.toWeb(wire) as ReadableStream<Uint8Array>));
      await connection.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { _meta: { [TASKS_CAPABILITY]: true } } });
      return { connection, tasks };
    }
    await sleep(25);
  }
}

describe('an engine that stops while a wake-up is pending', () => {
  it('leaves the wake-up in the log, and the next engine for the folder wakes the session when it is due', async () => {
    // A minute of the wake-up lasts 3s here: time to kill the first engine before it is due.
    const secondMs = 50;
    const server = await modelServer([
      toolCall('Loading it.', [loadTools('schedule_wakeup')], usage),
      toolCall('Checking CI later.', [{ id: 'tu_s', name: 'schedule_wakeup', input: { delay_s: 60, reason: 'check CI' } }], usage),
      answer('I will check CI in a minute.', usage),
      answer('CI is green.', usage),
    ]);
    servers.push(server);
    const { workspace, env } = await fixture({ DASHSCOPE_BASE_URL: server.baseUrl, GCODE_WAKE_POLICY: JSON.stringify({ ...FAST, secondMs }) });
    const store = openStore(env);
    const root = await mkdtemp(path.join(tmpdir(), 'gs-'));
    const cli = path.join(root, 'cli.mjs');
    await build({
      entryPoints: [path.resolve('packages/engine/src/embedded.ts')],
      outfile: cli,
      bundle: true,
      platform: 'node',
      format: 'esm',
      logLevel: 'error',
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    });
    const socket = path.join(root, 'e.sock');
    const stderr: string[] = [];
    const engine = () => {
      const child = spawn(process.execPath, [cli, 'serve', '--socket', socket], { cwd: workspace, env: { ...env, HOME: root }, stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr!.setEncoding('utf8').on('data', (chunk: string) => stderr.push(chunk));
      engines.push(child);
      return child;
    };

    const first = engine();
    const window1 = await within(dial(socket), 'the first engine to listen');
    const { sessionId } = await window1.connection.agent.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
    const ended = await within(window1.connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'watch CI' }] }), 'the first turn to end');
    expect(ended.stopReason).toBe('end_turn');
    const [scheduled] = openSchedulesOf(await logOf(store, sessionId));
    expect(scheduled).toMatchObject({ id: 'wake-1', reason: 'check CI', by: { pid: first.pid, cwd: workspace } });
    first.kill('SIGKILL');
    await new Promise((resolve) => first.once('exit', resolve));
    expect(Date.now(), 'the engine stopped before the wake-up was due').toBeLessThan(scheduled!.dueAt);

    const second = engine();
    const window2 = await within(dial(socket), 'the second engine to listen');
    await until(() => window2.tasks.some((u) => u.task.sessionId === sessionId && u.task.status === 'done'), 'the woken turn to end in the second engine', 10_000);
    expect(server.posts).toHaveLength(4);
    expect(server.posts[3]!.at).toBeGreaterThanOrEqual(scheduled!.dueAt);
    const woken = texts(server.posts[3]!.body);
    expect(woken[0]).toBe(`${NOT_USER_LINE}\nScheduled wake-up wake-1 is due: check CI`);
    expect(woken.at(-1)).toContain('woke: scheduled');
    const events = await logOf(store, sessionId);
    const notes = events.flatMap((e) => (e.kind === 'wake' ? [e.note] : []));
    expect(notes.map((n) => [n.kind, n.kind === 'scheduled' ? n.by?.pid : undefined])).toEqual([
      ['scheduled', first.pid],
      ['scheduled', second.pid],
      ['due', undefined],
    ]);
    expect(wakePrompts(events)).toHaveLength(1);
    expect(stderr.join('')).toContain(`session: ${sessionId} takes up the wake-ups its last engine left`);
    window2.connection.close();
  }, 60_000);
});

