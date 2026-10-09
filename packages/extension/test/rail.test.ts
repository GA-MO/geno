import { describe, expect, it } from 'vitest';
import { formatDuration } from '../src/chat/format.js';
import type { Action, FileDiff, Transcript } from '../src/chat/messages.js';
import { headerOf, missingReply, nodeOf, railOf } from '../src/chat/rail.js';
import { emptyTranscript, reduce } from '../src/chat/transcript.js';

const run = (actions: readonly Action[], start: Transcript = emptyTranscript('qwen3.8-flash')): Transcript => actions.reduce(reduce, start);
const turnOf = (actions: readonly Action[]) => run([{ type: 'turn-start', id: 't1', at: 1000, prompt: 'p' }, ...actions]).turns[0]!;

const diff = (file: string): FileDiff => ({ path: file, change: `c-${file}`, hunks: [{ id: `${file}:0`, line: 1, removed: ['a'], added: ['b'], status: 'pending' }] });
const tool = (id: string, name: string, target: string, status: 'running' | 'completed' | 'failed' = 'completed'): Action => ({
  type: 'tool',
  id,
  at: 2000,
  name,
  target,
  toolKind: name === 'read' ? 'read' : name === 'edit' ? 'edit' : 'search',
  status,
});

describe('the rail a turn draws', () => {
  it('folds runs of reads and of edits into one step each, keeps other calls apart, and ends at one changes card', () => {
    const turn = turnOf([
      { type: 'text', text: 'Looking.' },
      tool('g', 'grep', 'greeting'),
      tool('g2', 'grep', 'double'),
      tool('r1', 'read', 'a.ts'),
      tool('r2', 'read', 'b.ts'),
      tool('e1', 'edit', 'a.ts'),
      { type: 'diff', toolId: 'e1', at: 2100, diff: diff('a.ts') },
      tool('e2', 'edit', 'b.ts'),
      { type: 'diff', toolId: 'e2', at: 2200, diff: diff('b.ts') },
      tool('r3', 'read', 'c.ts'),
      { type: 'text', text: 'Done.' },
      { type: 'turn-end', at: 9400, status: 'done', usage: undefined },
    ]);
    const rail = railOf(turn);
    expect(rail.map((s) => (s.kind === 'calls' ? `${s.name}:${s.tools.map((t) => t.id).join(',')}` : s.kind))).toEqual([
      'text',
      'grep:g',
      'grep:g2',
      'read:r1,r2',
      'edit:e1,e2',
      'read:r3',
      'text',
      'changes',
    ]);
    const changes = rail.at(-1)!;
    expect(changes.kind === 'changes' && changes.edits.map((e) => e.diff.path)).toEqual(['a.ts', 'b.ts']);
    expect(new Set(rail.map((s) => s.key)).size).toBe(rail.length);
    expect(headerOf(turn, formatDuration)).toBe('worked for 8.4s');
  });

  it('thinks only while the running turn waits on the model, and waits on the user while a permission is open', () => {
    expect(railOf(turnOf([])).map((s) => s.kind)).toEqual(['thinking']);
    expect(railOf(turnOf([{ type: 'text', text: 'Hi' }])).map((s) => s.kind)).toEqual(['text']);
    const running = turnOf([tool('r1', 'read', 'a.ts', 'running')]);
    expect(railOf(running).map((s) => s.kind)).toEqual(['calls']);
    expect(nodeOf(railOf(running)[0]!)).toBe('live');
    expect(railOf(turnOf([tool('r1', 'read', 'a.ts')])).map((s) => s.kind)).toEqual(['calls', 'thinking']);

    const asking = turnOf([{ type: 'permission', id: 'p1', command: 'rm -rf build', reason: 'rm', options: [] }]);
    expect(railOf(asking).map((s) => s.kind)).toEqual(['permission']);
    expect(nodeOf(railOf(asking)[0]!)).toBe('wait');
    expect(headerOf(asking, formatDuration)).toBe('waiting for you');

    const retrying = turnOf([{ type: 'notice', text: 'Retrying in 1s' }]);
    expect(railOf(retrying).map((s) => s.kind)).toEqual(['notice']);
    const stopped = run([{ type: 'turn-end', at: 4000, status: 'stopped', usage: undefined }], run([{ type: 'turn-start', id: 't1', at: 1000, prompt: 'p' }])).turns[0]!;
    expect(railOf(stopped)).toEqual([]);
    expect(headerOf(stopped, formatDuration)).toBe('stopped after 3.0s');
  });

  it('marks a step failed when any of its calls failed', () => {
    const rail = railOf(turnOf([tool('r1', 'read', 'a.ts'), tool('r2', 'read', 'gone.ts', 'failed'), { type: 'text', text: 'x' }]));
    expect(nodeOf(rail[0]!)).toBe('failed');
  });
});

describe('a turn with no reply', () => {
  const end = (status: 'done' | 'stopped' | 'failed' = 'done'): Action => ({ type: 'turn-end', at: 9000, status, usage: undefined });
  const denied: Action = { type: 'tool', id: 'b', at: 2000, name: 'bash', target: 'rm -rf build', toolKind: 'execute', status: 'denied', denial: { by: 'you', reason: 'It did not run.' } };

  it.each<[string, Action[], string]>([
    ['ends on a step with no text after it', [{ type: 'text', text: 'Reading first.' }, tool('r', 'read', 'a.ts'), end()], 'Its last reply had no text.'],
    ['ends on blank text', [tool('r', 'read', 'a.ts'), { type: 'text', text: '\n\n' }, end()], 'Its last reply had no text.'],
    ['was stopped', [tool('r', 'read', 'a.ts'), end('stopped')], 'You stopped it before it answered.'],
    ['reached its limit', [tool('r', 'read', 'a.ts'), { type: 'error', message: 'stopped after 6 model calls (--max-turns 6)', error: 'max-turns' }, end('failed')], 'It reached its limit before it answered.'],
    ['ends on a denied call', [denied, end()], 'It stopped at the call that was denied.'],
  ])('says why when it %s', (_case, actions, reason) => {
    expect(missingReply(turnOf(actions))).toBe(reason);
  });

  it.each<[string, Action[]]>([
    ['answered after its last step', [tool('r', 'read', 'a.ts'), { type: 'text', text: 'Done.' }, end()]],
    ['still runs', [tool('r', 'read', 'a.ts')]],
    ['failed with an error that says why', [{ type: 'error', message: 'The model call failed: 401' }, end('failed')]],
  ])('says nothing when it %s', (_case, actions) => {
    expect(missingReply(turnOf(actions))).toBeUndefined();
  });
});
