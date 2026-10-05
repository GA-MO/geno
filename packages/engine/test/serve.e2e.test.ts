import { readFileSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import {
  BASE_HASH_META,
  DIAGNOSTICS_CAPABILITY,
  DIAGNOSTICS_METHOD,
  hashText,
  STALE_BASE_ERROR,
  type DiagnosticsResponse,
} from '@g-code/core';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, toolCall, type FakeToolUse, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand } from './helpers.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const DISK = 'export const a = 1;\n';
const BUFFER = 'export const a = 1;\nexport const unsaved = true;\n';

let nextId = 0;
const use = (name: string, input: unknown): FakeToolUse => ({ id: `tu_${nextId++}`, name, input });

type Editor = {
  /** Open buffers by absolute path; a path that is absent reads from disk. */
  readonly buffers: Map<string, string>;
  readonly writes: acp.WriteTextFileRequest[];
  readonly updates: acp.SessionUpdate[];
  readonly permissions: acp.RequestPermissionRequest[];
  readonly diagnosticRequests: unknown[];
  /** Runs on each fs/read_text_file, after the read is answered. */
  afterRead?: ((path: string) => void) | undefined;
  answerPermission: acp.RequestPermissionOutcome;
  rejectWrites?: boolean;
};

async function setup(replies: readonly Reply[]) {
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': DISK } }]));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const env = {
    GCODE_HOME: home,
    GCODE_PROVIDER: 'modelstudio',
    DASHSCOPE_API_KEY: 'sk-fake',
    DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
    GCODE_RG: rgCommand(),
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  };
  const transport = fakeTransport(replies);
  const stderr: string[] = [];
  const io: Io = {
    env,
    cwd: workspace,
    out: (line) => stderr.push(line),
    err: (line) => stderr.push(line),
    write: () => {},
    interrupts: () => new AbortController().signal,
    confirm: async () => false,
    fetch: transport.fetch,
  };
  const file = path.join(workspace, 'a.ts');
  const editor: Editor = {
    buffers: new Map([[file, BUFFER]]),
    writes: [],
    updates: [],
    permissions: [],
    diagnosticRequests: [],
    answerPermission: { outcome: 'selected', optionId: 'reject' },
  };
  const client = acp
    .client({ name: 'test-editor' })
    .onRequest(acp.methods.client.fs.readTextFile, ({ params }) => {
      const content = editor.buffers.get(params.path) ?? readFileSync(params.path, 'utf8');
      queueMicrotask(() => editor.afterRead?.(params.path));
      return { content };
    })
    .onRequest(acp.methods.client.fs.writeTextFile, ({ params }) => {
      editor.writes.push(params);
      const current = editor.buffers.get(params.path) ?? null;
      if (editor.rejectWrites || hashText(current) !== params._meta?.[BASE_HASH_META]) {
        throw new acp.RequestError(STALE_BASE_ERROR.code, 'stale', { reason: STALE_BASE_ERROR.reason });
      }
      editor.buffers.set(params.path, params.content);
      return {};
    })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      editor.permissions.push(params);
      return { outcome: editor.answerPermission };
    })
    .onRequest(DIAGNOSTICS_METHOD, (raw) => raw, ({ params }): DiagnosticsResponse => {
      editor.diagnosticRequests.push(params);
      return { diagnostics: [{ path: file, line: 2, character: 14, severity: 'error', message: "Cannot find name 'nope'.", source: 'ts' }] };
    })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      editor.updates.push(params.update);
    });
  const agentApp = gcodeAgent(io, openStore(env), { maxTurns: 10, maxCostUsd: 1 });

  /** Starts a session, sends one prompt, and returns its stop reason. `during` runs while the turn is in flight. */
  const prompt = (text: string, during?: (ctx: acp.ClientContext, sessionId: string) => Promise<void>) =>
    client.connectWith(agentApp, async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, _meta: { [DIAGNOSTICS_CAPABILITY]: true } },
      });
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
      const turn = ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
      await during?.(ctx, sessionId);
      return (await turn).stopReason;
    });
  return { workspace, file, editor, transport, prompt, stderr };
}

const toolResultOf = (body: { messages: { content: unknown }[] }, index = -1): { content: string; is_error?: boolean } => {
  const content = body.messages.at(index)!.content as { type: string; content: string; is_error?: boolean }[];
  return content.find((block) => block.type === 'tool_result')!;
};

describe('gcode serve', () => {
  it('reads the unsaved buffer, writes the edit through the editor, and streams the turn as session updates', async () => {
    const read = use('read', { path: 'a.ts' });
    const edit = use('edit', { path: 'a.ts', old_str: 'unsaved = true', new_str: 'unsaved = false' });
    const { file, editor, transport, prompt } = await setup([
      toolCall('Reading.', [read], usage),
      toolCall('Editing.', [edit], usage),
      answer('Done.', usage),
    ]);

    expect(await prompt('Flip the flag')).toBe('end_turn');

    expect(toolResultOf(transport.requests[1]!.body).content).toContain('export const unsaved = true;');
    expect(editor.writes).toEqual([
      expect.objectContaining({ path: file, content: 'export const a = 1;\nexport const unsaved = false;\n', _meta: { [BASE_HASH_META]: hashText(BUFFER) } }),
    ]);
    expect(readFileSync(file, 'utf8')).toBe(DISK);
    expect(editor.updates).toContainEqual({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reading.' } });
    expect(editor.updates).toContainEqual(
      expect.objectContaining({ sessionUpdate: 'tool_call', toolCallId: edit.id, title: 'edit a.ts', kind: 'edit', status: 'in_progress' }),
    );
    expect(editor.updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'tool_call_update', toolCallId: edit.id, status: 'completed' }));
  });

  it('fails the edit as stale-base when the buffer changes between the read and the edit', async () => {
    const { file, editor, transport, prompt } = await setup([
      toolCall('Reading.', [use('read', { path: 'a.ts' })], usage),
      toolCall('Editing.', [use('edit', { path: 'a.ts', old_str: 'unsaved = true', new_str: 'unsaved = false' })], usage),
      answer('I will read it again.', usage),
    ]);
    editor.afterRead = (p) => {
      editor.buffers.set(p, `${BUFFER}// typed meanwhile\n`);
      editor.afterRead = undefined;
    };

    expect(await prompt('Flip the flag')).toBe('end_turn');

    const result = toolResultOf(transport.requests[2]!.body);
    expect(result).toMatchObject({ is_error: true, content: 'a.ts changed since it was last read; read it again before editing' });
    expect(editor.writes).toEqual([]);
    expect(editor.buffers.get(file)).toBe(`${BUFFER}// typed meanwhile\n`);
  });

  it('fails the edit as stale-base when the editor refuses the write because the buffer moved on', async () => {
    const { editor, transport, prompt } = await setup([
      toolCall('Reading.', [use('read', { path: 'a.ts' })], usage),
      toolCall('Editing.', [use('edit', { path: 'a.ts', old_str: 'unsaved = true', new_str: 'unsaved = false' })], usage),
      answer('I will read it again.', usage),
    ]);
    editor.rejectWrites = true;

    expect(await prompt('Flip the flag')).toBe('end_turn');

    expect(editor.writes).toHaveLength(1);
    expect(toolResultOf(transport.requests[2]!.body)).toMatchObject({
      is_error: true,
      content: 'a.ts changed since it was last read; read it again before editing',
    });
  });

  it('asks the editor before a denied command, on the tool call that needs it, and refuses on reject', async () => {
    const push = use('bash', { command: 'git push origin main' });
    const { editor, transport, prompt } = await setup([toolCall('Pushing.', [push], usage), answer('Not pushed.', usage)]);

    expect(await prompt('Push it')).toBe('end_turn');

    expect(editor.permissions).toEqual([
      expect.objectContaining({ toolCall: expect.objectContaining({ toolCallId: push.id, kind: 'execute' }), options: expect.any(Array) }),
    ]);
    expect(toolResultOf(transport.requests[1]!.body)).toMatchObject({ is_error: true });
    expect(toolResultOf(transport.requests[1]!.body).content).toMatch(/^denied: `git push origin main`/);
    expect(editor.updates).toContainEqual(expect.objectContaining({ sessionUpdate: 'tool_call_update', toolCallId: push.id, status: 'failed' }));
  });

  it('answers check with the editor diagnostics for the files the model read when there is no check command', async () => {
    const { file, editor, transport, prompt } = await setup([
      toolCall('Reading.', [use('read', { path: 'a.ts' })], usage),
      toolCall('Checking.', [use('check', {})], usage),
      answer('Found one.', usage),
    ]);

    expect(await prompt('Any problems?')).toBe('end_turn');

    expect(editor.diagnosticRequests).toEqual([expect.objectContaining({ paths: [file] })]);
    expect(toolResultOf(transport.requests[2]!.body).content).toBe(
      "The editor reports these problems in the files you read or edited:\na.ts:2:14 error: Cannot find name 'nope'. (ts)",
    );
  });

  it('stops the turn as cancelled on session/cancel', async () => {
    const { transport, prompt } = await setup([{ ...answer('Thinking for a long time', usage), stallAfter: 7 }]);

    const stop = await prompt('Take your time', async (ctx, sessionId) => {
      while (transport.requests.length === 0) await new Promise((r) => setTimeout(r, 5));
      await ctx.notify(acp.methods.agent.session.cancel, { sessionId });
    });

    expect(stop).toBe('cancelled');
  });
});
