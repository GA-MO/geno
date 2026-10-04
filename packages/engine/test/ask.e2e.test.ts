import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { asSessionId, TOOL_DEFINITIONS, type Session, type TurnEvent } from '@g-code/core';
import { appendEvent, readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, toolCall } from './fake-transport.js';
import { rgCommand, runCli } from './helpers.js';

async function setup() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-ask-')));
  const workspace = path.join(root, 'ws');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'src', 'config.ts'), "export const SERVER_URL = process.env.SERVER_URL ?? '';\n");
  const home = path.join(root, 'home');
  const env = {
    GCODE_HOME: home,
    GCODE_PROVIDER: 'modelstudio',
    DASHSCOPE_API_KEY: 'sk-test',
    DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
    GCODE_RG: rgCommand(),
  };
  return { workspace, env, store: openStore(env) };
}

const sessionIdOf = (stdout: string): string => /^session: (\S+)$/m.exec(stdout)![1]!;
const usage = { input: 2000, cacheRead: 0, cacheWrite: 0 };
const ephemeral = { type: 'ephemeral' };
const kinds = (events: readonly TurnEvent[]) => events.map((e) => (e.kind === 'error' ? `error:${e.error}` : e.kind));

describe('gcode ask', () => {
  it('runs a tool, feeds its result back, prints the call and the answer, and exits 0', async () => {
    const { workspace, env, store } = await setup();
    const transport = fakeTransport([
      toolCall('Searching.', [{ id: 'tu_1', name: 'grep', input: { pattern: 'SERVER_URL', path: 'src/**' } }], usage),
      answer('SERVER_URL is read in src/config.ts line 1.', { ...usage, cacheRead: 1800 }),
    ]);

    const result = await runCli(['ask', '--workspace', workspace, 'Where', 'is', 'SERVER_URL', 'read?'], env, { fetch: transport.fetch });
    expect(result.code).toBe(0);
    expect(result.stdout.split('\n')).toEqual([
      expect.stringMatching(/^session: /),
      'Searching.',
      '> grep "SERVER_URL" src/**',
      'SERVER_URL is read in src/config.ts line 1.',
      // (4000 * 0.15 + 1800 * 0.15 + 72 * 0.47) / 1e6 at qwen3.8-flash rates.
      'usage: in=4000 cache_read=1800 cache_write=0 out=72 cost=$0.000904 turns=2',
    ]);

    const id = sessionIdOf(result.stdout);
    const log = await readSessionLog(sessionFile(store, asSessionId(id)));
    expect(kinds(log.events)).toEqual(['session-start', 'user', 'assistant', 'tool-result', 'assistant']);
    expect(log.session).toMatchObject({ workspace, provider: 'modelstudio', model: 'qwen3.8-flash' });
    expect(log.events[3]).toMatchObject({
      kind: 'tool-result',
      seq: 3,
      toolUseId: 'tu_1',
      name: 'grep',
      status: 'ok',
      output: "src/config.ts:1:export const SERVER_URL = process.env.SERVER_URL ?? '';",
    });

    const [first, second] = transport.requests;
    expect(first!.body.tools).toEqual(TOOL_DEFINITIONS);
    expect(second!.body.tools).toEqual(first!.body.tools);
    expect(second!.body.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'tu_1',
          content: "src/config.ts:1:export const SERVER_URL = process.env.SERVER_URL ?? '';",
          cache_control: ephemeral,
        },
      ],
    });
  });

  it('stops a model that never ends its turn at --max-turns, logs why, and exits 3', async () => {
    const { workspace, env, store } = await setup();
    const forever = Array.from({ length: 5 }, (_, i) =>
      toolCall('Looking.', [{ id: `tu_${i}`, name: 'list', input: {} }], usage),
    );
    const transport = fakeTransport(forever);

    const result = await runCli(['ask', '--workspace', workspace, '--max-turns', '3', 'Loop.'], env, { fetch: transport.fetch });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('max-turns: stopped after 3 model calls (--max-turns 3)');
    expect(result.stdout).toMatch(/^usage: in=6000 .* turns=3$/m);
    expect(transport.requests).toHaveLength(3);
    const log = await readSessionLog(sessionFile(store, asSessionId(sessionIdOf(result.stdout))));
    expect(kinds(log.events).slice(-3)).toEqual(['assistant', 'tool-result', 'error:max-turns']);
  });

  it('stops when the estimated cost passes --max-cost and exits 3', async () => {
    const { workspace, env } = await setup();
    const transport = fakeTransport([
      toolCall('Looking.', [{ id: 'tu_1', name: 'list', input: {} }], usage),
      toolCall('Looking.', [{ id: 'tu_2', name: 'list', input: {} }], usage),
    ]);
    const result = await runCli(['ask', '--workspace', workspace, '--max-cost', '0.0001', 'Spend.'], env, { fetch: transport.fetch });
    expect(result.code).toBe(3);
    expect(result.stderr).toMatch(/budget: stopped at an estimated \$0\.000314, past --max-cost 0\.0001/);
    expect(transport.requests).toHaveLength(1);
  });

  it('after a crash between running tools and logging them, re-runs only the tools with no logged result', async () => {
    const { workspace, env, store } = await setup();
    const session: Session = {
      id: asSessionId('crashed'),
      createdAt: '2026-10-04T00:00:00.000Z',
      workspace,
      provider: 'modelstudio',
      model: 'qwen3.8-flash',
      effort: 'medium',
    };
    const at = session.createdAt;
    const file = sessionFile(store, session.id);
    const logged: TurnEvent[] = [
      { kind: 'session-start', session },
      { kind: 'user', seq: 1, at, content: 'Where is SERVER_URL?' },
      {
        kind: 'assistant',
        seq: 2,
        at,
        content: [
          { type: 'tool_use', id: 'tu_a', name: 'grep', input: { pattern: 'SERVER_URL' }, caller: { type: 'direct' } },
          { type: 'tool_use', id: 'tu_b', name: 'read', input: { path: 'src/config.ts' }, caller: { type: 'direct' } },
        ],
        stopReason: 'tool_use',
        usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
        costUsd: 0,
        latencyMs: 1,
        model: 'qwen3.8-flash',
      },
      { kind: 'tool-result', seq: 3, at, toolUseId: 'tu_a', name: 'grep', status: 'ok', output: 'LOGGED BEFORE THE CRASH' },
    ];
    for (const event of logged) await appendEvent(file, event);
    const transport = fakeTransport([answer('In src/config.ts.', usage)]);

    const result = await runCli(['ask', '--session', 'crashed'], env, { fetch: transport.fetch });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('> read src/config.ts');
    expect(result.stdout).not.toContain('> grep');

    const events = (await readSessionLog(file)).events;
    expect(kinds(events)).toEqual(['session-start', 'user', 'assistant', 'tool-result', 'tool-result', 'assistant']);
    expect(events[4]).toMatchObject({ seq: 4, toolUseId: 'tu_b', status: 'ok' });
    expect(transport.requests[0]!.body.messages.at(-1).content).toEqual([
      { type: 'tool_result', tool_use_id: 'tu_a', content: 'LOGGED BEFORE THE CRASH' },
      {
        type: 'tool_result',
        tool_use_id: 'tu_b',
        content: "1\texport const SERVER_URL = process.env.SERVER_URL ?? '';",
        cache_control: ephemeral,
      },
    ]);
  });

  it('logs an interrupt during tool execution as an abort, exits 130, and runs those tools on resume', async () => {
    const { workspace, env, store } = await setup();
    const transport = fakeTransport([
      toolCall('Searching.', [{ id: 'tu_1', name: 'glob', input: { pattern: '**/*.ts' } }], usage),
      answer('One file.', usage),
    ]);
    const interrupted = await runCli(['ask', '--workspace', workspace, 'Which files?'], env, {
      fetch: transport.fetch,
      // The newline after streamed text is written once the model call has finished, so tools run next.
      onWrite: (text, interrupt) => {
        if (text === '\n') interrupt.abort();
      },
    });
    expect(interrupted.code).toBe(130);
    expect(interrupted.stderr).toContain('abort: interrupted by the user');
    const id = sessionIdOf(interrupted.stdout);
    const file = sessionFile(store, asSessionId(id));
    expect(kinds((await readSessionLog(file)).events)).toEqual(['session-start', 'user', 'assistant', 'error:abort']);

    const resumed = await runCli(['ask', '--session', id], env, { fetch: transport.fetch });
    expect(resumed.code).toBe(0);
    expect(resumed.stdout).toContain('> glob "**/*.ts"');
    expect(kinds((await readSessionLog(file)).events)).toEqual([
      'session-start',
      'user',
      'assistant',
      'error:abort',
      'tool-result',
      'assistant',
    ]);
  });

  it('refuses to resume a finished session without a new question', async () => {
    const { workspace, env } = await setup();
    const transport = fakeTransport([answer('Done.', usage)]);
    const id = sessionIdOf((await runCli(['ask', '--workspace', workspace, 'hi'], env, { fetch: transport.fetch })).stdout);
    const result = await runCli(['ask', '--session', id], env, { fetch: transport.fetch });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('nothing left to answer');
  });

  it('rejects a workspace that is not a directory before creating a session', async () => {
    const { workspace, env } = await setup();
    const result = await runCli(['ask', '--workspace', path.join(workspace, 'missing'), 'hi'], env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('is not a directory');
  });
});
