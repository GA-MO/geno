import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect as connectSocket, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { build } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { openWaitOf, TASK_UPDATE_METHOD, TASKS_CAPABILITY, WAITING_META, type TaskUpdate, type TurnEvent, type Waiting } from '@g-code/core';
import type { Io } from '../src/command.js';
import { mcpSessions } from '../src/mcp/sessions.js';
import { engineShared, gcodeAgent } from '../src/serve.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore, type Store } from '../src/store.js';
import { answer, httpError, sseBody, toolCall, type FakeToolUse, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand } from './helpers.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const LIMITS = { maxTurns: 10, maxCostUsd: 1 };
// Probes every 100ms to 400ms, and no jitter on a limit, so the tests wait in milliseconds where the product waits in seconds.
const FAST_WAITS = JSON.stringify({ offline: { firstMs: 100, maxMs: 400, giveUpMs: 60_000 }, limited: { firstMs: 100, maxMs: 400, giveUpMs: 60_000, jitterMs: 0, autoMaxMs: 60_000 } });

type Outage = 'up' | 'reset' | 'closed';

/**
 * A model on a real port, reached through Node's own fetch. It answers its replies in order. Down, it resets every
 * connection it accepts (`reset`) or stops listening (`closed`), probes included. `billed` counts the replies it
 * answered with a whole stream, which is what a provider charges for.
 */
async function modelServer(replies: readonly Reply[]) {
  let state: Outage = 'up';
  const posts: { readonly at: number; readonly body: { messages: { content: unknown }[] } }[] = [];
  let answered = 0;
  let billed = 0;
  const heads: number[] = [];
  const sockets = new Set<Socket>();
  const afterReply = new Map<number, () => void>();
  let onPost: (count: number) => void = () => {};
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let text = '';
      req.setEncoding('utf8').on('data', (chunk: string) => (text += chunk));
      req.on('end', () => resolve(text));
    });
  const server: Server = createServer(async (req, res) => {
    if (state === 'reset') return void req.socket.destroy();
    if (req.method === 'HEAD') {
      heads.push(Date.now());
      return void res.writeHead(404).end();
    }
    const body = JSON.parse(await read(req));
    posts.push({ at: Date.now(), body });
    onPost(posts.length);
    const index = answered++;
    const reply = replies[index];
    if (reply === undefined) return void res.writeHead(500).end('no reply');
    if (reply.failure !== undefined) {
      res.writeHead(reply.failure.status, { 'content-type': 'application/json', ...reply.failure.headers });
      return void res.end(JSON.stringify(reply.failure.body));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sseBody(reply), () => {
      billed++;
      afterReply.get(index)?.();
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/apps/anthropic`,
    posts,
    heads,
    billed: () => billed,
    afterReply: (index: number, then: () => void) => afterReply.set(index, then),
    postCount: (count: number) =>
      new Promise<void>((resolve) => {
        if (posts.length >= count) return resolve();
        onPost = (now) => {
          if (now >= count) resolve();
        };
      }),
    reset: () => {
      state = 'reset';
      for (const socket of sockets) socket.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        state = 'closed';
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
    open: () =>
      new Promise<void>((resolve) => {
        state = 'up';
        server.listen(port, '127.0.0.1', resolve);
      }),
    stop: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

type ModelServer = Awaited<ReturnType<typeof modelServer>>;
const servers: ModelServer[] = [];
const engines: ChildProcess[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const engine of engines.splice(0)) engine.kill('SIGKILL');
});

async function setup(replies: readonly Reply[]) {
  const server = await modelServer(replies);
  servers.push(server);
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'export const a = 1;\n' } }]));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const env = {
    GCODE_HOME: home,
    GCODE_PROVIDER: 'modelstudio',
    DASHSCOPE_API_KEY: 'sk-fake',
    DASHSCOPE_BASE_URL: server.baseUrl,
    GCODE_WAIT_POLICY: FAST_WAITS,
    GCODE_RG: rgCommand(),
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  };
  const log: string[] = [];
  const io: Io = { env, cwd: workspace, out: (l) => log.push(l), err: (l) => log.push(l), write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false };
  const store = openStore(env);
  const shared = engineShared(io);
  return { server, workspace, home, env, io, store, log, agent: () => gcodeAgent(io, store, LIMITS, mcpSessions(store, env), shared) };
}

type Heard = { updates: { sessionId: string; update: acp.SessionUpdate }[]; tasks: TaskUpdate[] };

/** An editor window that shows notices and the tasks list, and hears everything the engine sends. */
function editor() {
  const heard: Heard = { updates: [], tasks: [] };
  let waiters: ((update: TaskUpdate) => void)[] = [];
  const app = acp
    .client({ name: 'test-window' })
    .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: 'selected', optionId: 'reject' } }))
    .onNotification(acp.methods.client.session.update, ({ params }) => void heard.updates.push(params))
    .onNotification(TASK_UPDATE_METHOD, (raw) => raw as TaskUpdate, ({ params }) => {
      heard.tasks.push(params);
      for (const waiter of waiters) waiter(params);
    });
  const taskBecomes = (sessionId: string, status: string) =>
    new Promise<TaskUpdate>((resolve) => {
      const seen = heard.tasks.find((u) => u.task.sessionId === sessionId && u.task.status === status);
      if (seen !== undefined) return resolve(seen);
      waiters.push((u) => {
        if (u.task.sessionId === sessionId && u.task.status === status) resolve(u);
      });
    });
  const initialize = (connection: { agent: acp.AgentContext }) =>
    connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { session: { notices: {} }, _meta: { [TASKS_CAPABILITY]: true } },
    });
  const open = async (agent: acp.AgentApp) => {
    const connection = app.connect(agent);
    await initialize(connection);
    return connection;
  };
  /** The same window on an engine's Unix socket. */
  const dial = async (socket: string) => {
    for (;;) {
      const wire = await new Promise<Socket | undefined>((resolve) => {
        const s = connectSocket(socket);
        s.once('connect', () => resolve(s));
        s.once('error', () => resolve(undefined));
      });
      if (wire !== undefined) {
        const connection = app.connect(acp.ndJsonStream(Writable.toWeb(wire) as WritableStream<Uint8Array>, Readable.toWeb(wire) as ReadableStream<Uint8Array>));
        await initialize(connection);
        return connection;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  return { heard, open, dial, taskBecomes, reset: () => (waiters = []) };
}

/** Each wait the window's running row was told of, null for the end of one. */
const waitsShown = (heard: Heard): (Waiting | null)[] =>
  heard.updates.flatMap(({ update }) => (update.sessionUpdate === 'notice' && update._meta != null && WAITING_META in update._meta ? [update._meta[WAITING_META] as Waiting | null] : []));

const logOf = async (store: Store, sessionId: string): Promise<TurnEvent[]> => [...(await readSessionLog(sessionFile(store, sessionId as never))).events];

const kinds = (events: readonly TurnEvent[]) => events.filter((e) => e.kind !== 'checkpoint').map((e) => e.kind);

let nextId = 0;
const use = (name: string, input: unknown): FakeToolUse => ({ id: `tu_wait_${nextId++}`, name, input });
const limited = (headers: Record<string, string>) => httpError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Requests rate limit exceeded, please try again later.' } }, headers);

describe('a turn that loses the network', () => {
  it('waits while the model server is down, resumes the same call once it is back, bills it once and runs no tool twice', async () => {
    const read = use('read', { path: 'a.ts' });
    const { server, workspace, store, agent } = await setup([toolCall('Reading a.ts.', [read], usage), answer('a.ts exports a.', usage)]);
    // The drop comes between the tool call and the next model call: first connections reset, then nothing listens.
    server.afterReply(0, () => server.reset());
    const window = editor();
    const connection = await window.open(agent());
    const { sessionId } = await connection.agent.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
    const turn = connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'What is in a.ts?' }] });

    const waiting = await window.taskBecomes(sessionId, 'waiting');
    expect(waiting.task.waiting).toMatchObject({ kind: 'offline', resetAt: null });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await server.close();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const back = Date.now();
    await server.open();

    expect((await turn).stopReason).toBe('end_turn');
    expect(Date.now() - back).toBeLessThan(2000);
    const events = await logOf(store, sessionId);
    expect(kinds(events)).toEqual(['session-start', 'user', 'assistant', 'tool-result', 'wait', 'assistant']);
    expect(events.filter((e) => e.kind === 'tool-result' && e.toolUseId === read.id)).toHaveLength(1);
    expect(window.heard.updates.filter(({ update }) => update.sessionUpdate === 'tool_call' && update.toolCallId === read.id)).toHaveLength(1);
    expect(server.billed()).toBe(2);
    expect(server.posts).toHaveLength(2);
    const resent = JSON.stringify(server.posts[1]!.body.messages);
    expect(resent.split(read.id).length - 1).toBe(2);

    const wait = events.find((e) => e.kind === 'wait');
    expect(wait).toMatchObject({ wait: { kind: 'offline', retryAt: expect.any(Number) }, by: { pid: process.pid, cwd: workspace } });
    const answers = events.flatMap((e) => (e.kind === 'assistant' ? [e] : []));
    expect(answers[1]!.timing?.waitMs).toBeGreaterThanOrEqual(2400);
    // Only the two calls that answered cost anything; the waits cost nothing.
    expect(waiting.task.usage?.costUsd).toBeCloseTo(answers[0]!.costUsd!, 10);
    const done = await window.taskBecomes(sessionId, 'done');
    expect(done.task.usage?.costUsd).toBeCloseTo(answers[0]!.costUsd! + answers[1]!.costUsd!, 10);
    expect(done.task.waiting).toBeUndefined();

    const shown = waitsShown(window.heard);
    expect(shown.length).toBeGreaterThan(2);
    expect(shown.slice(0, -1).every((w) => w?.kind === 'offline' && w.since === shown[0]!.since)).toBe(true);
    expect(shown.at(-1)).toBeNull();
    expect(server.heads.length).toBeGreaterThan(0);
    connection.close();
  });

  it('waits out a 429 until its retry-after and sends the call again then', async () => {
    const { server, workspace, store, agent } = await setup([limited({ 'retry-after': '1' }), answer('Done.', usage)]);
    const window = editor();
    const connection = await window.open(agent());
    const { sessionId } = await connection.agent.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
    const response = await connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'Hi' }] });
    expect(response.stopReason).toBe('end_turn');
    const [first, second] = server.posts;
    expect(second!.at - first!.at).toBeGreaterThanOrEqual(1000);
    expect(second!.at - first!.at).toBeLessThan(1600);
    const events = await logOf(store, sessionId);
    expect(kinds(events)).toEqual(['session-start', 'user', 'wait', 'assistant']);
    const wait = events.find((e): e is Extract<TurnEvent, { kind: 'wait' }> => e.kind === 'wait')!;
    expect(wait.wait).toMatchObject({ kind: 'limited', resetAt: expect.any(Number), message: expect.stringContaining('429') });
    expect(second!.at).toBeGreaterThanOrEqual(wait.wait.resetAt!);
    expect(window.heard.tasks.find((u) => u.task.status === 'waiting')?.task.waiting).toMatchObject({ kind: 'limited', resetAt: wait.wait.resetAt });
    expect(server.billed()).toBe(1);
    connection.close();
  });

  it('ends cleanly when the user stops it during a wait, and leaves no wait open in the log', async () => {
    // An hour's limit is past what the default setting resumes by itself, so it holds for the user.
    const { server, workspace, store, agent } = await setup([limited({ 'retry-after': '3600' }), answer('Never.', usage)]);
    const window = editor();
    const connection = await window.open(agent());
    const { sessionId } = await connection.agent.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
    const turn = connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'Hi' }] });
    const waiting = await window.taskBecomes(sessionId, 'waiting');
    expect(waiting.task.waiting).toMatchObject({ kind: 'limited', retryAt: null });
    const stopped = Date.now();
    await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId });
    expect((await turn).stopReason).toBe('cancelled');
    expect(Date.now() - stopped).toBeLessThan(1000);
    const events = await logOf(store, sessionId);
    expect(kinds(events)).toEqual(['session-start', 'user', 'wait', 'error']);
    expect(events.at(-1)).toMatchObject({ kind: 'error', error: 'abort' });
    expect(openWaitOf(events)).toBeUndefined();
    expect((await window.taskBecomes(sessionId, 'stopped')).task.waiting).toBeUndefined();
    expect(waitsShown(window.heard).at(-1)).toBeNull();
    expect(server.posts).toHaveLength(1);
    connection.close();
  });

  it('sends a held call at once on Retry now', async () => {
    const { server, workspace, agent } = await setup([limited({ 'retry-after': '3600' }), answer('Sent early.', usage)]);
    const window = editor();
    const connection = await window.open(agent());
    const { sessionId } = await connection.agent.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
    const turn = connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'Hi' }] });
    await window.taskBecomes(sessionId, 'waiting');
    expect(await connection.agent.request('_gcode/retryNow', { sessionId })).toEqual({ retried: true });
    expect((await turn).stopReason).toBe('end_turn');
    expect(server.posts).toHaveLength(2);
    expect(await connection.agent.request('_gcode/retryNow', { sessionId })).toEqual({ retried: false });
    connection.close();
  });
});

describe('an engine that stops during a wait', () => {
  it('leaves the wait in the log, and the next engine for the folder waits out the rest and resumes the call', async () => {
    const { server, workspace, env, store } = await setup([limited({ 'retry-after': '3' }), answer('Back after the limit.', usage)]);
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
    const window1 = editor();
    const connection1 = await window1.dial(socket);
    const { sessionId } = await connection1.agent.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
    connection1.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'Hi' }] }).catch(() => {});
    const waiting = await window1.taskBecomes(sessionId, 'waiting');
    const resetAt = waiting.task.waiting!.resetAt!;
    first.kill('SIGKILL');
    await new Promise((resolve) => first.once('exit', resolve));

    const left = await logOf(store, sessionId);
    expect(kinds(left)).toEqual(['session-start', 'user', 'wait']);
    expect(left.at(-1)).toMatchObject({ kind: 'wait', wait: { kind: 'limited', resetAt }, by: { pid: first.pid, cwd: workspace } });
    expect(Date.now()).toBeLessThan(resetAt);

    engine();
    const window2 = editor();
    const connection2 = await window2.dial(socket);
    const done = await window2.taskBecomes(sessionId, 'done');
    expect(done.task).toMatchObject({ title: 'Hi', status: 'done' });
    expect(server.posts).toHaveLength(2);
    expect(server.posts[1]!.at).toBeGreaterThanOrEqual(resetAt);
    expect(server.posts[1]!.at - resetAt).toBeLessThan(1500);
    expect(server.billed()).toBe(1);
    const events = await logOf(store, sessionId);
    expect(kinds(events)).toEqual(['session-start', 'user', 'wait', 'assistant']);
    expect(events.filter((e) => e.kind === 'user')).toHaveLength(1);
    expect(stderr.join('')).toContain(`session: ${sessionId} takes up the wait its last engine left`);
    connection2.close();
    expect(JSON.parse(await readFile(sessionFile(store, sessionId as never), 'utf8').then((t) => t.trim().split('\n').at(-1)!))).toMatchObject({ kind: 'assistant' });
  }, 60_000);
});
