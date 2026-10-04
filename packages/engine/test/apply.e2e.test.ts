import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { baseOf, EDIT_FORMAT_SPECS, EDIT_SYSTEM_PROMPT } from '@g-code/core';
import { applyEditToFile } from '../src/apply.js';
import { answer, fakeTransport, toolCall } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { runCli } from './helpers.js';

async function minedHome() {
  const repo = makeRepo('editable', [
    { message: 'Add the greeting module', files: { 'greet.ts': 'export const hi = "hello";\n' } },
    { message: 'Make the greeting louder', files: { 'greet.ts': 'export const hi = "HELLO";\n' } },
  ]);
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const env = {
    GCODE_HOME: home,
    GCODE_PROVIDER: 'modelstudio',
    DASHSCOPE_API_KEY: 'sk-test',
    DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
  };
  const mined = await runCli(['eval', 'mine', '--repo', repo], env);
  if (!/^  kept /m.test(mined.stdout)) throw new Error(`nothing mined:\n${mined.stdout}`);
  return { home, env };
}

const usage = { input: 900, cacheRead: 0, cacheWrite: 0 };
const edit = (id: string, oldStr: string) => ({
  id,
  name: 'edit',
  input: { path: 'greet.ts', old_str: oldStr, new_str: 'hi = "HELLO"' },
});

describe('a model-backed applier', () => {
  it('sends a zero-match error back to the model, applies its retry, and records one retry', async () => {
    const { home, env } = await minedHome();
    const transport = fakeTransport([
      toolCall('Editing.', [edit('tu_1', 'hi = "helo"')], usage),
      toolCall('Fixing the match.', [edit('tu_2', 'hi = "hello"')], usage),
      answer('Made the greeting uppercase.', usage),
    ]);
    const out = path.join(home, 'run.jsonl');

    const result = await runCli(['eval', 'apply', '--applier', 'str_replace', '--max-cost', '0.01', '--out', out], env, {
      fetch: transport.fetch,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('first-try failures: zero-matches=1');
    expect(result.stdout).toContain('final failures: none');

    expect(transport.requests[0]!.body.tools).toEqual([EDIT_FORMAT_SPECS.str_replace.tool]);
    expect(transport.requests[0]!.body.system[0].text).toBe(EDIT_SYSTEM_PROMPT);
    const retry = transport.requests[1]!.body.messages.at(-1);
    expect(retry.content).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        tool_use_id: 'tu_1',
        is_error: true,
        content: expect.stringContaining('old_str does not appear in greet.ts'),
      }),
    ]);

    const [line, ...rest] = (await readFile(out, 'utf8')).trim().split('\n');
    expect(rest).toEqual([]);
    const record = JSON.parse(line!);
    expect(record).toMatchObject({
      applier: 'str_replace',
      outcome: { kind: 'applied', after: 'export const hi = "HELLO";\n' },
      exactMatch: true,
      attempt: { model: 'qwen3.8-flash', firstTry: 'zero-matches', retries: 1, calls: 3 },
    });
    expect(record.attempt.changes.map((c: { result: { kind: string } }) => c.result.kind)).toEqual(['failed', 'applied']);
    expect(record.attempt.costUsd).toBeGreaterThan(0);
  });

  it('gives up after two retries with the last failure as the reason', async () => {
    const { env } = await minedHome();
    const transport = fakeTransport([1, 2, 3].map((n) => toolCall('Editing.', [edit(`tu_${n}`, 'nope')], usage)));
    const result = await runCli(['eval', 'apply', '--applier', 'str_replace', '--max-cost', '0.01'], env, { fetch: transport.fetch });
    expect(transport.requests).toHaveLength(3);
    expect(result.stdout).toContain('final failures: zero-matches=1');
    expect(result.stdout).toMatch(/failed zero-matches first-try=zero-matches retries=2/);
  });

  it('refuses a model with no price, since the budget could not be enforced', async () => {
    const { env } = await minedHome();
    const result = await runCli(['eval', 'apply', '--applier', 'whole_file', '--model', 'mystery-1'], env);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no price for mystery-1');
  });
});

describe('gcode eval apply --resume', () => {
  it('runs only the triples the results file lacks and summarizes the whole file', async () => {
    const repo = makeRepo('resumable', [
      { message: 'Add the greeting', files: { 'greet.ts': 'export const hi = "hello";\n' } },
      { message: 'Shout the greeting', files: { 'greet.ts': 'export const hi = "HELLO";\n' } },
      { message: 'Add a farewell', files: { 'greet.ts': 'export const hi = "HELLO";\nexport const bye = "bye";\n' } },
    ]);
    const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
    const env = { GCODE_HOME: home, GCODE_PROVIDER: 'modelstudio', DASHSCOPE_API_KEY: 'sk-test', DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic' };
    await runCli(['eval', 'mine', '--repo', repo], env);
    const write = () => [
      toolCall('Writing.', [{ id: 'tu_1', name: 'write_file', input: { path: 'greet.ts', content: 'x\n' } }], usage),
      answer('Done.', usage),
    ];
    const out = path.join(home, 'run.jsonl');

    const first = fakeTransport(write());
    await runCli(['eval', 'apply', '--applier', 'whole_file', '--limit', '1', '--out', out], env, { fetch: first.fetch });
    const second = fakeTransport(write());
    const resumed = await runCli(['eval', 'apply', '--applier', 'whole_file', '--resume', out], env, { fetch: second.fetch });

    expect(second.requests).toHaveLength(2);
    expect(resumed.stdout).toMatch(/^\[2\/2\] /m);
    expect(resumed.stdout).not.toMatch(/^\[1\/2\] /m);
    expect(resumed.stdout).toMatch(/^all +2 /m);
    const records = (await readFile(out, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(new Set(records.map((r) => r.runId)).size).toBe(1);
    expect(new Set(records.map((r) => r.tripleId)).size).toBe(2);
  });

  it('refuses to resume a run of another applier', async () => {
    const { home, env } = await minedHome();
    const out = path.join(home, 'noop.jsonl');
    await runCli(['eval', 'apply', '--out', out], env);
    const result = await runCli(['eval', 'apply', '--applier', 'oracle', '--resume', out], env);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('holds a noop run');
  });
});

describe('applyEditToFile', () => {
  it('writes nothing when the file changed since the model read it', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'gcode-edit-')), 'a.ts');
    await writeFile(file, 'const a = 1;\n');
    const base = baseOf('const a = 0;\n', null);
    const change = await applyEditToFile(
      file,
      { path: 'a.ts', format: 'str_replace', raw: { path: 'a.ts', old_str: 'a = 1', new_str: 'a = 2' }, base },
      null,
    );
    expect(change.result).toMatchObject({ kind: 'failed', reason: 'stale-base' });
    expect(await readFile(file, 'utf8')).toBe('const a = 1;\n');
  });

  it('writes the edited text when the base still matches', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'gcode-edit-')), 'a.ts');
    await writeFile(file, 'const a = 1;\n');
    const change = await applyEditToFile(
      file,
      { path: 'a.ts', format: 'str_replace', raw: { path: 'a.ts', old_str: 'a = 1', new_str: 'a = 2' }, base: baseOf('const a = 1;\n', null) },
      null,
    );
    expect(change.result).toEqual({ kind: 'applied' });
    expect(await readFile(file, 'utf8')).toBe('const a = 2;\n');
  });
});
