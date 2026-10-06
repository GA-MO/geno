import { asSessionId, FORK_AT_META, REWIND_PREVIEW_METHOD, REWIND_TURN_METHOD, type TaskRecord } from '@g-code/core';
import { describe, expect, it } from 'vitest';
import type { Connection } from '../src/chat/engine.js';
import type { Action, Transcript } from '../src/chat/messages.js';
import { RewindHost } from '../src/chat/rewind-host.js';
import { confirmOf, fileList, offersRewind, restoredText, type RewindToView } from '../src/chat/rewind-model.js';
import { taskRowOf } from '../src/chat/lanes-model.js';
import { emptyTranscript, reduce } from '../src/chat/transcript.js';

const run = (actions: readonly Action[], start: Transcript = emptyTranscript('qwen3.8-flash')): Transcript => actions.reduce(reduce, start);
const started = (id: string, seq?: number): Action => ({ type: 'turn-start', id, at: 1, prompt: `prompt ${id}`, seq });
const ended = (seq?: number): Action => ({ type: 'turn-end', at: 2, status: 'done', usage: undefined, seq });

describe('the turn a message names', () => {
  it('takes its seq from a replayed start, or from the prompt response at its end', () => {
    const transcript = run([started('t1', 1), ended(), started('t2'), ended(7)]);
    expect(transcript.turns.map((t) => t.seq)).toEqual([1, 7]);
  });

  it.each([
    { name: 'a finished turn the engine named', actions: [started('t1', 1), ended()], offered: true },
    { name: 'a turn the engine has not named yet', actions: [started('t1'), ended()], offered: false },
    { name: 'a turn that still runs', actions: [started('t1', 1)], offered: false },
    { name: 'an earlier turn while the last one runs', actions: [started('t1', 1), ended(), started('t2')], offered: false },
  ])('offers the menu on $name: $offered', ({ actions, offered }) => {
    const transcript = run(actions);
    expect(offersRewind(transcript.turns[0]!, transcript)).toBe(offered);
  });

  it('offers no menu in an external agent session, which keeps its own conversation', () => {
    const transcript = { ...run([started('t1', 1), ended()]), backend: { id: 'cursor', label: 'Cursor', plan: 'Cursor plan', lane: null } } as Transcript;
    expect(offersRewind(transcript.turns[0]!, transcript)).toBe(false);
  });
});

describe('the confirm a restore asks', () => {
  it.each([
    {
      name: 'files only, keyboard on the restore',
      state: { files: ['a.ts'], unsaved: [] },
      want: { title: 'Restore 1 file to before this message: a.ts.', loses: undefined, button: 'Restore files', safeFirst: false },
    },
    {
      name: 'edits no checkpoint holds, keyboard on Cancel',
      state: { files: ['a.ts', 'b.ts'], unsaved: ['b.ts'] },
      want: { title: 'Restore 2 files to before this message: a.ts, b.ts.', loses: 'Edits to b.ts are in no checkpoint, and restoring loses them.', button: 'Restore files', safeFirst: true },
    },
    { name: 'nothing to restore', state: { files: [], unsaved: [] }, want: { title: 'No files changed since this message.', loses: undefined, button: 'Restore files', safeFirst: false } },
  ])('$name', ({ state, want }) => {
    expect(confirmOf({ kind: 'confirm', action: 'files', ...state })).toEqual(want);
  });

  it('names a few files and counts the rest', () => {
    expect(fileList(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c and 2 more');
    expect(restoredText(['a.ts'])).toBe('Restored 1 file: a.ts.');
    expect(restoredText([])).toBe('No files needed restoring.');
  });
});

/** A connection that answers each method from `answers`, recording what was asked. */
function fakeEngine(answers: Readonly<Record<string, unknown>>) {
  const asked: { method: string; params: unknown }[] = [];
  const connection = {
    cwd: '/ws',
    agent: {
      request: async (method: string, params: unknown) => {
        asked.push({ method, params });
        const answer = answers[method];
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  } as unknown as Connection;
  return { connection, asked };
}

function host(connection: Connection, idle = true) {
  const posted: RewindToView[] = [];
  const shown: string[] = [];
  let reloads = 0;
  const rewinds = new RewindHost({
    connection: async () => connection,
    idle: () => (idle ? { sessionId: 's1', cwd: undefined } : undefined),
    seqOf: (turn) => (turn === 't2' ? 5 : undefined),
    turnAt: (seq) => (seq === 5 ? 't7' : undefined),
    reload: async () => void reloads++,
    open: async (sessionId) => void shown.push(sessionId),
    post: (message) => void posted.push(message),
  });
  return { rewinds, posted, shown, reloads: () => reloads };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the host running the menu', () => {
  it('lists the files before restoring them, then restores on the yes and loads the session again', async () => {
    const { connection, asked } = fakeEngine({
      [REWIND_PREVIEW_METHOD]: { files: ['a.ts', 'b.ts'], unsaved: ['b.ts'] },
      [REWIND_TURN_METHOD]: { files: ['a.ts', 'b.ts'], prompt: 'make it three' },
    });
    const { rewinds, posted, reloads } = host(connection);
    rewinds.handlers.rewind({ type: 'rewind', turn: 't2', kind: 'files', confirmed: false });
    await flush();
    expect(asked).toEqual([{ method: REWIND_PREVIEW_METHOD, params: { sessionId: 's1', turnSeq: 5 } }]);
    expect(posted.at(-1)).toEqual({ type: 'rewind-state', turn: 't2', state: { kind: 'confirm', action: 'files', files: ['a.ts', 'b.ts'], unsaved: ['b.ts'] } });

    rewinds.handlers.rewind({ type: 'rewind', turn: 't2', kind: 'files', confirmed: true });
    await flush();
    expect(asked.at(-1)).toEqual({ method: REWIND_TURN_METHOD, params: { sessionId: 's1', turnSeq: 5, choice: { kind: 'files' } } });
    expect(reloads(), 'the session loads again, with the restored hunks undone').toBe(1);
    expect(posted.at(-1), 'on the same message under its new id').toEqual({ type: 'rewind-state', turn: 't7', state: { kind: 'restored', files: ['a.ts', 'b.ts'] } });
  });

  it('rewinds the conversation at once, reloads the session and puts the prompt back in the composer', async () => {
    const { connection, asked } = fakeEngine({ [REWIND_TURN_METHOD]: { files: [], prompt: 'make it three' } });
    const { rewinds, posted, reloads } = host(connection);
    rewinds.handlers.rewind({ type: 'rewind', turn: 't2', kind: 'conversation', confirmed: false });
    await flush();
    expect(asked.map((a) => a.method)).toEqual([REWIND_TURN_METHOD]);
    expect(reloads()).toBe(1);
    expect(posted.at(-1)).toEqual({ type: 'rewind-prompt', text: 'make it three' });
  });

  it('forks through session/fork at the turn and shows the fork', async () => {
    const { connection, asked } = fakeEngine({ 'session/fork': { sessionId: 'f1' } });
    const { rewinds, shown } = host(connection);
    rewinds.handlers.fork({ type: 'fork', turn: 't2' });
    await flush();
    expect(asked).toEqual([{ method: 'session/fork', params: { sessionId: 's1', cwd: '/ws', mcpServers: [], _meta: { [FORK_AT_META]: 5 } } }]);
    expect(shown).toEqual(['f1']);
  });

  it.each([
    { name: 'a running turn', idle: false, turn: 't2', message: 'Stop the running turn first.' },
    { name: 'a message the log has not named', idle: true, turn: 't1', message: 'This message is not in the session log yet.' },
  ])('says why it cannot act on $name', async ({ idle, turn, message }) => {
    const { connection, asked } = fakeEngine({});
    const { rewinds, posted } = host(connection, idle);
    rewinds.handlers.fork({ type: 'fork', turn });
    await flush();
    expect(asked).toEqual([]);
    expect(posted.at(-1)).toEqual({ type: 'rewind-state', turn, state: { kind: 'failed', message } });
  });

  it('shows the engine refusal on the message', async () => {
    const { connection } = fakeEngine({ [REWIND_TURN_METHOD]: new Error('the turn at event 5 never reached the model, so it has no checkpoint to restore') });
    const { rewinds, posted } = host(connection);
    rewinds.handlers.rewind({ type: 'rewind', turn: 't2', kind: 'both', confirmed: true });
    await flush();
    expect(posted.at(-1)).toMatchObject({ state: { kind: 'failed', message: expect.stringContaining('no checkpoint') } });
  });
});

describe('a fork in the Tasks pane', () => {
  it('links its row to the session it came from', () => {
    const task = { sessionId: 'f1', title: 'make it two', workspace: '/ws', lane: null, status: 'done', startedAt: 1, endedAt: 2, forkedFrom: { sessionId: asSessionId('s1'), turnSeq: 1, title: 'make it two' } } satisfies TaskRecord;
    const row = taskRowOf({ task, children: [], attention: { kind: 'done' }, returnedAt: 2, key: [3, 0, 0] }, undefined, 3);
    expect(row.forkedFrom).toEqual({ id: 's1', title: 'make it two', workspace: '/ws' });
  });
});

