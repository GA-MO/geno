import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SEEDS } from '@g-code/core';
import type { Io } from '../src/command.js';
import { evalArenaCommand, type ArenaTaskResult } from '../src/eval-arena.js';
import { openStore, taskDir } from '../src/store.js';
import { answer, sseBody, toolCall, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand } from './helpers.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const read = (id: string) => ({ id, name: 'read', input: { path: 'a.ts' } });
const edit = (id: string, to: string) => ({ id, name: 'edit', input: { path: 'a.ts', old_str: 'two', new_str: to } });

/** A writes what the hidden check wants, B something the project check accepts but the hidden one does not, C breaks the project check. */
const SCRIPTS: Readonly<Record<'A' | 'B' | 'C' | 'review', readonly Reply[]>> = {
  A: [toolCall('Reading.', [read('a0')], usage), toolCall('Editing.', [edit('a1', 'TWO')], usage), answer('A done.', usage)],
  B: [toolCall('Reading.', [read('b0')], usage), toolCall('Editing.', [edit('b1', 'Two')], usage), answer('B done.', usage)],
  C: [toolCall('Reading.', [read('c0')], usage), toolCall('Editing.', [edit('c1', 'BAD')], usage), answer('C done.', usage)],
  review: [answer('```json\n{"ranking": [{"lane": "B", "reason": "Reads better."}, {"lane": "A", "reason": "Shouts."}], "summary": "B."}\n```', usage)],
};

const fakeModel: typeof globalThis.fetch = async (_input, init) => {
  const parsed = JSON.parse(String(init?.body)) as { messages: { role: string; content: unknown }[] };
  const first = JSON.stringify(parsed.messages[0]?.content);
  const script = first.includes('lanes each tried the task') ? 'review' : first.includes(SEEDS.minimal.text) ? 'B' : first.includes(SEEDS.idiomatic.text) ? 'C' : 'A';
  const reply = SCRIPTS[script][parsed.messages.filter((m) => m.role === 'assistant').length]!;
  return new Response(sseBody(reply), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

describe('gcode eval arena', () => {
  it('runs best-of-3 in lanes of a clone, verifies every lane with the hidden check, and scores pass@1, pass@3 and the review pick', async () => {
    const repo = makeRepo('src', [{ message: 'start', files: { 'a.ts': 'one\ntwo\nthree\n' } }]);
    const baseCommit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
    const env = { GCODE_HOME: home, HOME: home, GCODE_PROVIDER: 'modelstudio', DASHSCOPE_API_KEY: 'sk-fake', DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic', GCODE_RG: rgCommand(), PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
    const store = openStore(env);
    await mkdir(taskDir(store, 'loud-two'), { recursive: true });
    await writeFile(path.join(store.tasksDir, 'loud-two.json'), JSON.stringify({ id: 'loud-two', repo, baseCommit, prompt: 'Make line two loud', setup: 'true', verify: 'grep -qx TWO a.ts' }));
    const out: string[] = [];
    const io: Io = { env, cwd: home, out: (line) => out.push(line), err: (line) => out.push(`! ${line}`), write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch: fakeModel };

    const code = await evalArenaCommand(['--task', 'loud-two', '--check', '! grep -q BAD a.ts', '--runs-dir', path.join(home, 'runs'), '--max-cost', '0.5'], { io, store });
    expect(code).toBe(0);
    const file = out.find((line) => line.startsWith('results: '))!.slice('results: '.length);
    const [result] = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as ArenaTaskResult);
    expect(result!.lanes.map((l) => [l.letter, l.check, l.rank, l.verified])).toEqual([
      ['A', 'passed', 2, true],
      ['B', 'passed', 1, false],
      ['C', 'failed', null, false],
    ]);
    expect(result).toMatchObject({ status: 'ranked', pass1: 1 / 3, passN: true, picked: false });
    expect(result!.costUsd).toBeGreaterThan(0);
    expect(out).toContain('| loud-two | A As asked: passed #2, pass; B Minimal change: passed #1, fail; C Idiomatic refactor: failed, fail | 0.33 | yes | no | ' + `$${result!.costUsd.toFixed(4)} |`);
    expect(out.find((line) => line.startsWith('limiter: '))).toMatch(/^limiter: 4 slots, \d+ calls, peak [1-4] at once/);
    // The source repository is untouched: the lanes live in a clone.
    expect(readFileSync(path.join(repo, 'a.ts'), 'utf8')).toBe('one\ntwo\nthree\n');
  });
});
