import { describe, expect, it } from 'vitest';
import { asSessionId, noticeTexts, replayMessages, renderTodoReminder, TODO_REMINDER_CALLS, todoReminder, type Session, type TodoList, type TodoStatus, type TurnEvent } from '../src/index.js';

const at = '2026-10-10T00:00:01.000Z';
const session: Session = { id: asSessionId('s1'), createdAt: at, workspace: '/ws', provider: 'modelstudio', model: 'qwen3.8-flash', effort: 'medium' };
const usage = { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 };
const list = (...statuses: TodoStatus[]): TodoList => statuses.map((status, i) => ({ id: String(i + 1), text: ['Read the code', 'Write tests', 'Run them'][i]!, status }));

/** A session written as the engine logs it, seq by seq. */
function log() {
  const events: TurnEvent[] = [{ kind: 'session-start', session }];
  let seq = 0;
  const builder = {
    events,
    prompt: (content = 'Do it.') => (events.push({ kind: 'user', seq: ++seq, at, content }), builder),
    todo: (items: TodoList) => {
      const id = `t${seq + 1}`;
      events.push({ kind: 'assistant', seq: ++seq, at, content: [{ type: 'tool_use', id, name: 'todo', input: { items }, caller: { type: 'direct' } }], stopReason: 'tool_use', usage, costUsd: 0, latencyMs: 1, model: 'm' });
      events.push({ kind: 'tool-result', seq: ++seq, at, toolUseId: id, name: 'todo', status: 'ok', output: 'Updated.', todo: items });
      return builder;
    },
    reads: (n: number) => {
      for (let i = 0; i < n; i++) {
        const id = `r${seq + 1}`;
        events.push({ kind: 'assistant', seq: ++seq, at, content: [{ type: 'tool_use', id, name: 'read', input: { path: 'a.ts' }, caller: { type: 'direct' } }], stopReason: 'tool_use', usage, costUsd: 0, latencyMs: 1, model: 'm' });
        events.push({ kind: 'tool-result', seq: ++seq, at, toolUseId: id, name: 'read', status: 'ok', output: 'x' });
      }
      return builder;
    },
    stop: () => (events.push({ kind: 'error', seq: ++seq, at, error: 'abort', message: 'interrupted by the user' }), builder),
    answer: () => (events.push({ kind: 'assistant', seq: ++seq, at, content: [{ type: 'text', text: 'Done.', citations: null }], stopReason: 'end_turn', usage, costUsd: 0, latencyMs: 1, model: 'm' }), builder),
    told: () => {
      const todo = todoReminder(events);
      if (todo !== undefined) events.push({ kind: 'notice', seq: ++seq, at, todo });
      return todo;
    },
  };
  return builder;
}

describe('the todo reminder', () => {
  it(`fires once after ${TODO_REMINDER_CALLS} model calls without a todo call, then not again for as many`, () => {
    const s = log().prompt().todo(list('done', 'in_progress', 'pending')).reads(TODO_REMINDER_CALLS - 1);
    expect(s.told()).toBeUndefined();
    s.reads(1);
    expect(s.told()).toEqual({ why: 'idle', list: list('done', 'in_progress', 'pending') });
    expect(s.told(), 'told once, not before every call').toBeUndefined();
    s.reads(TODO_REMINDER_CALLS - 1);
    expect(s.told()).toBeUndefined();
    s.reads(1);
    expect(s.told()?.why).toBe('idle');
  });

  it('restarts the count at each todo call', () => {
    const s = log().prompt().todo(list('in_progress', 'pending', 'pending')).reads(TODO_REMINDER_CALLS - 1).todo(list('done', 'in_progress', 'pending')).reads(TODO_REMINDER_CALLS - 1);
    expect(s.told()).toBeUndefined();
  });

  it('fires at the first call of a prompt that follows a stopped turn, once', () => {
    const s = log().prompt().todo(list('done', 'in_progress', 'pending')).reads(2).stop().prompt('Why does the build fail?');
    expect(s.told()).toEqual({ why: 'stopped', list: list('done', 'in_progress', 'pending') });
    expect(s.told(), 'not again before the model answers').toBeUndefined();
    s.answer().prompt('And the tests?');
    expect(s.told()?.why, 'a turn that ended on its own reminds too, in its own words').toBe('earlier');
  });

  it('fires once at each prompt that follows a turn which ended on its own with the list unfinished', () => {
    const s = log().prompt().todo(list('done', 'in_progress', 'pending')).answer().prompt('Something else.');
    expect(s.told()).toEqual({ why: 'earlier', list: list('done', 'in_progress', 'pending') });
    expect(s.told(), 'once per prompt').toBeUndefined();
    s.answer().prompt('And another thing.');
    expect(s.told()?.why, 'the next prompt, while the list is still unfinished').toBe('earlier');
    s.answer().todo([]).answer().prompt('Thanks.');
    expect(s.told(), 'not once the model cleared it').toBeUndefined();
  });

  it('fires after a turn that failed at a limit', () => {
    const s = log().prompt().todo(list('in_progress', 'pending', 'pending'));
    s.events.push({ kind: 'error', seq: 99, at, error: 'max-turns', message: 'stopped at 3 turns' });
    s.prompt('Something else.');
    expect(s.told()?.why).toBe('stopped');
  });

  it('fires after a turn its limits capped with a last report call, though that turn ended on its own', () => {
    const s = log().prompt().todo(list('in_progress', 'pending', 'pending'));
    s.events.push({ kind: 'notice', seq: 98, at, last: true });
    s.answer().prompt('Something else.');
    expect(s.told()?.why).toBe('stopped');
    const finished = log().prompt().todo(list('in_progress', 'pending', 'pending'));
    finished.events.push({ kind: 'notice', seq: 98, at, last: true });
    finished.answer().prompt('Next.').answer().prompt('And then?');
    expect(finished.told()?.why, 'the capped turn is two turns back; the last one ended on its own').toBe('earlier');
  });

  it('stays quiet with no list, a finished list, or a cleared one', () => {
    expect(log().prompt().reads(TODO_REMINDER_CALLS * 2).told()).toBeUndefined();
    expect(log().prompt().todo(list('done', 'done', 'done')).reads(TODO_REMINDER_CALLS).told()).toBeUndefined();
    expect(log().prompt().todo(list('done', 'in_progress', 'pending')).todo([]).reads(TODO_REMINDER_CALLS).told()).toBeUndefined();
    expect(log().prompt().todo(list('done', 'done', 'done')).stop().prompt('More.').told()).toBeUndefined();
    expect(log().prompt().todo(list('done', 'done', 'done')).answer().prompt('More.').told()).toBeUndefined();
    expect(log().prompt().todo(list('done', 'in_progress')).todo([]).answer().prompt('More.').told()).toBeUndefined();
  });

  it('reaches the model as a notice with the list, before the prompt it goes with', () => {
    const s = log().prompt().todo(list('done', 'in_progress', 'pending')).stop().prompt('Why does the build fail?');
    const todo = s.told()!;
    const text = renderTodoReminder(todo);
    expect(noticeTexts({ todo })).toEqual([text]);
    expect(text).toContain('[x] 1: Read the code\n[~] 2: Write tests\n[ ] 3: Run them');
    expect(text).toMatch(/clear it by calling todo with an empty list/);
    expect(text).toMatch(/Mark done every item you have already finished, even if the rest of the list still applies, and mark in_progress the one you are working on/);
    expect(renderTodoReminder({ why: 'earlier', list: list('pending') })).toMatch(/^\[Geno\] Your todo list from earlier still has unfinished items:\n\[ \] 1: Read the code\n/);
    const last = replayMessages(s.events).at(-1)!;
    const blocks = typeof last.content === 'string' ? [] : last.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
    expect(blocks.indexOf(text)).toBeGreaterThanOrEqual(0);
    expect(blocks.indexOf(text)).toBeLessThan(blocks.findIndex((b) => b.includes('Why does the build fail?')));
  });
});
