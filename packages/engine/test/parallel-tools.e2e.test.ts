import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_TOOL_DEFINITIONS, ruleAttachment, type LoadedContext, type ToolResultEvent, type TurnEvent } from '@g-code/core';
import { startSession } from '../src/chat.js';
import type { Io } from '../src/command.js';
import { drive, type Surface } from '../src/drive.js';
import { DISK_FILES, type Files } from '../src/files.js';
import { openStore } from '../src/store.js';
import { agentExecutors, NON_INTERACTIVE } from '../src/tools/agent.js';
import { ruleAttacher } from '../src/tools/rules.js';
import type { Sandbox } from '../src/sandbox.js';
import { answer, fakeTransport, toolCall, type FakeToolUse } from './fake-transport.js';
import { rgCommand } from './helpers.js';

const usage = { input: 2000, cacheRead: 0, cacheWrite: 0 };
const READ_MS = 200;

const NO_SANDBOX: Sandbox = {
  run: async () => {
    throw new Error('no command runs in this test');
  },
  spawn: async () => {
    throw new Error('no command runs in this test');
  },
  retain: () => async () => {},
  close: async () => {},
};

/** The disk, with every read taking `delay(file)` ms, as a read over ACP from the editor does. */
const slowFiles = (delay: (file: string) => number): Files => ({
  ...DISK_FILES,
  read: async (file) => {
    await new Promise((resolve) => setTimeout(resolve, delay(file)));
    return DISK_FILES.read(file);
  },
});

const ruleContext: LoadedContext = {
  instructions: [],
  rules: [{ path: '.cursor/rules/ts.mdc', trigger: { kind: 'globs', globs: ['*.ts'] }, text: 'No default exports.' }],
  skills: [],
};

async function runTurn(files: Record<string, string>, uses: readonly FakeToolUse[], delay: (file: string) => number = () => READ_MS) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-parallel-')));
  const workspace = path.join(root, 'ws');
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(workspace, name)), { recursive: true });
    await writeFile(path.join(workspace, name), text);
  }
  const env = { GCODE_HOME: path.join(root, 'home'), GCODE_PROVIDER: 'modelstudio', DASHSCOPE_API_KEY: 'sk-test', DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic', GCODE_RG: rgCommand() };
  const transport = fakeTransport([toolCall('Looking.', uses, usage), answer('Done.', usage)]);
  const io: Io = { env, cwd: workspace, out: () => {}, err: () => {}, write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch: transport.fetch };
  const store = openStore(env);
  const opened = await startSession(store, io, { workspace, provider: undefined, model: undefined, effort: undefined });
  const start = opened.log.events[0]!;
  const executors = agentExecutors({
    sandbox: NO_SANDBOX,
    env: {},
    scope: { workspace, tempDir: root, home: root },
    check: undefined,
    checkAfterEdit: false,
    approval: NON_INTERACTIVE,
    diagnostics: undefined,
    rules: ruleAttacher([{ ...start, context: ruleContext } as TurnEvent]),
    commands: async () => [],
  });
  const started: string[] = [];
  const surface: Surface = {
    files: slowFiles(delay),
    watcher: { text: () => {}, toolStart: (use) => started.push(use.id), toolEnd: () => {}, logged: () => {} },
  };
  const result = await drive(io, store, opened, 'Look around, then fix it.', { maxTurns: 5, maxCostUsd: 1 }, { tools: AGENT_TOOL_DEFINITIONS, executors }, surface);
  expect(result.reason).toBe('end_turn');
  const logged = result.events.filter((e): e is ToolResultEvent => e.kind === 'tool-result');
  const sent = (transport.requests[1]!.body.messages.at(-1)!.content as { type: string; tool_use_id?: string; content?: string }[]).filter((b) => b.type === 'tool_result');
  return { workspace, logged, sent, started };
}

const timingOf = (event: ToolResultEvent) => event.timing!;
const output = (event: ToolResultEvent) => ('output' in event ? event.output : '');

describe('read-only tools of one turn', () => {
  it('runs 4 reads at the same time, the edit after them, and logs and sends the results in the order of the calls', async () => {
    const files = { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 2;\n', 'c.ts': 'export const c = 3;\n', 'd.ts': 'export const d = 4;\n' };
    const uses: FakeToolUse[] = [
      { id: 'tu_a', name: 'read', input: { path: 'a.ts' } },
      { id: 'tu_b', name: 'read', input: { path: 'b.ts' } },
      { id: 'tu_c', name: 'read', input: { path: 'c.ts' } },
      { id: 'tu_d', name: 'read', input: { path: 'd.ts' } },
      { id: 'tu_e', name: 'edit', input: { path: 'a.ts', old_str: 'a = 1', new_str: 'a = 10' } },
    ];
    const { workspace, logged, sent, started } = await runTurn(files, uses);

    expect(logged.map((e) => e.toolUseId)).toEqual(['tu_a', 'tu_b', 'tu_c', 'tu_d', 'tu_e']);
    expect(logged.map((e) => e.seq)).toEqual(logged.map((_, i) => logged[0]!.seq + i));
    expect(logged.map((e) => e.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(sent.map((b) => b.tool_use_id)).toEqual(['tu_a', 'tu_b', 'tu_c', 'tu_d', 'tu_e']);
    expect(sent[1]!.content).toContain('export const b = 2;');
    expect(started).toEqual(['tu_a', 'tu_b', 'tu_c', 'tu_d', 'tu_e']);

    const reads = logged.slice(0, 4).map(timingOf);
    const lastStart = Math.max(...reads.map((t) => t.startAt));
    const firstEnd = Math.min(...reads.map((t) => t.endAt));
    expect(lastStart, 'every read starts before any read ends').toBeLessThan(firstEnd);
    expect(Math.max(...reads.map((t) => t.endAt)) - Math.min(...reads.map((t) => t.startAt)), 'the 4 reads take about one read').toBeLessThan(2 * READ_MS);
    const edit = timingOf(logged[4]!);
    expect(edit.startAt, 'the edit starts once every read has ended').toBeGreaterThanOrEqual(Math.max(...reads.map((t) => t.endAt)));
    expect(await readFile(path.join(workspace, 'a.ts'), 'utf8')).toBe('export const a = 10;\n');
  });

  it('keeps a read, an edit and a read of the same file in their order', async () => {
    const uses: FakeToolUse[] = [
      { id: 'tu_1', name: 'read', input: { path: 'a.ts' } },
      { id: 'tu_2', name: 'edit', input: { path: 'a.ts', old_str: 'a = 1', new_str: 'a = 10' } },
      { id: 'tu_3', name: 'read', input: { path: 'a.ts' } },
    ];
    const { logged } = await runTurn({ 'a.ts': 'export const a = 1;\n' }, uses);

    expect(logged.map((e) => [e.toolUseId, e.status])).toEqual([
      ['tu_1', 'ok'],
      ['tu_2', 'ok'],
      ['tu_3', 'ok'],
    ]);
    expect(output(logged[0]!)).toContain('export const a = 1;');
    expect(output(logged[1]!)).toBe('Edited a.ts.');
    expect(output(logged[2]!)).toContain('export const a = 10;');
    expect(timingOf(logged[1]!).startAt).toBeGreaterThanOrEqual(timingOf(logged[0]!).endAt);
    expect(timingOf(logged[2]!).startAt).toBeGreaterThanOrEqual(timingOf(logged[1]!).endAt);
  });

  it('attaches a rule to the first read in call order, even when a later read of a matching file finishes first', async () => {
    const uses: FakeToolUse[] = [
      { id: 'tu_slow', name: 'read', input: { path: 'slow.ts' } },
      { id: 'tu_fast', name: 'read', input: { path: 'fast.ts' } },
    ];
    const { logged } = await runTurn({ 'slow.ts': 'export const slow = 1;\n', 'fast.ts': 'export const fast = 2;\n' }, uses, (file) =>
      file.endsWith('slow.ts') ? 3 * READ_MS : 0,
    );

    expect(output(logged[0]!)).toBe(`1\texport const slow = 1;\n\n${ruleAttachment(ruleContext.rules[0]!, 'slow.ts')}`);
    expect(output(logged[1]!)).toBe('1\texport const fast = 2;');
    expect(timingOf(logged[1]!).startAt, 'the reads still overlap').toBeLessThan(timingOf(logged[0]!).endAt);
  });
});
