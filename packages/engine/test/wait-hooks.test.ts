import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { asSessionId, type Session, type TurnEvent, type Waiter, type Waiting } from '@g-code/core';
import { appendEvent, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { waitsLeft } from '../src/wait-hooks.js';

const at = '2026-10-06T14:00:00.000Z';
const wait: Waiting = { kind: 'limited', since: Date.parse(at), retryAt: Date.parse(at) + 60_000, resetAt: Date.parse(at) + 60_000, message: '429' };

async function storeWith(logs: Record<string, { by?: Waiter; child?: true; after?: TurnEvent }>) {
  const store = openStore({ GCODE_HOME: await mkdtemp(path.join(tmpdir(), 'gcode-waits-')) });
  for (const [id, { by, child, after }] of Object.entries(logs)) {
    const session: Session = { id: asSessionId(id), createdAt: at, workspace: '/w', provider: 'modelstudio', model: 'm', effort: 'medium' };
    const file = sessionFile(store, session.id);
    await appendEvent(file, { kind: 'session-start', session, ...(child ? { child: { parentId: asSessionId('p'), toolUseId: 't', role: 'explore', caps: { maxTurns: 5, maxCostUsd: 0.1 }, start: 'fresh' } } : {}) });
    await appendEvent(file, { kind: 'user', seq: 1, at, content: 'hi' });
    await appendEvent(file, { kind: 'wait', seq: 2, at, wait, ...(by === undefined ? {} : { by }) });
    if (after !== undefined) await appendEvent(file, after);
  }
  return store;
}

describe('waitsLeft', () => {
  const gone = 900_001;
  const running = 900_002;
  const alive = (pid: number) => pid === running;

  it('takes up only the waits of a stopped engine for this folder, left open, in a session of its own', async () => {
    const store = await storeWith({
      mine: { by: { pid: gone, cwd: '/w' } },
      'still-running': { by: { pid: running, cwd: '/w' } },
      'other-folder': { by: { pid: gone, cwd: '/elsewhere' } },
      'from-the-cli': {},
      answered: { by: { pid: gone, cwd: '/w' }, after: { kind: 'error', seq: 3, at, error: 'abort', message: 'stopped' } },
      subagent: { by: { pid: gone, cwd: '/w' }, child: true },
    });
    expect(await waitsLeft(store, '/w', alive)).toEqual(['mine']);
  });

  it('finds nothing in a store with no sessions yet', async () => {
    expect(await waitsLeft(openStore({ GCODE_HOME: await mkdtemp(path.join(tmpdir(), 'gcode-waits-')) }), '/w', alive)).toEqual([]);
  });
});
