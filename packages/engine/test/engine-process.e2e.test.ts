import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { connect as connectSocket, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { BACKEND_META } from '@g-code/core';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { CURSOR_SETUP, type FakeScript } from './fake-acp-agent.js';
import { answer, sseBody, toolCall, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand } from './helpers.js';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fake-acp-agent.ts', import.meta.url));
const TSX = import.meta.resolve('tsx');
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

/** What the engine runs on: this test's Node, or VS Code's extension-host helper as the extension starts it. */
type Runtime = { readonly command: string; readonly env: Readonly<Record<string, string>> };
const NODE: Runtime = { command: process.execPath, env: {} };

/**
 * The extension-host helper of the VS Code that vscode-setup downloads into the main checkout's `.vscode-test`, the
 * binary `process.execPath` names inside VS Code, or why there is none here.
 */
function vscodeHelper(): { readonly ok: true; readonly runtime: Runtime } | { readonly ok: false; readonly reason: string } {
  if (process.platform !== 'darwin') return { ok: false, reason: `Geno's sandbox around an external agent is tested on macOS only, and this is ${process.platform}` };
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).stdout.trim();
  const cache = path.join(common === '' ? process.cwd() : path.dirname(common), '.vscode-test');
  const pattern = new RegExp(`^vscode-darwin-${process.arch}-(\\d+)\\.(\\d+)\\.(\\d+)$`);
  const builds = (existsSync(cache) ? readdirSync(cache) : [])
    .flatMap((name) => {
      const match = pattern.exec(name);
      return match !== null && existsSync(path.join(cache, name, 'is-complete')) ? [{ name, version: match.slice(1).map(Number) }] : [];
    })
    .sort((a, b) => b.version[0]! - a.version[0]! || b.version[1]! - a.version[1]! || b.version[2]! - a.version[2]!);
  if (builds.length === 0) return { ok: false, reason: `no VS Code in ${cache}; the vscode test project downloads one` };
  const frameworks = path.join(cache, builds[0]!.name, 'Visual Studio Code.app/Contents/Frameworks');
  const plugin = readdirSync(frameworks).find((name) => name.endsWith(' Helper (Plugin).app'));
  if (plugin === undefined) return { ok: false, reason: `no extension-host helper in ${frameworks}` };
  const command = path.join(frameworks, plugin, 'Contents/MacOS', plugin.slice(0, -'.app'.length));
  const runtime = { command, env: { ELECTRON_RUN_AS_NODE: '1' } };
  const electron = spawnSync(command, ['-p', 'process.versions.electron'], { env: { ...process.env, ...runtime.env }, encoding: 'utf8' }).stdout.trim();
  if (electron === '' || electron === 'undefined') return { ok: false, reason: `${command} did not run as Electron's Node` };
  return { ok: true, runtime };
}

/** A model on a real port: its replies in order, then a plain answer for anything more, such as a title. */
async function modelServer(replies: readonly Reply[]) {
  const queue = [...replies];
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sseBody(queue.shift() ?? answer('Fine.', usage)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/apps/anthropic`;
}

const servers: Server[] = [];
const engines: ChildProcess[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const engine of engines.splice(0)) engine.kill('SIGKILL');
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The pids of every process under `pid`, itself included. */
function tree(pid: number): number[] {
  const children = new Map<number, number[]>();
  for (const line of execFileSync('ps', ['-ax', '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number) as [number, number];
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found: number[] = [];
  for (const queue = [pid]; queue.length > 0; ) {
    const next = queue.pop()!;
    found.push(next);
    queue.push(...(children.get(next) ?? []));
  }
  return found;
}

/** A repo, a home with a fake Cursor on PATH, and an engine process on a socket with a window dialled to it. */
async function world(replies: readonly Reply[] = []) {
  const repo = await realpath(makeRepo('work', [{ message: 'start', files: { 'a.ts': 'export const a = 1;\n' } }]));
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gp-')));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  mkdirSync(path.join(home, '.cursor/agents'), { recursive: true });
  mkdirSync(bin);
  const calls = path.join(home, '.cursor/agents/calls.jsonl');
  const script: FakeScript = { log: calls, setup: CURSOR_SETUP, turns: { 'one word': [{ text: 'ready' }] } };
  writeFileSync(path.join(home, 'script.json'), JSON.stringify(script));
  writeFileSync(path.join(bin, 'agent'), `#!/bin/sh\nFAKE_ACP_SCRIPT='${path.join(home, 'script.json')}' exec '${process.execPath}' --import '${TSX}' '${FIXTURE}' "$@"\n`);
  chmodSync(path.join(bin, 'agent'), 0o755);
  const env = {
    GCODE_HOME: path.join(root, 'gcode-home'),
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    GCODE_PROVIDER: 'modelstudio',
    DASHSCOPE_API_KEY: 'sk-fake',
    DASHSCOPE_BASE_URL: await modelServer(replies),
    GCODE_CLASSIFIER_MODEL: 'off',
    GCODE_AUTO_WAKE: 'off',
    GCODE_RG: rgCommand(),
  };
  const socket = path.join(root, 'e.sock');
  let stderr = '';
  const spawnEngine = (runtime: Runtime, transport: readonly string[]) => {
    // As the extension starts it: the editor's whole environment, the engine's settings, and the runtime's own.
    const child = spawn(runtime.command, ['--import', TSX, CLI, 'serve', ...transport], { cwd: repo, env: { ...process.env, ...env, ...runtime.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    engines.push(child);
    return child;
  };
  const start = (runtime: Runtime) => spawnEngine(runtime, ['--socket', socket]);
  const updates: acp.SessionNotification[] = [];
  const app = acp
    .client({ name: 'test-window' })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => ({ outcome: { outcome: 'selected', optionId: params.options.find((o) => o.kind === 'allow_once')!.optionId } }))
    .onNotification(acp.methods.client.session.update, ({ params }) => void updates.push(params));
  const initialized = async (stream: acp.Stream) => {
    const connection = app.connect(stream);
    await connection.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    return connection.agent;
  };
  /** An engine on stdio, as Zed runs one, with the window on its stdin and stdout. */
  const startStdio = async (runtime: Runtime) => {
    const child = spawnEngine(runtime, ['--stdio']);
    return { child, agent: await initialized(acp.ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>)) };
  };
  const dial = async () => {
    for (;;) {
      const wire = await new Promise<Socket | undefined>((resolve) => {
        const s = connectSocket(socket);
        s.once('connect', () => resolve(s));
        s.once('error', () => resolve(undefined));
      });
      if (wire !== undefined) return initialized(acp.ndJsonStream(Writable.toWeb(wire) as WritableStream<Uint8Array>, Readable.toWeb(wire) as ReadableStream<Uint8Array>));
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const prompt = (agent: acp.ClientContext, sessionId: string, text: string) => agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
  const text = (sessionId: string) =>
    updates.flatMap((u) => (u.sessionId === sessionId && u.update.sessionUpdate === 'agent_message_chunk' && u.update.content.type === 'text' ? [u.update.content.text] : [])).join('');
  const agentCalls = (): Record<string, any>[] => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
  const events = (sessionId: string) => readSessionLog(sessionFile(openStore(env), sessionId as never)).then((log) => log.events);
  return { repo, socket, start, startStdio, dial, prompt, text, agentCalls, events, stderr: () => stderr };
}

describe('the engine on VS Code’s Electron helper', () => {
  it('starts a session on Cursor inside Geno’s sandbox and answers a prompt', async ({ skip }) => {
    const helper = vscodeHelper();
    if (!helper.ok) return skip(helper.reason);
    const t = await world();
    t.start(helper.runtime);
    const agent = await t.dial();
    const { sessionId } = await agent.request(acp.methods.agent.session.new, { cwd: t.repo, mcpServers: [], _meta: { [BACKEND_META]: { id: 'cursor' } } });
    const done = await t.prompt(agent, sessionId, 'Reply with one word only: ready.');
    expect(done.stopReason, t.stderr()).toBe('end_turn');
    expect(t.text(sessionId), t.stderr()).toBe('ready');
    expect((await t.events(sessionId)).find((e) => e.kind === 'backend-start')).toMatchObject({ sandboxed: true });
    expect(t.stderr()).toMatch(/backend: cursor pid \d+ in Geno’s sandbox/);
  }, 60_000);
});

/** Starts a turn that runs `sleep 37` in Geno's sandbox, and settles once the command runs under `engine`. */
async function sleepingTurn(t: Awaited<ReturnType<typeof world>>, agent: acp.ClientContext, engine: ChildProcess): Promise<void> {
  const { sessionId } = await agent.request(acp.methods.agent.session.new, { cwd: t.repo, mcpServers: [] });
  void t.prompt(agent, sessionId, 'Wait a while').catch(() => {});
  const sleeping = () => {
    const pids = new Set(tree(engine.pid!));
    return execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n').some((line) => pids.has(Number(line.trim().split(/\s+/)[0])) && /\bsleep 37$/.test(line.trim()));
  };
  while (!sleeping()) await new Promise((resolve) => setTimeout(resolve, 50));
}

/** Sends SIGTERM to `engine` and reports how it ended, and what of `started` still runs 2 s later. */
async function terminate(engine: ChildProcess, started: readonly number[]) {
  const sent = Date.now();
  const exited = new Promise<{ code: number | null; signal: string | null; ms: number }>((resolve) => engine.once('exit', (code, signal) => resolve({ code, signal, ms: Date.now() - sent })));
  engine.kill('SIGTERM');
  const exit = await Promise.race([exited, new Promise<string>((resolve) => setTimeout(() => resolve('still running after 4s'), 4000))]);
  const end = Date.now() + 2000;
  while (started.some(alive) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
  return { exit, left: started.filter(alive) };
}

const SLEEP = toolCall('Waiting.', [{ id: 'tu_sleep', name: 'bash', input: { command: 'sleep 37' } }], usage);

const RUNTIMES: [string, typeof vscodeHelper][] = [
  ['Node', () => ({ ok: true, runtime: NODE })],
  ['VS Code’s Electron helper', vscodeHelper],
];

describe('an engine sent SIGTERM', () => {
  it.for(RUNTIMES)('on a socket, on %s, stops the command its turn runs in Geno’s sandbox and its agents, removes its socket and exits within two seconds', { timeout: 60_000 }, async ([, find], { skip }) => {
    const found = find();
    if (!found.ok) return skip(found.reason);
    const t = await world([SLEEP]);
    const engine = t.start(found.runtime);
    const agent = await t.dial();
    const cursor = await agent.request(acp.methods.agent.session.new, { cwd: t.repo, mcpServers: [], _meta: { [BACKEND_META]: { id: 'cursor' } } });
    await t.prompt(agent, cursor.sessionId, 'Reply with one word only: ready.');
    await sleepingTurn(t, agent, engine);
    expect([...new Set(t.agentCalls().map((c) => c['pid'] as number))].filter(alive), 'the lane’s agent runs').toHaveLength(1);
    const { exit, left } = await terminate(engine, tree(engine.pid!));
    expect(exit, t.stderr()).toMatchObject({ code: 0, signal: null, ms: expect.toSatisfy((ms: number) => ms < 2000) });
    expect(existsSync(t.socket), 'the socket is gone').toBe(false);
    expect(left, 'every process the engine started is gone').toEqual([]);
  });

  it('on stdio stops the command its turn runs in Geno’s sandbox and exits within two seconds', async () => {
    const t = await world([SLEEP]);
    const { child: engine, agent } = await t.startStdio(NODE);
    await sleepingTurn(t, agent, engine);
    const { exit, left } = await terminate(engine, tree(engine.pid!));
    expect(exit, t.stderr()).toMatchObject({ code: 0, signal: null, ms: expect.toSatisfy((ms: number) => ms < 2000) });
    expect(left, 'every process the engine started is gone').toEqual([]);
  }, 60_000);
});
