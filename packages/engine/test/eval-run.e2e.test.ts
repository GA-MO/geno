import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { asTaskId, type EvalTask } from '@g-code/core';
import type { Io } from '../src/command.js';
import { runEval, type AgentAdapter, type TaskResult } from '../src/eval-run.js';
import { applyPatch } from '../src/git.js';
import { openStore, taskDir } from '../src/store.js';
import { makeRepo } from './git-fixture.js';

const PATCH = `diff --git a/greet.txt b/greet.txt
--- a/greet.txt
+++ b/greet.txt
@@ -1 +1 @@
-hello
+goodbye
`;
const CHECK = 'test "$(cat greet.txt)" = goodbye\n';

async function setUp() {
  const repo = makeRepo('greeter', [{ message: 'Add the greeting file', files: { 'greet.txt': 'hello\n' } }]);
  const baseCommit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const env = { GCODE_HOME: home, PATH: process.env['PATH'] ?? '/usr/bin:/bin', DASHSCOPE_API_KEY: 'sk-must-not-reach-setup' };
  const store = openStore(env);
  const tasks: EvalTask[] = ['greet-goodbye', 'greet-untouched'].map((id) => ({
    id: asTaskId(id),
    repo,
    baseCommit,
    prompt: 'Say goodbye instead',
    setup: 'test -d "$GCODE_TASK_DIR" && env > setup-env.txt',
    verify: 'sh "$GCODE_TASK_DIR/check.sh"',
  }));
  for (const task of tasks) {
    await mkdir(taskDir(store, task.id), { recursive: true });
    await writeFile(path.join(taskDir(store, task.id), 'check.sh'), CHECK);
    await writeFile(path.join(taskDir(store, task.id), 'reference.patch'), PATCH);
  }
  const out: string[] = [];
  const io: Io = {
    env,
    cwd: home,
    out: (line) => out.push(line),
    err: (line) => out.push(`! ${line}`),
    write: () => {},
    interrupts: () => new AbortController().signal,
    confirm: async () => false,
  };
  return { tasks, store, io, out, home };
}

/** Applies the task's reference patch, but only to the first task, so the run has one pass and one fail. */
function stubAdapter(seenEnv: string[]): AgentAdapter {
  return {
    async run(input, { store }) {
      seenEnv.push(readFileSync(path.join(input.workspace, 'setup-env.txt'), 'utf8'));
      if (input.task.id === 'greet-goodbye') await applyPatch(input.workspace, path.join(taskDir(store, input.task.id), 'reference.patch'));
      return {
        stop: 'end_turn',
        turns: 2,
        usage: { input: 100, cacheRead: 50, cacheWrite: 0, output: 10 },
        costUsd: 0.01,
        reportedCostUsd: null,
        denials: 1,
        finalMessage: 'Done.',
        transcript: 'stub',
      };
    },
  };
}

describe('gcode eval run', () => {
  it('runs each task in a fresh clone, verifies it, records results.jsonl, and prints the summary', async () => {
    const { tasks, store, io, out, home } = await setUp();
    const seenEnv: string[] = [];
    const run = await runEval(
      { io, store },
      {
        tasks,
        agent: 'gcode',
        adapter: stubAdapter(seenEnv),
        model: 'qwen3.8-flash',
        maxCostPerTaskUsd: 0.4,
        maxCostUsd: 3,
        runsDir: path.join(home, 'runs'),
        check: undefined,
        checkAfterEdit: true,
      },
    );
    expect(run.stopped).toBe(false);
    expect(run.file.startsWith(path.join(home, 'runs'))).toBe(true);
    const lines = readFileSync(run.file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as TaskResult);
    expect(lines.map((r) => [r.taskId, r.outcome, r.pass, r.turns, r.denials, r.costUsd])).toEqual([
      ['greet-goodbye', 'pass', true, 2, 1, 0.01],
      ['greet-untouched', 'fail', false, 2, 1, 0.01],
    ]);
    expect(lines[0]).toMatchObject({ agent: 'gcode', model: 'qwen3.8-flash', stop: 'end_turn', finalMessage: 'Done.' });
    expect(seenEnv[0]).not.toContain('sk-must-not-reach-setup');
    expect(seenEnv[0]).toContain('PATH=');

    const summary = out.join('\n');
    console.log(summary);
    expect(summary).toMatch(/^greet-goodbye +pass +end_turn +2 +100\/50\/0\/10 +\$0\.010000 +\d+\.\ds +1$/m);
    expect(summary).toMatch(/^greet-untouched +fail /m);
    expect(summary).toContain('passed 1/2 (50.0%)');
    expect(summary).toContain('cost=$0.0200');
  });

  it('stops before a task once the run has spent --max-cost, and gives the last task only what is left', async () => {
    const { tasks, store, io, out, home } = await setUp();
    const budgets: number[] = [];
    const adapter: AgentAdapter = {
      async run(input) {
        budgets.push(input.maxCostUsd);
        return { ...(await stubAdapter([]).run(input, { io, store })), costUsd: 0.3 };
      },
    };
    const run = await runEval(
      { io, store },
      {
        tasks: [...tasks, ...tasks],
        agent: 'claude-code',
        adapter,
        model: 'qwen3.8-flash',
        maxCostPerTaskUsd: 0.4,
        maxCostUsd: 0.5,
        runsDir: path.join(home, 'runs'),
        check: undefined,
        checkAfterEdit: true,
      },
    );
    expect(run.stopped).toBe(true);
    expect(budgets.map((b) => b.toFixed(2))).toEqual(['0.40', '0.20']);
    expect(out.join('\n')).toContain('! budget: stopped at an estimated $0.6000 before task 3 of 4, past --max-cost 0.5');
  });
});
