import { describe, expect, it } from 'vitest';
import { checkHeadline, checkOutcomeOf, laneNameFor, reviewState, TASK_STATUSES, taskNotice, type FileChange, type HunkId, type TurnEvent } from '../src/index.js';

const at = '2026-10-06T00:00:00.000Z';
const result = (seq: number, output: string): TurnEvent => ({ kind: 'tool-result', seq, at, toolUseId: `t${seq}`, name: 'edit', status: 'ok', output });

describe('the notification trigger table', () => {
  it('tells the user when a task finishes, fails or waits for them, and nothing else', () => {
    const told = Object.fromEntries(TASK_STATUSES.map((to) => [to, taskNotice('running', to)?.kind ?? null]));
    expect(told).toEqual({ running: null, 'needs-input': 'needs-input', waiting: null, done: 'done', failed: 'failed', stopped: null });
  });

  it('says nothing for a status that did not change, or for going back to work after an answer', () => {
    for (const status of TASK_STATUSES) expect(taskNotice(status, status)).toBeUndefined();
    expect(taskNotice('needs-input', 'running')).toBeUndefined();
    expect(taskNotice(undefined, 'running')).toBeUndefined();
  });

  it('still tells a failure or an end that came while the task waited for an answer', () => {
    expect(taskNotice('needs-input', 'failed')?.severity).toBe('error');
    expect(taskNotice('needs-input', 'done')?.severity).toBe('info');
  });
});

describe('checkOutcomeOf', () => {
  it('reads the last check an edit ran', () => {
    expect(checkOutcomeOf([])).toBe('none');
    expect(checkOutcomeOf([result(1, 'edited a.ts')])).toBe('none');
    const passed = `edited a.ts\n${checkHeadline('tsc --noEmit', 0, false)}`;
    const failed = `edited a.ts\n${checkHeadline('tsc --noEmit', 2, false)}\na.ts(1,1): error`;
    const timedOut = `edited a.ts\n${checkHeadline('tsc --noEmit', null, true)}`;
    expect(checkOutcomeOf([result(1, failed), result(2, passed)])).toBe('passed');
    expect(checkOutcomeOf([result(1, passed), result(2, failed), result(3, 'read b.ts')])).toBe('failed');
    expect(checkOutcomeOf([result(1, timedOut)])).toBe('failed');
  });
});

describe('a lane apply under review', () => {
  it("puts every changed file's hunks under review, and takes decisions on them", () => {
    const change: FileChange = { id: 'c1', path: '/repo/a.ts', hunks: [{ startLine: 1, lineCount: 1, oldText: 'a\n', newText: 'b\n', status: 'pending' }] };
    const other: FileChange = { id: 'c2', path: '/repo/b.ts', hunks: [{ startLine: 2, lineCount: 0, oldText: '', newText: 'x\n', status: 'pending' }] };
    const events: TurnEvent[] = [
      { kind: 'lane-apply', seq: 1, at, lane: 'fix', changes: [change, other], conflicts: [], deleted: [] },
      { kind: 'review', seq: 2, at, hunk: 'c1:0' as HunkId, status: 'kept' },
    ];
    expect(reviewState(events).map((h) => [h.id, h.path, h.status])).toEqual([
      ['c1:0', '/repo/a.ts', 'kept'],
      ['c2:0', '/repo/b.ts', 'pending'],
    ]);
  });
});

describe('laneNameFor', () => {
  it('names a lane after the first words of its prompt, numbered when taken', () => {
    expect(laneNameFor('Fix the login button, please!', new Set())).toBe('fix-the-login-button-please');
    expect(laneNameFor('Fix the login button', new Set(['fix-the-login-button']))).toBe('fix-the-login-button-2');
    expect(laneNameFor('ทดสอบ', new Set())).toBe('lane');
    expect(laneNameFor('one two three four five six seven eight nine ten', new Set()).length).toBeLessThanOrEqual(32);
  });
});
