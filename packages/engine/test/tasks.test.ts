import { describe, expect, it } from 'vitest';
import type { TaskUpdate } from '@g-code/core';
import { Tasks } from '../src/tasks.js';

const base = { workspace: '/repo', lane: null, startedAt: 1 } as const;

describe('Tasks, the attention fields', () => {
  it('keeps the background commands a session runs across its next turn', () => {
    const tasks = new Tasks();
    tasks.start({ ...base, sessionId: 's', title: 'Chat' });
    tasks.jobs('s', [{ id: 'bg-1', command: 'pnpm dev', startedAt: 1 }]);
    tasks.end('s', 'done', undefined);
    tasks.start({ ...base, sessionId: 's', title: 'Chat' });
    expect(tasks.get('s')!.jobs).toEqual([{ id: 'bg-1', command: 'pnpm dev', startedAt: 1 }]);
  });

  it('names the card a task waits on, and stamps when it came back', () => {
    const tasks = new Tasks();
    tasks.start({ ...base, sessionId: 's', title: 'Chat' });
    expect(tasks.get('s')).toMatchObject({ status: 'running', returnedAt: null, parent: null });
    const answered = tasks.ask('s', 'question');
    const asked = tasks.get('s')!;
    expect(asked).toMatchObject({ status: 'needs-input', asking: 'question' });
    expect(asked.returnedAt).toBeTypeOf('number');
    answered();
    expect(tasks.get('s')).toMatchObject({ status: 'running', asking: undefined, returnedAt: asked.returnedAt });
    tasks.end('s', 'done', undefined);
    expect(tasks.get('s')!.returnedAt).toBeGreaterThanOrEqual(asked.returnedAt!);
  });

  it('puts a subagent’s question on the subagent’s own task, under its parent, and drops the subagent once it ends', () => {
    const tasks = new Tasks();
    const updates: TaskUpdate[] = [];
    tasks.listen((update) => updates.push(update));
    tasks.start({ ...base, sessionId: 'p', title: 'Chat' });
    tasks.start({ ...base, sessionId: 'c', title: 'explore: look', parent: 'p', kind: 'subagent' });
    const answered = tasks.ask('c', 'permission');
    expect(tasks.get('p')!.status).toBe('running');
    expect(tasks.get('c')).toMatchObject({ status: 'needs-input', asking: 'permission', parent: 'p', kind: 'subagent' });
    answered();
    tasks.end('c', 'done', undefined);
    expect(updates.at(-1)!.task).toMatchObject({ sessionId: 'c', status: 'done' });
    expect(tasks.get('c')).toBeUndefined();
    expect(tasks.list().tasks.map((t) => t.sessionId)).toEqual(['p']);
  });

  it('adopts an Arena lane before its turn starts, and ends a task once', () => {
    const tasks = new Tasks();
    tasks.start({ ...base, sessionId: 'arena-1', title: 'Best of 2: x', kind: 'arena', parent: null });
    tasks.adopt('lane-a', 'arena-1');
    tasks.start({ ...base, sessionId: 'lane-a', title: 'x' });
    expect(tasks.get('lane-a')!.parent).toBe('arena-1');
    tasks.end('arena-1', 'done', undefined);
    const ended = tasks.get('arena-1')!;
    tasks.end('arena-1', 'failed', undefined);
    expect(tasks.get('arena-1')).toBe(ended);
  });
});
