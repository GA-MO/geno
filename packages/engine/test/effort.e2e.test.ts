import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EFFORT_POLICIES, TOOL_DEFINITIONS, type EffortPolicy } from '@g-code/core';
import { startSession } from '../src/chat.js';
import type { Io } from '../src/command.js';
import { drive } from '../src/drive.js';
import { openStore } from '../src/store.js';
import { EXECUTORS } from '../src/tools/index.js';
import { answer, fakeTransport, toolCall } from './fake-transport.js';
import { rgCommand } from './helpers.js';

const usage = { input: 2000, cacheRead: 0, cacheWrite: 0 };

// A grep that finds the line, a call to a tool that does not exist, then the answer.
const replies = () => [
  toolCall('Searching.', [{ id: 'tu_1', name: 'grep', input: { pattern: 'SERVER_URL', path: 'src/**' } }], usage),
  toolCall('Checking.', [{ id: 'tu_2', name: 'no_such_tool', input: {} }], usage),
  answer('It is read in src/config.ts.', usage),
];

async function efforts(policy: EffortPolicy | undefined): Promise<unknown[]> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-effort-')));
  const workspace = path.join(root, 'ws');
  await mkdir(path.join(workspace, 'src'), { recursive: true });
  await writeFile(path.join(workspace, 'src', 'config.ts'), "export const SERVER_URL = process.env.SERVER_URL ?? '';\n");
  const env = { GCODE_HOME: path.join(root, 'home'), GCODE_PROVIDER: 'modelstudio', DASHSCOPE_API_KEY: 'sk-test', DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic', GCODE_RG: rgCommand() };
  const transport = fakeTransport(replies());
  const io: Io = { env, cwd: workspace, out: () => {}, err: () => {}, write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch: transport.fetch };
  const store = openStore(env);
  const opened = await startSession(store, io, { workspace, provider: undefined, model: undefined, effort: 'high' });
  const result = await drive(io, store, opened, 'Where is SERVER_URL read?', { maxTurns: 5, maxCostUsd: 1 }, {
    tools: TOOL_DEFINITIONS,
    executors: EXECUTORS,
    ...(policy === undefined ? {} : { effortPolicy: policy }),
  });
  expect(result.reason).toBe('end_turn');
  return transport.requests.map((r) => r.body.output_config);
}

describe('effort per turn kind', () => {
  it('sends the session effort on every call by default, as before the table', async () => {
    expect(await efforts(undefined)).toEqual([{ effort: 'high' }, { effort: 'high' }, { effort: 'high' }]);
  });

  it('steps a follow-up after good tool results down, and keeps the prompt and the turn after a failed tool at the session effort', async () => {
    expect(await efforts(EFFORT_POLICIES.stepped)).toEqual([{ effort: 'high' }, { effort: 'medium' }, { effort: 'high' }]);
  });
});
