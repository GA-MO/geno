import { appendFile, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { asSessionId, type TurnEvent } from '@g-code/core';
import { appendEvent, dropTornTail, readSessionLog } from '../src/sessions.js';
import { StoreError } from '../src/store.js';

const at = '2026-10-04T00:00:01.000Z';
const start: TurnEvent = {
  kind: 'session-start',
  session: {
    id: asSessionId('s1'),
    createdAt: at,
    workspace: '/tmp/ws',
    provider: 'openrouter',
    model: 'anthropic/claude-opus-5.5',
    effort: 'medium',
  },
};
const user = (seq: number): TurnEvent => ({ kind: 'user', seq, at, content: `message ${seq}` });

async function logWith(events: TurnEvent[]): Promise<string> {
  const file = path.join(await mkdtemp(path.join(tmpdir(), 'gcode-session-')), 's1.jsonl');
  for (const event of events) await appendEvent(file, event);
  return file;
}

describe('session log', () => {
  it('reads a log written before providers existed as an OpenRouter session', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'gcode-session-')), 's1.jsonl');
    const { provider: _, ...legacy } = start.kind === 'session-start' ? start.session : ({} as never);
    await appendFile(file, `${JSON.stringify({ kind: 'session-start', session: legacy })}\n`);
    const log = await readSessionLog(file);
    expect(log.session.provider).toBe('openrouter');
  });

  it('reads back what was appended', async () => {
    const file = await logWith([start, user(1)]);
    const log = await readSessionLog(file);
    expect(log.events).toEqual([start, user(1)]);
    expect(log.tornLine).toBeUndefined();
  });

  it('skips and reports a torn trailing line, and a repaired log appends cleanly', async () => {
    const file = await logWith([start, user(1)]);
    await appendFile(file, '{"kind":"user","seq":2,"at":"2026-10');

    const log = await readSessionLog(file);
    expect(log.tornLine).toBe(3);
    expect(log.events).toEqual([start, user(1)]);

    await dropTornTail(log);
    await appendEvent(file, user(2));
    expect((await readSessionLog(file)).events).toEqual([start, user(1), user(2)]);
    expect((await readFile(file, 'utf8')).split('\n')).toHaveLength(4);
  });

  it('fails on a torn line before the end, naming the file and line', async () => {
    const file = await logWith([start]);
    await appendFile(file, '{"kind":"user","se\n');
    await appendEvent(file, user(2));

    const error = await readSessionLog(file).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).message).toContain(file);
    expect((error as StoreError).message).toContain('line 2');
  });

  it('fails on a schema violation even on the last line', async () => {
    const file = await logWith([start]);
    await appendFile(file, `${JSON.stringify({ kind: 'user', seq: 0, at, content: 'x' })}\n`);
    await expect(readSessionLog(file)).rejects.toThrow(`${file}: line 2`);
  });
});
