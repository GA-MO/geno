import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { changedOnDiskNote, type TurnEvent } from '@g-code/core';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, toolCall, type FakeToolUse, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand } from './helpers.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const A = 'export const a = 1;\n';
const USER_A = 'export const a = 1;\nexport const fromUser = true;\n';
const USER_EXCERPT = '1\texport const a = 1;\n2\texport const fromUser = true;';

type Body = { readonly messages: { readonly role: string; readonly content: unknown }[] };
/** The fake model: the reply to request `n`, given what that request carried. */
type Model = (n: number, body: Body) => Reply;

const lastTexts = (body: Body): string[] => {
  const content = body.messages.at(-1)!.content;
  return typeof content === 'string' ? [content] : (content as { type: string; text?: string }[]).flatMap((b) => (b.type === 'text' ? [b.text!] : []));
};
const use = (id: string, name: string, input: unknown): FakeToolUse => ({ id, name, input });

/**
 * Serves one prompt to an editor whose buffers start as the disk has them. `buffers` holds the editor's unsaved text;
 * the editor reads a buffer before the disk, and writes into a buffer that has unsaved text, as VS Code does.
 */
async function serve(files: Readonly<Record<string, string>>, model: Model, setup: (workspace: string, buffers: Map<string, string>) => void = () => {}) {
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files }]));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const env = {
    GCODE_HOME: home,
    HOME: home,
    GCODE_PROVIDER: 'modelstudio',
    DASHSCOPE_API_KEY: 'sk-fake',
    DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
    GCODE_RG: rgCommand(),
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  };
  const requests: Body[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Body;
    requests.push(body);
    return fakeTransport([model(requests.length - 1, body)]).fetch(input, init);
  };
  const buffers = new Map<string, string>();
  setup(workspace, buffers);
  const store = openStore(env);
  const io: Io = { env, cwd: workspace, out: () => {}, err: () => {}, write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch };
  const client = acp
    .client({ name: 'test-editor' })
    .onRequest(acp.methods.client.fs.readTextFile, async ({ params }) => ({ content: buffers.get(params.path) ?? readFileSync(params.path, 'utf8') }))
    .onRequest(acp.methods.client.fs.writeTextFile, async ({ params }) => {
      if (buffers.has(params.path)) buffers.set(params.path, params.content);
      else writeFileSync(params.path, params.content);
      return {};
    })
    .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: 'selected', optionId: 'allow' } }));
  const { sessionId, stopReason } = await client.connectWith(gcodeAgent(io, store, { maxTurns: 10, maxCostUsd: 1 }), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
    const { stopReason } = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'Look at a.ts, then b.ts.' }] });
    return { sessionId, stopReason };
  });
  const { events } = await readSessionLog(sessionFile(store, sessionId as never));
  return { workspace, requests, buffers, events, stopReason };
}

const kinds = (events: readonly TurnEvent[]) => events.flatMap((e) => (e.kind === 'session-start' || e.kind === 'checkpoint' ? [] : [e.kind]));

describe('gcode serve: files changed on disk', () => {
  it('tells the model of a file the user changed mid-turn, before its next call, and the model keeps the change', async () => {
    let workspace = '';
    const { requests, events, stopReason } = await serve({ 'a.ts': A, 'b.ts': 'export const b = 2;\n' }, (n, body) => {
      if (n === 0) return toolCall('Reading a.ts.', [use('tu_a', 'read', { path: 'a.ts' })], usage);
      if (n === 1) {
        // The user saves a.ts in the editor while the model works out its next step.
        writeFileSync(path.join(workspace, 'a.ts'), USER_A);
        return toolCall('Now b.ts.', [use('tu_b', 'read', { path: 'b.ts' })], usage);
      }
      if (n === 2 && !lastTexts(body).includes(changedOnDiskNote('a.ts', USER_EXCERPT))) {
        // Without the note the model trusts its stale read and puts a.ts back.
        return toolCall('Restoring a.ts.', [use('tu_revert', 'edit', { path: 'a.ts', old_str: 'export const fromUser = true;\n', new_str: '' })], usage);
      }
      return answer('a.ts has a new export from you; I left it in place.', usage);
    }, (ws) => (workspace = ws));

    expect(stopReason).toBe('end_turn');
    expect(requests).toHaveLength(3);
    expect(lastTexts(requests[1]!).join('\n')).not.toContain('changed on disk');
    expect(lastTexts(requests[2]!)).toEqual([changedOnDiskNote('a.ts', USER_EXCERPT)]);
    expect(readFileSync(path.join(workspace, 'a.ts'), 'utf8')).toBe(USER_A);
    expect(kinds(events)).toEqual(['user', 'assistant', 'tool-result', 'assistant', 'tool-result', 'file-changed', 'assistant']);
  });

  it("gives no note for Geno's edit into an unsaved buffer, nor when the user then saves that buffer", async () => {
    let workspace = '';
    let buffers = new Map<string, string>();
    const unsaved = 'export const a = 1; // unsaved\n';
    const { requests, events } = await serve(
      { 'a.ts': A, 'b.ts': 'export const b = 2;\n' },
      (n) => {
        if (n === 0) return toolCall('', [use('tu_a', 'read', { path: 'a.ts' })], usage);
        if (n === 1) return toolCall('', [use('tu_e', 'edit', { path: 'a.ts', old_str: 'a = 1', new_str: 'a = 10' })], usage);
        if (n === 2) {
          // The user saves the buffer Geno edited.
          const file = path.join(workspace, 'a.ts');
          writeFileSync(file, buffers.get(file)!);
          return toolCall('', [use('tu_b', 'read', { path: 'b.ts' })], usage);
        }
        return answer('Done.', usage);
      },
      (ws, editor) => {
        workspace = ws;
        buffers = editor;
        editor.set(path.join(ws, 'a.ts'), unsaved);
      },
    );

    expect(requests).toHaveLength(4);
    expect(requests.flatMap(lastTexts).join('\n')).not.toContain('changed on disk');
    expect(readFileSync(path.join(workspace, 'a.ts'), 'utf8')).toBe('export const a = 10; // unsaved\n');
    expect(kinds(events)).not.toContain('file-changed');
  });
});
