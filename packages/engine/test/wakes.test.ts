import { describe, expect, it } from 'vitest';
import { BackgroundJobs } from '../src/background.js';
import { Wakes } from '../src/wakes.js';

describe('Wakes', () => {
  it("keeps a resumed child's wait when the report of its earlier run comes after the resume", () => {
    const changed: string[] = [];
    const wakes = new Wakes(new BackgroundJobs({ changed: () => {}, ended: () => {} }), { arrive: () => {}, changed: (sessionId) => void changed.push(sessionId) });
    const first = wakes.child('parent', 'c1', { agent: 'explore', toolUseId: 'tu_agent', silence: () => {}, stop: async () => '' });
    const resumed = wakes.child('parent', 'c1', { agent: 'explore', toolUseId: 'tu_msg', silence: () => {}, stop: async () => '' });
    changed.length = 0;
    first();
    expect(wakes.waitsFor('parent'), 'the session still waits for the resumed run').toEqual([{ kind: 'children', child: 'c1', agent: 'explore' }]);
    expect(changed).toEqual([]);
    resumed();
    expect(wakes.waitsFor('parent')).toEqual([]);
    expect(changed).toEqual(['parent']);
  });

  it('T-BG-06 stops one wake-up by its id: it never fires, the others stay, and the session no longer waits on it', async () => {
    const arrived: string[] = [];
    const wakes = new Wakes(new BackgroundJobs({ changed: () => {}, ended: () => {} }), { arrive: (_s, arrival) => void arrived.push('id' in arrival.note ? arrival.note.id : arrival.note.kind), changed: () => {} });
    const now = Date.now();
    wakes.schedule('s', { kind: 'scheduled', id: 'wake-1', toolUseId: 'tu_1', dueAt: now + 50, reason: 'one' });
    wakes.schedule('s', { kind: 'scheduled', id: 'wake-2', toolUseId: 'tu_2', dueAt: now + 50, reason: 'two' });
    expect(wakes.stop('s', 'wake-1')).toEqual({ kind: 'schedule' });
    expect(wakes.stop('s', 'wake-1'), 'a second stop finds nothing').toBeUndefined();
    expect(wakes.pending('s').map((row) => row.id)).toEqual(['wake-2']);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(arrived).toEqual(['wake-2']);
    expect(wakes.waitsFor('s')).toEqual([]);
  });

  it("stops a background child through the stop it registered, which returns the child's report", async () => {
    const wakes = new Wakes(new BackgroundJobs({ changed: () => {}, ended: () => {} }), { arrive: () => {}, changed: () => {} });
    wakes.child('parent', 'c1', { agent: 'explore', toolUseId: 'tu_agent', silence: () => {}, stop: async () => 'the partial report' });
    expect(await wakes.stopChild('parent', 'c1')).toBe('the partial report');
    expect(wakes.stopChild('parent', 'c2')).toBeUndefined();
    expect(wakes.stopChild('other', 'c1')).toBeUndefined();
  });
});
