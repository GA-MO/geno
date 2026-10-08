import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { asSessionId, INTERRUPTED_CALL, interruptedText, type ChildStartEvent, type Session, type SessionId, type TurnEvent } from '@g-code/core';
import { recoverInterrupted } from '../src/interrupted.js';
import { appendEvent, readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore, type Store } from '../src/store.js';

const at = (s: number) => new Date(Date.UTC(2026, 9, 8, 12, 0, s)).toISOString();
const gone = 900_001;
const running = 900_002;
// The engines that run the recovery are alive too, so each holds its lock until it is done.
const alive = (pid: number) => pid === running || pid === 4242 || pid === 4243;
const usage = { input: 100, cacheRead: 0, cacheWrite: 0, output: 10 };
const caps = { maxTurns: 4, maxCostUsd: 0.05 };
const serially = <T>(_: string, work: () => Promise<T>) => work();
const deps = { serially, alive, pid: 4242, now: () => new Date(at(30)) };

const session = (id: string): Session => ({ id: asSessionId(id), createdAt: at(0), workspace: '/w', provider: 'modelstudio', model: 'm', effort: 'medium' });
const call = (seq: number, id: string, name: string, input: Record<string, unknown>, second: number): Extract<TurnEvent, { kind: 'assistant' }> => ({
  kind: 'assistant',
  seq,
  at: at(second),
  content: [{ type: 'tool_use', id, name, input, caller: { type: 'direct' } }],
  stopReason: 'tool_use',
  usage,
  costUsd: 0.001,
  latencyMs: 5,
  model: 'm',
});
const startOf = (child: string, toolUseId: string, pid: number, seq = 3): ChildStartEvent => ({
  kind: 'child-start',
  seq,
  at: at(2),
  child: asSessionId(child),
  toolUseId,
  role: 'explore',
  model: 'm',
  effort: 'low',
  caps,
  start: 'fresh',
  by: { pid, cwd: '/w' },
});

async function write(store: Store, id: string, events: readonly TurnEvent[]) {
  for (const event of events) await appendEvent(sessionFile(store, asSessionId(id)), event);
}

/** A parent blocked in its agent call, and its child cut off while its read ran. */
async function crashed(pid = gone) {
  const store = openStore({ GCODE_HOME: await mkdtemp(path.join(tmpdir(), 'gcode-cut-')) });
  await write(store, 'p', [{ kind: 'session-start', session: session('p') }, { kind: 'user', seq: 1, at: at(1), content: 'find alpha' }, call(2, 'tu_a', 'agent', { agent: 'explore', task: 'where is alpha' }, 1), startOf('c', 'tu_a', pid)]);
  await write(store, 'c', [
    { kind: 'session-start', session: session('c'), child: { parentId: asSessionId('p'), toolUseId: 'tu_a', role: 'explore', caps, start: 'fresh' } },
    { kind: 'user', seq: 1, at: at(2), content: 'where is alpha' },
    { ...call(2, 'tu_r', 'read', { path: 'a.ts' }, 3), content: [{ type: 'text', text: 'alpha is in a.ts, reading it.', citations: null }, { type: 'tool_use', id: 'tu_r', name: 'read', input: { path: 'a.ts' }, caller: { type: 'direct' } }] },
  ]);
  return store;
}

const logOf = async (store: Store, id: string) => [...(await readSessionLog(sessionFile(store, asSessionId(id)))).events];
const bytes = (store: Store, id: string) => readFile(sessionFile(store, asSessionId(id) as SessionId), 'utf8');

describe('recoverInterrupted', () => {
  it("ends a run its stopped engine left open, answers the calls it left running, and tells the parent once", async () => {
    const store = await crashed();
    const sessions = await recoverInterrupted(store, '/w', deps);
    const run = { child: asSessionId('c'), toolUseId: 'tu_a', role: 'explore', report: 'alpha is in a.ts, reading it.', files: [], usage: { turns: 1, costUsd: 0.001, durationMs: 1000 } };

    expect((await logOf(store, 'c')).at(-1)).toMatchObject({ kind: 'tool-result', toolUseId: 'tu_r', status: 'error', output: INTERRUPTED_CALL });
    expect((await logOf(store, 'p')).slice(4)).toEqual([
      { kind: 'tool-result', seq: 4, at: at(30), toolUseId: 'tu_a', name: 'agent', status: 'error', output: INTERRUPTED_CALL },
      { kind: 'wake', seq: 5, at: at(30), note: { kind: 'interrupted', runs: [{ child: 'c', toolUseId: 'tu_a' }], text: interruptedText([run]) } },
      { kind: 'child-end', seq: 6, at: at(30), child: 'c', toolUseId: 'tu_a', end: { kind: 'interrupted' }, turns: 1, costUsd: 0.001, summary: 'alpha is in a.ts, reading it.' },
    ]);
    expect(sessions).toEqual([{ sessionId: 'p', title: 'find alpha', workspace: '/w', children: [{ child: 'c', role: 'explore', summary: 'alpha is in a.ts, reading it.' }] }]);

    const [parent, child] = [await bytes(store, 'p'), await bytes(store, 'c')];
    expect(await recoverInterrupted(store, '/w', deps), 'a later start still lists the child for Tasks').toEqual(sessions);
    expect([await bytes(store, 'p'), await bytes(store, 'c')], 'and writes nothing again').toEqual([parent, child]);
  });

  it('tells each run once when two engines start together', async () => {
    const store = await crashed();
    await Promise.all([recoverInterrupted(store, '/w', deps), recoverInterrupted(store, '/w', { ...deps, pid: 4243 })]);
    const events = await logOf(store, 'p');
    expect(events.filter((e) => e.kind === 'wake')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'child-end')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'tool-result')).toHaveLength(1);
  });

  it('finishes what a crash midway left: a run already told gets its end, and no second notice', async () => {
    const store = await crashed();
    await recoverInterrupted(store, '/w', deps);
    const events = await logOf(store, 'p');
    const store2 = openStore({ GCODE_HOME: await mkdtemp(path.join(tmpdir(), 'gcode-cut-')) });
    await write(store2, 'p', events.filter((e) => e.kind !== 'child-end'));
    await write(store2, 'c', await logOf(store, 'c'));
    await recoverInterrupted(store2, '/w', deps);
    expect((await logOf(store2, 'p')).slice(4).map((e) => e.kind)).toEqual(['tool-result', 'wake', 'child-end']);
  });

  it('leaves a run a live engine holds, one of another folder, and one logged before runs named their engine', async () => {
    const store = await crashed(running);
    await write(store, 'q', [{ kind: 'session-start', session: session('q') }, { ...startOf('d', 'tu_d', gone), seq: 1, by: { pid: gone, cwd: '/elsewhere' } }]);
    const { by: _, ...unnamed } = startOf('e', 'tu_e', gone, 1);
    await write(store, 'r', [{ kind: 'session-start', session: session('r') }, unnamed]);
    const before = await Promise.all(['p', 'c', 'q', 'r'].map((id) => bytes(store, id)));
    expect(await recoverInterrupted(store, '/w', deps)).toEqual([]);
    expect(await Promise.all(['p', 'c', 'q', 'r'].map((id) => bytes(store, id)))).toEqual(before);
  });

  it("tells the session that started a workflow of its cut-off step, and ends the step in the workflow's log", async () => {
    const store = openStore({ GCODE_HOME: await mkdtemp(path.join(tmpdir(), 'gcode-cut-')) });
    await write(store, 'p', [{ kind: 'session-start', session: session('p') }, { kind: 'user', seq: 1, at: at(1), content: 'run the review workflow' }]);
    await write(store, 'w', [
      { kind: 'session-start', session: session('w'), workflow: { parentId: asSessionId('p'), toolUseId: 'tu_wf', name: 'review' } },
      { kind: 'user', seq: 1, at: at(1), content: 'Run the workflow review.' },
      { ...call(2, 'tu_s', 'agent', { agent: 'explore', task: 'look' }, 1), issuedBy: 'user' },
      startOf('s', 'tu_s', gone),
    ]);
    await write(store, 's', [{ kind: 'session-start', session: session('s'), child: { parentId: asSessionId('w'), toolUseId: 'tu_s', role: 'explore', caps, start: 'fresh' } }, { kind: 'user', seq: 1, at: at(2), content: 'look' }]);

    const sessions = await recoverInterrupted(store, '/w', deps);
    const step = { child: asSessionId('s'), toolUseId: 'tu_s', role: 'explore', report: '', files: [], usage: { turns: 0, costUsd: 0, durationMs: 0 }, workflow: { session: asSessionId('w'), name: 'review' } };
    expect((await logOf(store, 'p')).slice(2)).toEqual([{ kind: 'wake', seq: 2, at: at(30), note: { kind: 'interrupted', runs: [{ child: 's', toolUseId: 'tu_s' }], text: interruptedText([step]) } }]);
    expect((await logOf(store, 'w')).slice(4).map((e) => [e.kind, e.kind === 'child-end' ? e.end.kind : e.kind === 'tool-result' ? e.toolUseId : undefined])).toEqual([
      ['tool-result', 'tu_s'],
      ['child-end', 'interrupted'],
    ]);
    expect(sessions).toEqual([{ sessionId: 'p', title: 'run the review workflow', workspace: '/w', children: [{ child: 's', role: 'explore', summary: '' }] }]);

    await write(store, 'p', [{ ...startOf('s', 'tu_m', 4242, 3), at: at(40) }, { kind: 'child-end', seq: 4, at: at(41), child: asSessionId('s'), toolUseId: 'tu_m', end: { kind: 'done' }, turns: 1, costUsd: 0.001, summary: 'done' }]);
    expect(await recoverInterrupted(store, '/w', deps), 'a step resumed from the session that started it is no longer cut off').toEqual([]);
  });
});
