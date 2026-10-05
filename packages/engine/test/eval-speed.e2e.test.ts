import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { asSessionId, ZERO_USAGE } from '@g-code/core';
import type { TaskResult } from '../src/eval-run.js';
import { sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, toolCall } from './fake-transport.js';
import { rgCommand, runCli } from './helpers.js';

const usage = { input: 2000, cacheRead: 0, cacheWrite: 0 };

describe('gcode eval speed --from', () => {
  it('splits a finished run into per-turn parts and writes them beside its results', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-speed-')));
    const workspace = path.join(root, 'ws');
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'a.ts'), 'export const a = 1;\n');
    const env = {
      GCODE_HOME: path.join(root, 'home'),
      GCODE_PROVIDER: 'modelstudio',
      DASHSCOPE_API_KEY: 'sk-test',
      DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
      GCODE_RG: rgCommand(),
    };
    const transport = fakeTransport([toolCall('Looking.', [{ id: 'tu_1', name: 'glob', input: { pattern: '*.ts' } }], usage), answer('One file.', usage)]);
    const asked = await runCli(['ask', '--workspace', workspace, 'Which files?'], env, { fetch: transport.fetch });
    expect(asked.code).toBe(0);
    const id = /^session: (\S+)$/m.exec(asked.stdout)![1]!;

    const runDir = path.join(root, 'run');
    await mkdir(runDir);
    const result: TaskResult = {
      runId: 'r',
      agent: 'gcode',
      model: 'qwen3.8-flash',
      taskId: 'which-files',
      outcome: 'pass',
      pass: true,
      wallMs: 60_000,
      agentMs: 60_000,
      verifyTail: '',
      stop: 'end_turn',
      turns: 2,
      usage: ZERO_USAGE,
      costUsd: 0,
      reportedCostUsd: null,
      denials: 0,
      finalMessage: 'One file.',
      transcript: sessionFile(openStore(env), asSessionId(id)),
    };
    await writeFile(path.join(runDir, 'results.jsonl'), `${JSON.stringify(result)}\n`);

    const speed = await runCli(['eval', 'speed', '--from', path.join(runDir, 'results.jsonl')], env);
    expect(speed.code).toBe(0);
    const lines = speed.stdout.split('\n');
    expect(lines).toContain('speed: 1 tasks, 2 turns, passed 1/1 (100.0%)');
    for (const part of ['first token', 'thinking', 'decode', 'model', 'tools', 'overhead', 'outside turns', 'agent time']) {
      expect(lines.some((line) => line.startsWith(`${part} `))).toBe(true);
    }
    expect(speed.stdout).toMatch(/model \+ tools explain \d+\.\d% of agent time/);

    const written = JSON.parse(await readFile(path.join(runDir, 'speed.json'), 'utf8'));
    expect(written.tasks[0].turns.map((t: { tools: { name: string }[] }) => t.tools.map((u) => u.name))).toEqual([['glob'], []]);
    expect(written.report).toMatchObject({ tasks: 1, passed: 1, turns: 2, agentMs: 60_000 });
  });
});
