import { readFileSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CappedOutput, keepLast } from '../src/background-output.js';
import { jobIdsIn } from '../src/background.js';

const file = async () => path.join(await mkdtemp(path.join(tmpdir(), 'gcode-bg-')), 'session', 'background', 'bg-1.log');

describe('a background command output past its cap', () => {
  it('keeps the newest bytes and drops the oldest', () => {
    expect(keepLast(Buffer.from('abcdef'), Buffer.from('gh'), 4).toString()).toBe('efgh');
    expect(keepLast(Buffer.from('ab'), Buffer.from('cdefgh'), 4).toString()).toBe('efgh');
    expect(keepLast(Buffer.from('ab'), Buffer.from('c'), 4).toString()).toBe('abc');
  });

  it('holds its file near the cap however much the command prints, ending with the newest output', async () => {
    const out = new CappedOutput(await file(), 1000);
    for (let i = 0; i < 500; i++) out.append(Buffer.from(`line ${String(i).padStart(4, '0')}\n`));
    await out.flushed();
    expect(out.printed).toBe(500 * 10);
    expect(statSync(out.file).size).toBeLessThanOrEqual(1250);
    expect(readFileSync(out.file, 'utf8').endsWith('line 0499\n')).toBe(true);
    expect(out.tail(2)).toBe('line 0498\nline 0499');
  });

  it('gives what was printed since the last read, and says how much was dropped before it was read', async () => {
    const out = new CappedOutput(await file(), 20);
    out.append(Buffer.from('one\n'));
    expect(out.unread()).toEqual({ text: 'one\n', dropped: 0 });
    expect(out.unread()).toEqual({ text: '', dropped: 0 });
    out.append(Buffer.from('0123456789'));
    out.append(Buffer.from('abcdefghijklmnop'));
    expect(out.unread()).toEqual({ text: '6789abcdefghijklmnop', dropped: 6 });
  });
});

describe('job ids', () => {
  it('reads the ids a session already used from its start lines and end events', () => {
    const at = '2026-10-06T00:00:00.000Z';
    expect(
      jobIdsIn([
        { kind: 'tool-result', seq: 1, at, toolUseId: 'a', name: 'bash', status: 'ok', output: 'Started background command bg-3. It keeps running.' },
        { kind: 'tool-result', seq: 2, at, toolUseId: 'b', name: 'read', status: 'ok', output: 'Started background command bg-9.' },
        { kind: 'background-end', seq: 3, at, job: { id: 'bg-5', toolUseId: 'c', command: 'x', state: { status: 'stopped', by: 'user' } }, tail: '' },
      ]),
    ).toEqual(['bg-3', 'bg-5']);
  });
});
