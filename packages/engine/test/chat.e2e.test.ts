import { appendFile, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { asSessionId, replayMessages, SYSTEM_PROMPT } from '@g-code/core';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport } from './fake-transport.js';
import { runCli } from './helpers.js';

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-chat-'));
  return { env: { GCODE_HOME: home, OPENROUTER_API_KEY: 'test-key' }, store: openStore({ GCODE_HOME: home }) };
}

const sessionIdOf = (stdout: string): string => /^session: (\S+)$/m.exec(stdout)![1]!;
const ephemeral = { type: 'ephemeral' };

describe('gcode chat', () => {
  it('logs two turns, replays thinking intact, and sends cache breakpoints and the session header', async () => {
    const { env, store } = await setup();
    const transport = fakeTransport([
      answer('Hi there, nice to meet you.', { input: 20, cacheRead: 0, cacheWrite: 1100 }),
      answer('Hello again.', { input: 15, cacheRead: 1100, cacheWrite: 60 }),
    ]);

    const first = await runCli(['chat', 'Say', 'hi'], env, { fetch: transport.fetch });
    expect(first.code).toBe(0);
    const id = sessionIdOf(first.stdout);
    expect(first.stdout.split('\n')[0]).toBe(`session: ${id}`);
    expect(first.stdout).toContain('Hi there, nice to meet you.');
    expect(first.stdout).toMatch(/^usage: in=20 cache_read=0 cache_write=1100 out=42 cost=\$0\.006420 latency=\d+ms$/m);

    const second = await runCli(['chat', '--session', id, 'Now shorter.'], env, { fetch: transport.fetch });
    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(/^usage: in=15 cache_read=1100 cache_write=60 out=42 /m);

    const log = await readSessionLog(sessionFile(store, asSessionId(id)));
    expect(log.events.map((e) => e.kind)).toEqual(['session-start', 'user', 'assistant', 'user', 'assistant']);
    expect(log.session).toMatchObject({ id, workspace: process.cwd(), model: 'anthropic/claude-opus-5.5', effort: 'medium' });

    const sent = transport.requests[1]!;
    expect(sent.headers.get('x-session-id')).toBe(id);
    expect(sent.body.system).toEqual([{ type: 'text', text: SYSTEM_PROMPT, cache_control: ephemeral }]);
    expect(sent.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Say hi' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'pondering 27', signature: 'sig-27' },
          { type: 'text', text: 'Hi there, nice to meet you.', citations: null },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'Now shorter.', cache_control: ephemeral }] },
    ]);
    expect(sent.body.messages).toEqual(
      replayMessages(log.events.slice(0, 4)).with(2, sent.body.messages[2]),
    );
  });

  it('logs an abort after the user turn, exits 130, and answers that message once on resume', async () => {
    const { env, store } = await setup();
    const long = answer('This is a long answer that keeps going and going.', { input: 20, cacheRead: 0, cacheWrite: 1100 });
    const transport = fakeTransport([
      { ...long, stallAfter: 8 },
      answer('Done.', { input: 20, cacheRead: 0, cacheWrite: 1100 }),
    ]);

    const aborted = await runCli(['chat', 'Write a long essay.'], env, {
      fetch: transport.fetch,
      onWrite: (_text, interrupt) => interrupt.abort(),
    });
    expect(aborted.code).toBe(130);
    expect(aborted.stderr).toContain('abort');
    const id = sessionIdOf(aborted.stdout);
    const file = sessionFile(store, asSessionId(id));
    const log = await readSessionLog(file);
    expect(log.events.slice(-2)).toMatchObject([
      { kind: 'user', seq: 1, content: 'Write a long essay.' },
      { kind: 'error', seq: 2, error: 'abort' },
    ]);

    const resumed = await runCli(['chat', '--session', id], env, { fetch: transport.fetch });
    expect(resumed.code).toBe(0);
    expect(transport.requests[1]!.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Write a long essay.', cache_control: ephemeral }] },
    ]);
    expect((await readSessionLog(file)).events.map((e) => e.kind)).toEqual([
      'session-start',
      'user',
      'error',
      'assistant',
    ]);
  });

  it('session show prints each turn with usage, the abort, a torn tail warning, and the totals', async () => {
    const { env, store } = await setup();
    const transport = fakeTransport([
      answer('One.', { input: 20, cacheRead: 0, cacheWrite: 1000 }),
      { ...answer('Two and more.', { input: 10, cacheRead: 1000, cacheWrite: 0 }), stallAfter: 7 },
    ]);
    const id = sessionIdOf((await runCli(['chat', 'first'], env, { fetch: transport.fetch })).stdout);
    await runCli(['chat', '--session', id, 'second'], env, {
      fetch: transport.fetch,
      onWrite: (_text, interrupt) => interrupt.abort(),
    });
    await appendFile(sessionFile(store, asSessionId(id)), '{"kind":"us');

    const shown = await runCli(['session', 'show', id], env);
    expect(shown.code).toBe(0);
    expect(shown.stderr).toMatch(/warning: .*\.jsonl: skipped torn line 6/);
    const lines = shown.stdout.split('\n');
    expect(lines[0]).toBe(`session: ${id}`);
    expect(lines.slice(2)).toEqual([
      '#1 user: first',
      '#2 assistant (end_turn, anthropic/claude-opus-5.5): One.',
      expect.stringMatching(/^ {2}usage: in=20 cache_read=0 cache_write=1000 out=42 cost=\$0\.005920 latency=\d+ms$/),
      '#3 user: second',
      '#4 error (abort): interrupted by the user',
      expect.stringMatching(/^total: turns=1 in=20 cache_read=0 cache_write=1000 out=42 cost=\$0\.005920 latency=\d+ms$/),
    ]);
  });

  it('fails clearly without OPENROUTER_API_KEY and creates no session', async () => {
    const { env, store } = await setup();
    const result = await runCli(['chat', 'hi'], { GCODE_HOME: env.GCODE_HOME });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('OPENROUTER_API_KEY is not set');
    await expect(readdir(store.sessionsDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to resume a session with nothing to answer', async () => {
    const { env } = await setup();
    const transport = fakeTransport([answer('Hi.', { input: 1, cacheRead: 0, cacheWrite: 0 })]);
    const id = sessionIdOf((await runCli(['chat', 'hi'], env, { fetch: transport.fetch })).stdout);
    const result = await runCli(['chat', '--session', id], env, { fetch: transport.fetch });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no unanswered message');
    expect(transport.requests).toHaveLength(1);
  });
});
