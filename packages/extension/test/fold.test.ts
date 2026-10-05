import { describe, expect, it } from 'vitest';
import { shownSteps, summaryLine, summaryOf, turnView } from '../src/chat/fold.js';
import type { Action, FileDiff, ToolKind, Turn } from '../src/chat/messages.js';
import { railOf, type Step } from '../src/chat/rail.js';
import { emptyTranscript, reduce } from '../src/chat/transcript.js';

const KINDS: Readonly<Record<string, ToolKind>> = { read: 'read', grep: 'search', glob: 'search', edit: 'edit', bash: 'execute' };

const turnOf = (actions: readonly Action[]): Turn =>
  [{ type: 'turn-start', id: 't1', at: 1000, prompt: 'p' } as Action, ...actions].reduce(reduce, emptyTranscript('m')).turns[0]!;

const call = (id: string, name: string, target: string, status: 'running' | 'completed' | 'failed' = 'completed', extra: Partial<Extract<Action, { type: 'tool' }>> = {}): Action => ({
  type: 'tool',
  id,
  at: 2000,
  name,
  target,
  toolKind: KINDS[name] ?? 'other',
  status,
  ...extra,
});

const diff = (file: string, id: string, added: number, removed: number, status: 'pending' | 'kept' = 'pending'): FileDiff => ({
  path: file,
  hunks: [{ id, line: 1, removed: Array(removed).fill('-'), added: Array(added).fill('+'), status }],
});

const said = (text: string): Action => ({ type: 'text', text });
const end = (status: 'done' | 'stopped' | 'failed' = 'done'): Action => ({ type: 'turn-end', at: 9000, status, usage: undefined });

/** A step as the tests name it: its kind, the text it shows or its fold label. */
const name = (step: Step): string =>
  step.kind === 'text' ? `text:${step.block.text}` : step.kind === 'fold' ? `fold:${step.label}` : step.kind === 'calls' ? `calls:${step.name}` : step.kind;

describe('the summary of a turn', () => {
  it('counts calls by tool kind, reads and edits as distinct files, and sets failed and denied calls apart', () => {
    const turn = turnOf([
      said('Looking.'),
      call('r1', 'read', 'a.ts'),
      call('r2', 'read', 'b.ts'),
      call('r3', 'read', 'a.ts'),
      call('g1', 'grep', 'add'),
      call('g2', 'grep', 'sum'),
      call('g3', 'glob', '*.ts'),
      call('e1', 'edit', 'a.ts'),
      { type: 'diff', toolId: 'e1', at: 2100, diff: diff('a.ts', 'h1', 1, 1) },
      call('e2', 'edit', 'b.ts'),
      { type: 'diff', toolId: 'e2', at: 2200, diff: diff('b.ts', 'h2', 2, 0) },
      call('b1', 'bash', 'ls'),
      call('b2', 'bash', 'npm test', 'failed'),
      call('b3', 'bash', 'rm -rf /', 'failed', { auto: { verdict: 'deny', reason: 'it deletes everything' } }),
      call('b4', 'bash', 'rm -rf build', 'running'),
      { type: 'permission', id: 'p1', toolId: 'b4', command: 'rm -rf build', reason: 'rm', options: [{ optionId: 'no', name: 'Deny', kind: 'reject_once' }] },
      { type: 'permission-done', id: 'p1', optionId: 'no' },
      call('b4', 'bash', 'rm -rf build', 'failed'),
      call('m1', 'mcp__docs__search', '{"q":"x"}'),
      said('Done.'),
      end(),
    ]);
    expect(summaryOf(turn)).toEqual({ kinds: { read: 2, search: 3, edit: 2, execute: 4, other: 1 }, failed: 1, denied: 2 });
    expect(summaryLine(summaryOf(turn))).toBe('Read 2 files · searched 3 times · edited 2 files · ran 4 commands · used 1 tool · 1 failed · 2 denied');
  });

  it('names only the kinds the turn used, in the singular where it did one', () => {
    const turn = turnOf([call('g1', 'grep', 'add'), call('b1', 'bash', 'ls'), said('Ok.'), end()]);
    expect(summaryLine(summaryOf(turn))).toBe('Searched once · ran 1 command');
  });

  it('denies the call the permission asked about, even when the card arrives before the call', () => {
    const turn = turnOf([
      call('g1', 'grep', 'build'),
      { type: 'permission', id: 'p1', toolId: 'b1', command: 'rm -rf build', reason: 'rm', options: [{ optionId: 'no', name: 'Deny', kind: 'reject_once' }] },
      { type: 'permission-done', id: 'p1', optionId: 'no' },
      call('b1', 'bash', 'rm -rf build', 'failed'),
      end(),
    ]);
    expect(summaryLine(summaryOf(turn))).toBe('Searched once · ran 1 command · 1 denied');
  });

  it('allows a command whose permission the user granted', () => {
    const turn = turnOf([
      call('b1', 'bash', 'rm -rf build', 'running'),
      { type: 'permission', id: 'p1', toolId: 'b1', command: 'rm -rf build', reason: 'rm', options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }] },
      { type: 'permission-done', id: 'p1', optionId: 'yes' },
      call('b1', 'bash', 'rm -rf build', 'completed'),
      end(),
    ]);
    expect(summaryOf(turn)).toMatchObject({ failed: 0, denied: 0 });
  });
});

describe('the final answer', () => {
  it('is the text after the last call; narration before it folds', () => {
    const turn = turnOf([said('Reading first.'), call('r1', 'read', 'a.ts'), said('Then searching.'), call('g1', 'grep', 'x'), said('Here is the answer.'), end()]);
    expect(turnView(turn).answer.map((s) => s.block.text)).toEqual(['Here is the answer.']);
    expect(shownSteps(turn, 'compact', false).map(name)).toEqual(['fold:Read 1 file · searched once', 'text:Here is the answer.']);
  });

  it('is empty when the turn ended on a call, which leaves the summary line and the files it changed', () => {
    const turn = turnOf([
      said('Making the edit.'),
      call('e1', 'edit', 'src/a.ts'),
      { type: 'diff', toolId: 'e1', at: 2100, diff: diff('src/a.ts', 'h1', 3, 1) },
      end('stopped'),
    ]);
    const view = turnView(turn);
    expect(view.answer).toEqual([]);
    expect(view.files).toEqual([{ path: 'src/a.ts', added: 3, removed: 1, first: 'h1', pending: ['h1'] }]);
    expect(shownSteps(turn, 'compact', false).map(name)).toEqual(['fold:Edited 1 file', 'files']);
  });

  it('keeps an error that ended the turn in view, after the answer', () => {
    const turn = turnOf([call('r1', 'read', 'a.ts'), said('Partly done.'), { type: 'error', message: 'The model refused.' }, end('failed')]);
    const shown = shownSteps(turn, 'compact', false);
    expect(shown.map(name)).toEqual(['fold:Read 1 file', 'text:Partly done.', 'error']);
    expect(turnView(turn).attention.map((s) => s.kind)).toEqual(['error']);
  });

  it('is the whole turn when the turn made no calls, so nothing folds', () => {
    const turn = turnOf([said('Just an answer.'), end()]);
    expect(shownSteps(turn, 'compact', false).map(name)).toEqual(['text:Just an answer.']);
  });
});

describe('the steps the rail shows', () => {
  const long = turnOf([
    ...Array.from({ length: 10 }, (_, i) => [said(`Step ${i}.`), call(`g${i}`, 'grep', `p${i}`)]).flat(),
    said('All done.'),
    end(),
  ]);

  it('opens a folded turn to its full trail under the fold line', () => {
    expect(railOf(long)).toHaveLength(21);
    expect(shownSteps(long, 'compact', true).map(name)).toEqual(['fold:Searched 10 times', ...railOf(long).map(name)]);
    expect(shownSteps(long, 'compact', true)[0]).toMatchObject({ kind: 'fold', open: true, turn: 't1' });
  });

  it('draws every step, with no fold line, in full detail', () => {
    expect(shownSteps(long, 'full', false)).toEqual(railOf(long));
  });

  it('shows a running turn its current step and the three before it, with only its latest narration', () => {
    const running = turnOf([...Array.from({ length: 10 }, (_, i) => [said(`Step ${i}.`), call(`g${i}`, 'grep', `p${i}`)]).flat(), call('r1', 'read', 'a.ts', 'running')]);
    expect(shownSteps(running, 'compact', false).map(name)).toEqual(['fold:+17 earlier steps', 'calls:grep', 'text:Step 9.', 'calls:grep', 'calls:read']);
    expect(shownSteps(running, 'compact', true)[0]).toMatchObject({ kind: 'fold', label: 'Hide 17 earlier steps', open: true });
  });

  it('keeps a step waiting on the user in view, whatever its place', () => {
    const asking = turnOf([
      ...Array.from({ length: 6 }, (_, i) => call(`g${i}`, 'grep', `p${i}`)),
      call('b1', 'bash', 'rm -rf build', 'running'),
      { type: 'permission', id: 'p1', command: 'rm -rf build', reason: 'rm', options: [] },
    ]);
    const shown = shownSteps(asking, 'compact', false);
    expect(shown.map(name)).toEqual(['fold:+4 earlier steps', 'calls:grep', 'calls:grep', 'calls:bash', 'permission']);
    expect(turnView(asking).attention.map((s) => s.kind)).toEqual(['permission']);
  });

  it('keeps a remember card and a question card in view while the rest folds', () => {
    const asking = (ask: Extract<Action, { type: 'permission' }>['ask']) =>
      turnOf([
        ...Array.from({ length: 6 }, (_, i) => call(`g${i}`, 'grep', `p${i}`)),
        { type: 'permission', id: 'p1', command: '', reason: '', options: [], ask },
        ...Array.from({ length: 4 }, (_, i) => call(`h${i}`, 'grep', `q${i}`)),
      ]);
    for (const ask of [{ kind: 'memory', text: 'Use pnpm', scope: 'project' }, { kind: 'question', question: 'Which file?' }] as const) {
      expect(shownSteps(asking(ask), 'compact', false).map(name)).toEqual(['fold:+6 earlier steps', 'permission', 'calls:grep', 'calls:grep', 'calls:grep', 'calls:grep']);
    }
  });

  it('gathers a turn’s edits into one chip per file, in the changes card’s place', () => {
    const turn = turnOf([
      call('e1', 'edit', 'a.ts'),
      { type: 'diff', toolId: 'e1', at: 2100, diff: diff('a.ts', 'h1', 1, 1, 'kept') },
      call('e2', 'edit', 'b.ts'),
      { type: 'diff', toolId: 'e2', at: 2200, diff: diff('b.ts', 'h2', 2, 0) },
      call('e3', 'edit', 'a.ts'),
      { type: 'diff', toolId: 'e3', at: 2300, diff: diff('a.ts', 'h3', 4, 2) },
      said('Edited both.'),
      end(),
    ]);
    const shown = shownSteps(turn, 'compact', false);
    expect(shown.map(name)).toEqual(['fold:Edited 2 files', 'text:Edited both.', 'files']);
    expect(shown.at(-1)).toMatchObject({
      files: [
        { path: 'a.ts', added: 5, removed: 3, first: 'h1', pending: ['h3'] },
        { path: 'b.ts', added: 2, removed: 0, first: 'h2', pending: ['h2'] },
      ],
    });
  });
});
