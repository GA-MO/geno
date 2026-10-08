import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { asSessionId, PARTS, type SessionSpend, type TurnEvent } from '@g-code/core';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { fakeModel } from './fake-model.js';
import { answer, toolCall } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand, runCli } from './helpers.js';

async function setup(files: Record<string, string>) {
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files }]));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const env = {
    GCODE_HOME: home,
    GCODE_PROVIDER: 'modelstudio',
    DASHSCOPE_API_KEY: 'sk-fake',
    DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
    GCODE_RG: rgCommand(),
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  };
  return { workspace, env, store: openStore(env) };
}

const sessionIdOf = (stdout: string): string => /^session: (\S+)$/m.exec(stdout)![1]!;

describe('gcode usage', () => {
  it('logs each request split into parts and prints where the session’s tokens went', async () => {
    const { workspace, env, store } = await setup({ 'a.ts': `${'export const a = 1;\n'.repeat(400)}` });
    // Recorded: a change to either request misses here, with the file to record again, before the usage is checked.
    const model = fakeModel({
      recording: 'usage-e2e',
      fallback: [
        { anthropic: toolCall('Reading.', [{ id: 'tu_1', name: 'read', input: { path: 'a.ts' } }], { input: 200, cacheRead: 0, cacheWrite: 6000 }) },
        { anthropic: answer('It exports a.', { input: 3000, cacheRead: 6000, cacheWrite: 0 }) },
      ],
    });
    const ran = await runCli(['agent', '--workspace', workspace, '--non-interactive', 'What does a.ts export?'], env, { fetch: model.fetch });
    expect(model.misses).toEqual([]);
    expect(ran.code).toBe(0);
    const id = sessionIdOf(ran.stdout);
    const calls = (await readSessionLog(sessionFile(store, asSessionId(id)))).events.filter((e): e is Extract<TurnEvent, { kind: 'assistant' }> => e.kind === 'assistant');
    expect(calls.map((c) => c.promptParts?.map(([part]) => part)[0])).toEqual(['tools', 'tools']);
    expect(calls[1]!.promptParts!.some(([part]) => part === 'files')).toBe(true);

    const json = await runCli(['usage', '--session', id, '--json'], env);
    expect(json.code).toBe(0);
    const spend = JSON.parse(json.stdout) as SessionSpend & { view: { turns: { seq: number; driver: string }[] } };
    const [turn] = spend.turns;
    if (turn?.kind !== 'model') throw new Error('one Geno turn');
    const total = { input: 3200, cacheRead: 6000, cacheWrite: 6000, output: calls[0]!.usage.output + calls[1]!.usage.output };
    expect(turn.breakdown.total.usage).toEqual(total);
    for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) {
      expect(PARTS.reduce((s, p) => s + turn.breakdown.parts[p].usage[bucket], 0)).toBe(total[bucket]);
    }
    // The file read in this turn sits in the uncached tail of the second request.
    expect(turn.breakdown.parts.files.usage.input).toBeGreaterThan(2000);
    expect(spend.view.turns[0]!.driver).toMatch(/^[A-Z].* (is|are) \d+% of the cost$/);

    const text = await runCli(['usage', '--session', id], env);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(spend.view.turns[0]!.driver);
    expect(text.stdout).toMatch(/Files read this turn\s+\S+\s+\d+%\s+฿/);

    expect((await runCli(['usage'], env)).code).toBe(2);
  });
});
