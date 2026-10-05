import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SECRET_ENV_NAMES } from '@g-code/core';
import { chatAnswer, chatFailure, chatToolCall, fakeOpenAiServer } from './fake-openai.js';
import { fakeTransport, httpError } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand, runCli } from './helpers.js';
import { leaksOf } from './no-leak.js';

/** A distinct value for every credential variable any provider reads, set all at once. */
const CANARIES: Readonly<Record<string, string>> = Object.fromEntries(
  SECRET_ENV_NAMES.map((name) => [name, `canary-${name.toLowerCase().replace(/_/g, '-')}-7f3a9c`]),
);
const usage = { prompt: 100, completion: 10, cached: 0 };
const closers: (() => Promise<void>)[] = [];
afterAll(() => Promise.all(closers.map((close) => close())));

describe('no provider key leaks', () => {
  it('into the session log, the store, the workspace, a tool’s output, stdout or stderr', async () => {
    const server = await fakeOpenAiServer([
      chatToolCall('Looking at the environment.', [{ id: 'call_env', name: 'bash', input: { command: 'env' } }], usage),
      chatAnswer('Nothing secret there.', usage),
      chatFailure(401, { error: { message: `Incorrect API key provided: ${CANARIES['OPENAI_API_KEY']}`, type: 'invalid_request_error' } }),
      chatAnswer('OK', usage),
      chatFailure(401, { error: { message: `Incorrect API key provided: ${CANARIES['OPENAI_API_KEY']}` } }),
    ]);
    closers.push(server.close);
    const home = await mkdtemp(path.join(tmpdir(), 'gcode-leak-home-'));
    const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'export const a = 1;\n' } }]));
    const env = {
      ...CANARIES,
      GCODE_HOME: home,
      GCODE_PROVIDER: 'openai',
      GCODE_MODEL: 'gpt-fake',
      GCODE_OPENAI_BASE_URL: server.url,
      DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
      GCODE_RG: rgCommand(),
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    };
    const outputs: Record<string, string> = {};
    const record = <R extends { stdout: string; stderr: string }>(name: string, result: R): R => {
      outputs[`${name} stdout`] = result.stdout;
      outputs[`${name} stderr`] = result.stderr;
      return result;
    };

    const first = record('agent', await runCli(['agent', '--workspace', workspace, '--non-interactive', 'Show the environment'], env));
    expect(first.code).toBe(0);
    const id = /^session: (\S+)$/m.exec(first.stdout)![1]!;
    const refused = record('agent refused', await runCli(['agent', '--session', id, '--non-interactive', 'Again'], env));
    expect(refused.stdout + refused.stderr).toContain('[redacted]');
    record('session show', await runCli(['session', 'show', id], env));
    record('providers test', await runCli(['providers', 'test', 'openai', '--model', 'gpt-fake', '--json'], env));
    record('providers test refused', await runCli(['providers', 'test', 'openai', '--model', 'gpt-fake'], env));
    record('providers models', await runCli(['providers', 'models', 'openai'], env));
    record('providers list', await runCli(['providers', 'list'], env));

    const anthropic = fakeTransport([httpError(401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${CANARIES['DASHSCOPE_API_KEY']}` } })]);
    const modelstudio = record(
      'chat on Model Studio',
      await runCli(['chat', '--provider', 'modelstudio', 'hello'], { ...env, GCODE_MODEL: 'qwen3.8-flash' }, { cwd: workspace, fetch: anthropic.fetch }),
    );
    expect(modelstudio.stdout + modelstudio.stderr).toContain('[redacted]');

    expect(server.chats()).toHaveLength(5);
    expect(leaksOf(Object.values(CANARIES), { dirs: [home, workspace], texts: outputs })).toEqual([]);
  });
});
