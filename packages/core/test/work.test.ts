import { describe, expect, it } from 'vitest';
import { childEndOf, childEndWords, childReport, LIST_AGENTS_TOOL_DEFINITION, taskRefOf, TASK_STOP_TOOL_DEFINITION, workListText, type WorkRow } from '../src/index.js';

const NOW = Date.parse('2026-10-08T12:00:00.000Z');
const CHILD = '0b6c1f9e-2d3a-4c5b-8e7f-1a2b3c4d5e6f';

describe('task_stop ids', () => {
  it('reads a command, a wake and a subagent session id, and nothing else', () => {
    expect(taskRefOf('bg-3')).toEqual({ kind: 'job', id: 'bg-3' });
    expect(taskRefOf('wake-12')).toEqual({ kind: 'wake', id: 'wake-12' });
    expect(taskRefOf(CHILD)).toEqual({ kind: 'child', id: CHILD });
    for (const raw of ['bg-0', 'wake-', '../etc/passwd', 'explore', `${CHILD}/x`]) expect(taskRefOf(raw), raw).toBeUndefined();
  });
});

describe('a subagent stopped with task_stop', () => {
  it('ends cancelled, and its report says the model stopped it, not the user', () => {
    const end = childEndOf('end_turn', 'model', undefined);
    expect(end).toEqual({ kind: 'cancelled', by: 'model' });
    expect(childEndOf('end_turn', 'user', undefined)).toEqual({ kind: 'cancelled' });
    expect(childEndOf('end_turn', undefined, undefined)).toEqual({ kind: 'done' });
    expect(childEndWords(end)).toBe('was stopped with task_stop');
    const text = childReport('explore', CHILD as never, end, 'alpha is in a.ts so far.', { turns: 1, costUsd: 0.001, durationMs: 2000 });
    expect(text.split('\n')[0]).toMatch(/ status="cancelled" partial="true" /);
    expect(text).toContain('The subagent was stopped with task_stop before it finished, so this is what it had.');
  });
});

describe('list_agents', () => {
  const rows: WorkRow[] = [
    { kind: 'child', id: CHILD, role: 'explore', status: { kind: 'running' }, model: 'qwen3.8-flash', turns: 2, costUsd: 0.0012, startedAt: NOW - 40_000 },
    { kind: 'child', id: 'c2', role: 'review', status: { kind: 'interrupted' }, model: 'qwen3.8-plus', turns: 5, costUsd: null, startedAt: NOW - 3 * 3600_000 },
    { kind: 'job', id: 'bg-1', command: 'npm run dev', state: { status: 'running' }, startedAt: NOW - 125_000, outputFile: '/s/bg-1.log' },
    { kind: 'job', id: 'bg-2', command: 'pnpm test', state: { status: 'exited', exitCode: 1, signal: null }, startedAt: NOW - 60_000, outputFile: '/s/bg-2.log' },
    { kind: 'job', id: 'bg-3', command: 'sleep 30', state: { status: 'stopped', by: 'model' }, startedAt: NOW - 30_000, outputFile: '/s/bg-3.log' },
    { kind: 'schedule', id: 'wake-2', dueAt: NOW + 300_000, reason: 'check CI', startedAt: NOW - 5_000 },
    { kind: 'monitor', id: 'wake-3', job: 'bg-1', pattern: 'ready', startedAt: NOW - 10_000 },
  ];

  it('gives each row its id, kind, status, and the model, spend and age where it has them, newest first', () => {
    const lines = workListText(rows, NOW).split('\n');
    expect(lines[0]).toBe("This session's subagents and background work, newest first:");
    expect(lines.slice(1, -1)).toEqual([
      '- wake-2: wake-up, pending, due in 5m: check CI',
      '- wake-3: monitor on bg-1 for /ready/, running, started 10s ago',
      '- bg-3: background command `sleep 30`, cancelled, started 30s ago. Output: /s/bg-3.log',
      `- ${CHILD}: explore subagent, running. qwen3.8-flash, 2 turns, $0.0012, started 40s ago`,
      '- bg-2: background command `pnpm test`, failed (exit code 1), started 1m ago. Output: /s/bg-2.log',
      '- bg-1: background command `npm run dev`, running, started 2m ago. Output: /s/bg-1.log',
      '- c2: review subagent, interrupted. qwen3.8-plus, 5 turns, cost unknown, started 3h ago',
    ]);
    expect(lines.at(-1)).toBe('Stop a running or pending one with task_stop and its id.');
  });

  it('says so when there is nothing, with no stop line', () => {
    expect(workListText([], NOW)).toBe('This session has no subagents and no background commands, monitors, wake-ups or PR watches.');
    const done = workListText([{ kind: 'child', id: 'c', role: 'explore', status: { kind: 'done' }, model: 'm', turns: 1, costUsd: 0, startedAt: NOW - 1000 }], NOW);
    expect(done).not.toContain('task_stop');
  });

  it('are deferred tools with fixed schemas', () => {
    expect(TASK_STOP_TOOL_DEFINITION.input_schema).toEqual({ type: 'object', properties: { id: expect.any(Object) }, required: ['id'], additionalProperties: false });
    expect(LIST_AGENTS_TOOL_DEFINITION.input_schema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });
});
