import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TabServerState } from '@g-code/core/tab';
import { healthy, TabServer, type TabServerPlan } from '../src/tab/server.js';

/** Plays llama-server: logs its arguments, loads for 300 ms, then answers /health; a model file saying crash exits 3. */
const FAKE = (log: string) => `#!${process.execPath}
const fs = require('node:fs');
const http = require('node:http');
const args = process.argv.slice(2);
const arg = (flag) => args[args.indexOf(flag) + 1];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (fs.readFileSync(arg('--model'), 'utf8') === 'crash') setTimeout(() => process.exit(3), 100);
const loaded = Date.now() + 300;
http.createServer((req, res) => res.writeHead(Date.now() > loaded ? 200 : 503).end()).listen(Number(arg('--port')), arg('--host'));
`;

let work: string;
let binary: string;
let model: string;
let states: TabServerState['kind'][];
let server: TabServer;
const servers: Server[] = [];

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

const spawned = async () => (await readFile(path.join(work, 'spawned.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

const plan = async (overrides: Partial<Extract<TabServerPlan, { kind: 'on' }>> = {}): Promise<TabServerPlan> => ({
  kind: 'on',
  endpoint: `http://127.0.0.1:${await freePort()}`,
  model,
  binary,
  ...overrides,
});

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'gcode-tab-server-'));
  binary = path.join(work, 'llama-server');
  model = path.join(work, 'model.gguf');
  await writeFile(binary, FAKE(path.join(work, 'spawned.jsonl')));
  await chmod(binary, 0o755);
  await writeFile(model, 'weights');
  states = [];
  server = new TabServer((state) => states.push(state.kind), () => {});
});

afterEach(async () => {
  server.dispose();
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

describe('the Tab model server', () => {
  it('starts llama-server, is ready once it answers, does not start a second for the same plan, and stops it when Tab turns off', async () => {
    const on = await plan();
    const port = new URL((on as { endpoint: string }).endpoint).port;

    await Promise.all([server.apply(on), server.apply(on)]);
    expect(server.state).toEqual({ kind: 'ready', owned: true });
    expect(states).toEqual(['starting', 'ready']);
    const runs = await spawned();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual(expect.arrayContaining(['--model', model, '--port', port, '--host', '127.0.0.1']));

    await server.apply({ kind: 'off' });
    expect(server.state).toEqual({ kind: 'off' });
    await expect.poll(() => healthy((on as { endpoint: string }).endpoint)).toBe(false);
  });

  it('adopts a server that already answers, and leaves it running when Tab turns off', async () => {
    const running = createServer((_req, res) => res.end('{"status":"ok"}'));
    servers.push(running);
    await new Promise<void>((resolve) => running.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(running.address() as AddressInfo).port}`;

    await server.apply(await plan({ endpoint }));
    expect(server.state).toEqual({ kind: 'ready', owned: false });
    await server.apply({ kind: 'off' });

    expect(await spawned()).toEqual([]);
    expect(await healthy(endpoint)).toBe(true);
  });

  it('fails with the reason when the model, llama-server or a local endpoint is missing, or the server dies', async () => {
    const reasons: string[] = [];
    const reasonOf = async (p: TabServerPlan) => {
      await server.apply(p);
      reasons.push(server.state.kind === 'failed' ? server.state.reason : server.state.kind);
    };
    await reasonOf(await plan({ model: path.join(work, 'missing.gguf') }));
    await reasonOf(await plan({ binary: undefined }));
    await reasonOf(await plan({ endpoint: 'http://192.0.2.1:8012' }));
    await writeFile(model, 'crash');
    await server.apply(await plan());
    await expect.poll(() => server.state).toEqual({ kind: 'failed', reason: 'llama-server exited with code 3' });

    expect(reasons).toEqual([
      `no Tab model at ${path.join(work, 'missing.gguf')}`,
      'llama-server is not in /opt/homebrew/bin, /usr/local/bin or on PATH',
      'nothing answers at http://192.0.2.1:8012',
    ]);
  });
});
