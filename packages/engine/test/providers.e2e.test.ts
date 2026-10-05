import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asSessionId } from '@g-code/core';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { chatAnswer, chatFailure, chatToolCall, fakeOpenAiServer } from './fake-openai.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand, runCli } from './helpers.js';

const KEY = 'sk-openai-e2e-canary-0123456789';
const usage = { prompt: 900, completion: 30, cached: 600 };

let servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

async function setup(replies: Parameters<typeof fakeOpenAiServer>[0]) {
  const server = await fakeOpenAiServer(replies);
  servers.push(server);
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const env = {
    GCODE_HOME: home,
    GCODE_PROVIDER: 'openai',
    GCODE_MODEL: 'gpt-fake',
    OPENAI_API_KEY: KEY,
    GCODE_OPENAI_BASE_URL: server.url,
    GCODE_RG: rgCommand(),
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  };
  return { server, env, home };
}

describe('gcode on an OpenAI-compatible server', () => {
  it('runs an agent turn with a tool call over Chat Completions, and logs usage with an unknown cost', async () => {
    const { server, env } = await setup([
      chatToolCall('Reading a.ts.', [{ id: 'call_read', name: 'read', input: { path: 'a.ts' } }], usage),
      chatAnswer('It exports a = 1.', usage),
    ]);
    const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'export const a = 1;\n' } }]));

    const result = await runCli(['agent', '--workspace', workspace, '--non-interactive', 'What does a.ts export?'], env);

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('It exports a = 1.');
    expect(result.stdout).toContain('cost=unknown');
    const chats = server.chats();
    expect(chats).toHaveLength(2);
    expect(chats[0]!.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(chats[0]!.body.tools.map((t: { function: { name: string } }) => t.function.name)).toContain('read');
    const second = chats[1]!.body.messages as { role: string; content: unknown; tool_call_id?: string }[];
    const assistant = second.find((m) => m.role === 'assistant');
    expect(assistant).toMatchObject({ content: 'Reading a.ts.', tool_calls: [{ id: 'call_read', function: { name: 'read', arguments: '{"path":"a.ts"}' } }] });
    expect(second.find((m) => m.role === 'tool')).toMatchObject({ tool_call_id: 'call_read', content: expect.stringContaining('export const a = 1;') });

    const id = /^session: (\S+)$/m.exec(result.stdout)![1]!;
    const log = await readSessionLog(sessionFile(openStore(env), asSessionId(id)));
    expect(log.session).toMatchObject({ provider: 'openai', model: 'gpt-fake' });
    const turns = log.events.filter((e) => e.kind === 'assistant');
    expect(turns[0]).toMatchObject({ usage: { input: 300, cacheRead: 600, cacheWrite: 0, output: 30 }, costUsd: null, stopReason: 'tool_use' });
  });

  it('lists the server’s models', async () => {
    const { env } = await setup([]);
    const result = await runCli(['providers', 'models', 'openai', '--json'], env);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, provider: 'openai', models: ['gpt-fake', 'gpt-fake-mini'] });
  });

  it('tests the connection with one tiny call', async () => {
    const { server, env } = await setup([chatAnswer('OK', { prompt: 12, completion: 1, cached: 0 })]);
    const result = await runCli(['providers', 'test', 'openai', '--model', 'gpt-fake', '--json'], env);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, provider: 'openai', model: 'gpt-fake', reply: 'OK', costUsd: null });
    const [chat] = server.chats();
    expect(chat!.body.messages).toEqual([{ role: 'user', content: 'Reply with the word OK.' }]);
    expect(chat!.body.tools).toBeUndefined();
  });

  it('reports a refused key without echoing it', async () => {
    const { env } = await setup([chatFailure(401, { error: { message: `Incorrect API key provided: ${KEY}.`, type: 'invalid_request_error' } })]);
    const result = await runCli(['providers', 'test', 'openai', '--model', 'gpt-fake', '--json'], env);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ ok: false, provider: 'openai' });
    expect(report.error).toContain('401');
    expect(report.error).toContain('[redacted]');
    expect(result.stdout + result.stderr).not.toContain(KEY);
  });

  it('names what a provider still needs instead of calling it', async () => {
    const result = await runCli(['providers', 'test', 'azure-openai', '--model', 'x', '--json'], { AZURE_OPENAI_API_KEY: 'k-0123456789' });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ ok: false, provider: 'azure-openai', error: 'GCODE_AZURE_OPENAI_BASE_URL is not set; put https://<resource>.openai.azure.com/openai/v1 in it' });
  });

  it('lists every provider with its format and what is set, never a value', async () => {
    const result = await runCli(['providers', 'list'], { OPENAI_API_KEY: KEY, DASHSCOPE_API_KEY: 'sk-ms-0123456789' });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^openai\s+openai\s+ready$/m);
    expect(result.stdout).toMatch(/^modelstudio\s+anthropic\s+needs DASHSCOPE_BASE_URL$/m);
    expect(result.stdout).toMatch(/^ollama\s+openai\s+ready$/m);
    expect(result.stdout.split('\n').filter(Boolean)).toHaveLength(15);
    expect(result.stdout).not.toContain(KEY);
  });
});
