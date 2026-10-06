import { describe, expect, it } from 'vitest';
import type { EditorAction } from '@g-code/core';
import { editorStepText } from '../src/chat/editor-step.js';
import { shownSteps } from '../src/chat/fold.js';
import type { Action } from '../src/chat/messages.js';
import { railOf } from '../src/chat/rail.js';
import { emptyTranscript, reduce } from '../src/chat/transcript.js';

const OPEN: EditorAction = { kind: 'open', path: '/ws/src/a.ts', line: 42 };
const turnOf = (actions: readonly Action[]) => [{ type: 'turn-start', id: 't1', at: 1000, prompt: 'p' } as Action, ...actions].reduce(reduce, emptyTranscript('qwen3.8-flash')).turns[0]!;
const call = (id: string, name: string, extra: Partial<Extract<Action, { type: 'tool' }>> = {}): Action => ({ type: 'tool', id, at: 2000, name, target: 'a.ts', toolKind: 'other', status: 'completed', ...extra });

describe('editor action steps', () => {
  it('say what each action showed, in a few words', () => {
    expect(editorStepText(OPEN)).toMatchObject({ verb: 'Opened', target: 'a.ts:42', after: '' });
    expect(editorStepText({ kind: 'open', path: '/ws/a.ts', line: 3, column: 9 }).target).toBe('a.ts:3:9');
    expect(editorStepText({ kind: 'open', path: '/ws/a.ts' }).target).toBe('a.ts');
    expect(editorStepText({ kind: 'diff', path: '/ws/a.ts', base: { sha: 'abc', since: 'turn' } })).toMatchObject({ verb: 'Showed the diff of', target: 'a.ts', after: '' });
    expect(editorStepText({ kind: 'diff', path: '/ws/a.ts', base: { sha: 'abc', since: 'session' } }).after).toBe(' since the session began');
    expect(editorStepText({ kind: 'reveal', path: '/ws/src' })).toMatchObject({ verb: 'Revealed', target: 'src', after: ' in the Explorer' });
  });

  it('draw a call that ran as its own step, and one still running or refused as a plain call', () => {
    const turn = turnOf([call('o', 'open_file', { editorAction: OPEN }), call('o2', 'open_file', { status: 'failed' }), call('o3', 'open_file', { status: 'running' })]);
    expect(railOf(turn).map((step) => step.kind)).toEqual(['editor', 'calls', 'calls']);
  });

  it('stay in view when a compact turn folds its work', () => {
    const turn = turnOf([
      call('g', 'grep', { toolKind: 'search' }),
      call('o', 'open_file', { editorAction: OPEN }),
      { type: 'text', text: 'It is open.' },
      { type: 'turn-end', at: 9000, status: 'done', usage: undefined },
    ]);
    expect(shownSteps(turn, 'compact', false).map((step) => step.kind)).toEqual(['fold', 'editor', 'text']);
  });
});
