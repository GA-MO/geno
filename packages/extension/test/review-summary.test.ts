import { describe, expect, it } from 'vitest';
import type { HunkStatus } from '@g-code/core';
import type { Action, Turn } from '../src/chat/messages.js';
import { emptyTranscript, reduce } from '../src/chat/transcript.js';
import { changesLine, turnChangesOf } from '../src/review/summary.js';

const turnOf = (actions: readonly Action[]): Turn =>
  [{ type: 'turn-start', id: 't1', at: 1000, prompt: 'p' } as Action, ...actions].reduce(reduce, emptyTranscript('m')).turns[0]!;

const edit = (id: string, path: string, statuses: readonly HunkStatus[]): Action[] => [
  { type: 'tool', id, at: 2000, name: 'edit', target: path, toolKind: 'edit', status: 'completed' },
  {
    type: 'diff',
    toolId: id,
    at: 2100,
    diff: { path, change: `change-${id}`, hunks: statuses.map((status, i) => ({ id: `change-${id}:${i}`, line: i + 1, removed: ['old'], added: ['new', 'new2'], status })) },
  },
];

describe('the changes a turn made, as auto review sums them', () => {
  it('counts each file once with its lines, and names the checkpoint by the turn first change', () => {
    const turn = turnOf([...edit('e1', 'a.ts', ['pending']), ...edit('e2', 'b.ts', ['pending', 'pending']), ...edit('e3', 'a.ts', ['pending'])]);
    const changes = turnChangesOf(turn)!;
    expect(changes).toEqual({
      files: [
        { path: 'a.ts', added: 4, removed: 2 },
        { path: 'b.ts', added: 4, removed: 2 },
      ],
      checkpoint: { before: 'change-e1' },
      undone: false,
    });
    expect(changesLine(changes)).toBe('2 files changed');
  });

  it('is undone only once every hunk is, and absent for a turn that edited nothing', () => {
    expect(turnChangesOf(turnOf([...edit('e1', 'a.ts', ['undone', 'pending'])]))?.undone).toBe(false);
    expect(turnChangesOf(turnOf([...edit('e1', 'a.ts', ['undone', 'undone'])]))?.undone).toBe(true);
    expect(changesLine(turnChangesOf(turnOf(edit('e1', 'a.ts', ['pending'])))!)).toBe('1 file changed');
    expect(turnChangesOf(turnOf([{ type: 'text', text: 'Nothing to change.' }]))).toBeUndefined();
  });
});
