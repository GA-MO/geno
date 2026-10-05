import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { asSessionId } from '@g-code/core';
import { appendEvent } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { runCli } from './helpers.js';

describe('gcode session list', () => {
  it('lists the current project\'s sessions newest first, and with --all every project but temporary ones', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
    const workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-ws-')));
    const env = { GCODE_HOME: home };
    const store = openStore(env);
    const logged = async (id: string, dir: string, at: string, prompts: readonly string[], costUsd: number | null) => {
      const file = path.join(store.sessionsDir, `${id}.jsonl`);
      await appendEvent(file, {
        kind: 'session-start',
        session: { id: asSessionId(id), createdAt: at, workspace: dir, provider: 'modelstudio', model: 'qwen3.8-flash', effort: 'medium' },
      });
      let seq = 1;
      for (const content of prompts) {
        await appendEvent(file, { kind: 'user', seq: seq++, at, content });
        await appendEvent(file, {
          kind: 'assistant',
          seq: seq++,
          at,
          content: [],
          stopReason: 'end_turn',
          usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
          costUsd,
          latencyMs: 1,
          model: 'qwen3.8-flash',
        });
      }
    };
    await logged('old', workspace, '2026-10-01T00:00:00.000Z', ['Fix the parser'], 0.001);
    await logged('new', workspace, '2026-10-02T00:00:00.000Z', ['Add a test', 'Run it'], null);
    await logged('empty', workspace, '2026-10-03T00:00:00.000Z', [], 0);
    await logged('other', '/Users/someone/elsewhere', '2026-10-02T12:00:00.000Z', ['Tidy the README'], 0.02);

    const mine = await runCli(['session', 'list'], env, { cwd: workspace });
    expect(mine.code).toBe(0);
    expect(mine.stdout.split('\n')).toEqual([
      `new  2026-10-02T00:00:00.000Z    2 turns  cost unknown  ${path.basename(workspace)}  Add a test`,
      `old  2026-10-01T00:00:00.000Z     1 turn       $0.0010  ${path.basename(workspace)}  Fix the parser`,
      `2 sessions in ${workspace}`,
    ]);

    const all = await runCli(['session', 'list', '--all'], env, { cwd: workspace });
    expect(all.stdout.split('\n')).toEqual(['other  2026-10-02T12:00:00.000Z     1 turn       $0.0200  elsewhere  Tidy the README', '1 session in every project']);
  });
});
