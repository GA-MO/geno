import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { call, fakeModel, lastUserText, say, type FakeModel, type ModelRequest } from './fake-model.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand, runCli } from './helpers.js';
import { requestKey } from './request-normal.js';

const WIRES = ['anthropic', 'openai'] as const;
type Wire = (typeof WIRES)[number];

const providerEnv = (wire: Wire, url?: string): Record<string, string> =>
  wire === 'anthropic'
    ? { GCODE_PROVIDER: 'modelstudio', GCODE_MODEL: 'qwen3.8-flash', DASHSCOPE_API_KEY: 'sk-fake', DASHSCOPE_BASE_URL: url ?? 'https://ws-1.example.com/apps/anthropic' }
    : { GCODE_PROVIDER: 'openai', GCODE_MODEL: 'gpt-fake', OPENAI_API_KEY: 'sk-fake', GCODE_OPENAI_BASE_URL: `${url ?? 'http://fake-model.test'}/v1` };

/** One `gcode agent` run in a fresh repository and home, against `model` in process or at `url`. */
async function agent(wire: Wire, prompt: string, model: { fetch: FakeModel['fetch'] } | { url: string }) {
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'export const a = 1;\n' } }]));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const env = { GCODE_HOME: home, HOME: home, GCODE_RG: rgCommand(), PATH: process.env['PATH'] ?? '/usr/bin:/bin', ...providerEnv(wire, 'url' in model ? model.url : undefined) };
  return runCli(['agent', '--workspace', workspace, '--non-interactive', prompt], env, 'fetch' in model ? { fetch: model.fetch } : {});
}

const asks = (text: string) => (request: ModelRequest) => lastUserText(request.body).includes(text);

describe.each(WIRES)('the shared fake model on the %s wire', (wire: Wire) => {
  it('serves a scripted tool round trip in order and keeps every request', async () => {
    const model = fakeModel({ script: [call('Reading.', [{ id: 'tu_1', name: 'read', input: { path: 'a.ts' } }]), say('a is 1.')] });
    const run = await agent(wire, 'What is a?', model);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('a is 1.');
    expect(model.requests.map((request) => request.wire)).toEqual([wire, wire]);
    expect(JSON.stringify(model.bodies()[1]), 'the second request carries the tool result').toContain('export const a = 1;');
  });

  it('answers each request with the first unused entry whose predicate matches it', async () => {
    const model = fakeModel({ script: [{ when: asks('second'), answer: say('Two.') }, { when: asks('first'), answer: say('One.') }] });
    expect((await agent(wire, 'the first', model)).stdout).toContain('One.');
    expect((await agent(wire, 'the second', model)).stdout).toContain('Two.');
  });

  it('serves an engine over HTTP from a server that has routes of its own', async () => {
    const model = fakeModel({ script: [say('Over HTTP.')] });
    const server = createServer((req, res) => {
      void model.handle(req, res).then((handled) => handled || void res.writeHead(404).end('not the model'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const run = await agent(wire, 'Hi.', { url });
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout).toContain('Over HTTP.');
      expect(await (await fetch(`${url}/ui`, { method: 'POST', body: '{}' })).text(), 'other routes stay the server’s').toBe('not the model');
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('records a missing answer from the fallback under GCODE_RECORD, then replays it by the request key alone', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'recordings-'));
    const recording = fakeModel({ recording: 'hello', dir, record: 'script', fallback: [say('Recorded hello.')] });
    expect((await agent(wire, 'Say hello.', recording)).code).toBe(0);
    const file = path.join(dir, 'hello.json');
    expect(JSON.parse(readFileSync(file, 'utf8')).entries).toMatchObject([{ wire, answer: { kind: 'say', text: 'Recorded hello.' } }]);

    // Another repository, home, session and scratchpad: only the volatile parts differ, so the key is the same.
    const replay = fakeModel({ recording: 'hello', dir, record: 'off' });
    const run = await agent(wire, 'Say hello.', replay);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain('Recorded hello.');
    expect(replay.misses).toEqual([]);
  });

  it('fails a request it has no recording for, naming the file and how to record it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'recordings-'));
    const model = fakeModel({ recording: 'empty', dir, record: 'off' });
    const run = await agent(wire, 'Say goodbye.', model);
    expect(run.code).not.toBe(0);
    expect(model.misses).toHaveLength(1);
    expect(model.misses[0]).toContain(path.join(dir, 'empty.json'));
    expect(model.misses[0]).toContain('GCODE_RECORD=1');
    expect(model.misses[0]).toContain('Say goodbye.');
    expect(existsSync(path.join(dir, 'empty.json')), 'a replay writes nothing').toBe(false);
  });
});

describe('the request key', () => {
  const body = (text: string, cached: boolean) => ({
    model: 'qwen3.8-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text, ...(cached ? { cache_control: { type: 'ephemeral' } } : {}) }] }],
  });

  it('ignores cache breakpoints, temp paths, mkdtemp suffixes, uuids and dates', async () => {
    const real = await realpath(tmpdir());
    const one = body(`Workspace: ${tmpdir()}/gcode-repo-AbC123/ws\nScratchpad: ${tmpdir()}/s/1a95036b-3c9b-4d97-9817-e56f6e44c3ae\nDate: 2026-10-08`, true);
    const two = body(`Workspace: ${real}/gcode-repo-zZ9q8w/ws\nScratchpad: ${real}/s/0f0f0f0f-1111-4222-8333-444455556666\nDate: 2027-01-31`, false);
    expect(requestKey('anthropic', one)).toBe(requestKey('anthropic', two));
  });

  it('changes with the text, the wire, and which of two ids repeats', () => {
    expect(requestKey('anthropic', body('a', false))).not.toBe(requestKey('anthropic', body('b', false)));
    expect(requestKey('anthropic', body('a', false))).not.toBe(requestKey('openai', body('a', false)));
    const a = '1a95036b-3c9b-4d97-9817-e56f6e44c3ae';
    const b = '0f0f0f0f-1111-4222-8333-444455556666';
    expect(requestKey('anthropic', body(`${a} ${a}`, false))).not.toBe(requestKey('anthropic', body(`${a} ${b}`, false)));
  });
});
