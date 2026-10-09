import { describe, expect, it } from 'vitest';
import { titleOf } from '../src/session-replay.js';

const use = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id: 'tu', name, input, caller: { type: 'direct' as const } });

describe('a replayed call', () => {
  it.each([
    [use('skill', { name: 'poteto-mode' }), 'skill poteto-mode'],
    [use('tool_search', { select: ['web_fetch', 'monitor'] }), 'tool_search web_fetch monitor'],
    [use('tool_search', { query: 'pdf tools' }), 'tool_search "pdf tools"'],
    [use('task_stop', { id: 'bg-1' }), 'task_stop bg-1'],
    [use('web_fetch', { url: 'https://docs.stripe.com/api', question: 'What is a charge?' }), 'web_fetch https://docs.stripe.com/api'],
    [use('agent', { agent: 'explore', task: 'Find the callers of getUser.\nList each file.' }), 'agent explore: Find the callers of getUser.'],
    [use('monitor', { background_job_id: 'bg-1', pattern: 'ready' }), 'monitor bg-1 for /ready/'],
    [use('remember', { text: 'Use pnpm.', scope: 'project' }), 'remember project'],
    [use('grep', { pattern: 'x', path: '' }), 'grep {"pattern":"x","path":""}'],
  ])('is titled with its target, as the live call is: %#', (call, title) => {
    expect(titleOf(call)).toBe(title);
  });
});
