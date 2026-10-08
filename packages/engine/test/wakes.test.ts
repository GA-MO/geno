import { describe, expect, it } from 'vitest';
import { BackgroundJobs } from '../src/background.js';
import { Wakes } from '../src/wakes.js';

describe('Wakes', () => {
  it("keeps a resumed child's wait when the report of its earlier run comes after the resume", () => {
    const changed: string[] = [];
    const wakes = new Wakes(new BackgroundJobs({ changed: () => {}, ended: () => {} }), { arrive: () => {}, changed: (sessionId) => void changed.push(sessionId) });
    const first = wakes.child('parent', 'c1', { agent: 'explore', toolUseId: 'tu_agent', silence: () => {} });
    const resumed = wakes.child('parent', 'c1', { agent: 'explore', toolUseId: 'tu_msg', silence: () => {} });
    changed.length = 0;
    first();
    expect(wakes.waitsFor('parent'), 'the session still waits for the resumed run').toEqual([{ kind: 'children', child: 'c1', agent: 'explore' }]);
    expect(changed).toEqual([]);
    resumed();
    expect(wakes.waitsFor('parent')).toEqual([]);
    expect(changed).toEqual(['parent']);
  });
});
