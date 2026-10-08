import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { asSessionId, childrenOf } from '@g-code/core';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { sessionIdOf } from './conformance/scripted.js';
import { answer, fakeTransport, loadTools, toolCall, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand, runCli } from './helpers.js';

vi.setConfig({ testTimeout: 30_000 });

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

type Body = { readonly messages: { readonly role: string; readonly content: unknown }[] };
type Script = (n: number, body: Body) => Reply | Promise<Reply>;

/** One scripted model per conversation, picked by a marker in its first message; each request is recorded. */
function models(scripts: Readonly<Record<string, Script>>) {
  const requests = new Map<string, Body[]>(Object.keys(scripts).map((marker) => [marker, []]));
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Body;
    const marker = Object.keys(scripts).find((m) => JSON.stringify(body.messages[0]).includes(m))!;
    const seen = requests.get(marker)!;
    seen.push(body);
    return fakeTransport([await scripts[marker]!(seen.length - 1, body)]).fetch(input, init);
  };
  return { fetch, requests: (marker: string) => requests.get(marker)! };
}

async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type Block = { readonly type: string; readonly tool_use_id?: string; readonly text?: string; readonly content?: unknown };
const blocksOf = (body: Body): Block[] => body.messages.at(-1)!.content as Block[];
const resultText = (body: Body, id: string): string => JSON.stringify(blocksOf(body).find((b) => b.type === 'tool_result' && b.tool_use_id === id)?.content);

describe('stopping a background subagent', () => {
  it("the model lists its background explore, stops it with task_stop, and gets the explore's cancelled partial report", async () => {
    let childId = '';
    const model = models({
      '[parent]': async (n, body) => {
        if (n === 0) return toolCall('Starting an explorer.', [{ id: 'tu_a', name: 'agent', input: { agent: 'explore', task: '[child] where is alpha', background: true } }, loadTools('task_stop', 'list_agents')], usage);
        if (n === 1) {
          childId = /subagent session ([0-9a-f-]{36})/.exec(JSON.stringify(body.messages.at(-1)!.content))![1]!;
          // The explorer has searched once and waits on its second model call when the parent stops it.
          await until(() => model.requests('[child]').length === 2, "the explorer's second model call");
          return toolCall('That is enough; stopping it.', [{ id: 'tu_list', name: 'list_agents', input: {} }, { id: 'tu_stop', name: 'task_stop', input: { id: childId } }, { id: 'tu_after', name: 'list_agents', input: {} }], usage);
        }
        return answer('alpha is in a.ts, as far as the explorer got.', usage);
      },
      '[child]': (n) => (n === 0 ? toolCall('Found alpha in a.ts:1 so far.', [{ id: 'tu_grep', name: 'grep', input: { pattern: 'alpha' } }], usage) : { events: [], hang: true }),
    });
    const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'export const alpha = 1;\n', '.gcode.json': '{ "agentTool": ["non-interactive"] }\n' } }]));
    const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
    const env = {
      GCODE_HOME: home,
      HOME: home,
      GCODE_PROVIDER: 'modelstudio',
      GCODE_MODEL: 'qwen3.8-flash',
      DASHSCOPE_API_KEY: 'sk-fake',
      DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
      GCODE_RG: rgCommand(),
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    };
    const result = await runCli(['agent', '--workspace', workspace, '--non-interactive', '[parent] find alpha in the background'], env, { fetch: model.fetch });
    expect(result.code, result.stderr).toBe(0);

    const parent = model.requests('[parent]');
    expect(parent, 'no report arrives after the stop: the stop returned it').toHaveLength(3);
    const third = parent[2]!;
    expect(resultText(third, 'tu_list')).toMatch(new RegExp(`- ${childId}: explore subagent, running\\. qwen3\\.8-flash, \\d+ turns?, `));
    const stopped = JSON.parse(resultText(third, 'tu_stop')) as string | { text: string }[];
    const text = typeof stopped === 'string' ? stopped : stopped.map((b) => b.text).join('\n');
    expect(text.split('\n')[0]).toMatch(new RegExp(`^<subagent_report agent="explore" session="${childId}" status="cancelled" partial="true" turns="1" `));
    expect(text).toContain('\n  Found alpha in a.ts:1 so far.\n');
    expect(text).toContain('The subagent was stopped with task_stop before it finished');
    expect(resultText(third, 'tu_after')).toMatch(new RegExp(`- ${childId}: explore subagent, cancelled\\.`));
    expect(blocksOf(third).filter((b) => b.type === 'text').map((b) => b.text).join('\n')).not.toContain('<subagent_report');

    const store = openStore(env);
    const events = (await readSessionLog(sessionFile(store, asSessionId(sessionIdOf(result.stdout))))).events;
    expect(childrenOf(events).map((child) => [child.child, child.status])).toEqual([[childId, { kind: 'cancelled', by: 'model' }]]);
  });
});
