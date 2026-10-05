import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import {
  BASE_HASH_META,
  changeOf,
  CHECKPOINT_TEXT_METHOD,
  DIAGNOSTICS_CAPABILITY,
  DIAGNOSTICS_METHOD,
  hashText,
  hunkIdOf,
  INLINE_EDIT_META,
  REVIEW_METHOD,
  REWIND_METHOD,
  STALE_BASE_ERROR,
  type CheckpointTextRequest,
  type CheckpointTextResponse,
  type DiagnosticsResponse,
  type ReviewDecision,
  type ReviewRequest,
  type ReviewResponse,
  type RewindRequest,
  type RewindResponse,
} from '@g-code/core';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, toolCall, type FakeToolUse, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand } from './helpers.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

function diskText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
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
      const buffered = editor.buffers.has(params.path);
      const current = buffered ? editor.buffers.get(params.path)! : diskText(params.path);
      if (editor.rejectWrites || hashText(current) !== params._meta?.[BASE_HASH_META]) {
        throw new acp.RequestError(STALE_BASE_ERROR.code, 'stale', { reason: STALE_BASE_ERROR.reason });
      }
      if (buffered) editor.buffers.set(params.path, params.content);
      else writeFileSync(params.path, params.content);
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
  /** Connects a fresh engine, starts a session, or resumes `resume`, and runs `work` on it. */
  const connect = <T>(work: (ctx: acp.ClientContext, sessionId: string) => Promise<T>, resume?: string) =>
    client.connectWith(gcodeAgent(io, openStore(env), { maxTurns: 10, maxCostUsd: 1 }), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, _meta: { [DIAGNOSTICS_CAPABILITY]: true } },
      });
      if (resume !== undefined) {
        await ctx.request(acp.methods.agent.session.resume, { sessionId: resume, cwd: workspace });
        return work(ctx, resume);
      }
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
      return work(ctx, sessionId);
    });

  /** Starts a session, sends one prompt, and returns its stop reason. `during` runs while the turn is in flight. */
  const prompt = (text: string, during?: (ctx: acp.ClientContext, sessionId: string) => Promise<void>) =>
    connect(async (ctx, sessionId) => {
      const turn = ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
      await during?.(ctx, sessionId);
      return (await turn).stopReason;
    });
  return { workspace, file, editor, transport, prompt, connect, stderr };
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

  it('asks the editor before rm -rf inside the workspace, with the question as the title', async () => {
    const remove = use('bash', { command: 'rm -rf src' });
    const { editor, prompt } = await setup([toolCall('Removing.', [remove], usage), answer('Kept it.', usage)]);

    expect(await prompt('Remove src')).toBe('end_turn');

    expect(editor.permissions).toEqual([
      expect.objectContaining({
        toolCall: expect.objectContaining({ toolCallId: remove.id, title: 'Allow `rm -rf src`? It uses rm -rf of a path inside the workspace.' }),
      }),
    ]);
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

  it('logs the hunks an edit made, keeps review decisions across engines, serves the checkpoint text, and rewinds', async () => {
    const { file, editor, connect } = await setup([
      toolCall('Reading.', [use('read', { path: 'a.ts' })], usage),
      toolCall('Editing.', [use('edit', { path: 'a.ts', old_str: 'a = 1', new_str: 'a = 2' })], usage),
      answer('Done.', usage),
    ]);
    editor.buffers.delete(file);
    const edited = 'export const a = 2;\n';
    const [hunk] = [hunkIdOf(changeOf(file, DISK, edited), 0)];
    const review = (ctx: acp.ClientContext, sessionId: string, decisions: ReviewDecision[] = []) =>
      ctx.request<ReviewResponse, ReviewRequest>(REVIEW_METHOD, { sessionId, decisions });

    const sessionId = await connect(async (ctx, sessionId) => {
      await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: 'Set a to 2' }] });
      expect(readFileSync(file, 'utf8')).toBe(edited);
      expect((await review(ctx, sessionId)).hunks).toEqual([
        { id: hunk, path: file, startLine: 1, lineCount: 1, oldText: DISK, newText: edited, status: 'pending', afterLine: 1 },
      ]);
      expect((await review(ctx, sessionId, [{ hunk: hunk!, status: 'kept' }])).hunks).toMatchObject([{ id: hunk, status: 'kept' }]);
      const checkpoint = await ctx.request<CheckpointTextResponse, CheckpointTextRequest>(CHECKPOINT_TEXT_METHOD, { sessionId, path: file });
      expect(checkpoint).toEqual({ text: DISK });
      return sessionId;
    });

    await connect(async (ctx) => {
      expect((await review(ctx, sessionId)).hunks).toMatchObject([{ id: hunk, status: 'kept' }]);
      expect(await ctx.request<RewindResponse, RewindRequest>(REWIND_METHOD, { sessionId })).toEqual({ files: [file] });
      expect(readFileSync(file, 'utf8')).toBe(DISK);
      expect((await review(ctx, sessionId)).hunks).toMatchObject([{ id: hunk, status: 'undone' }]);
    }, sessionId);
  });

  it('runs an inline edit of a selection as one edit call with the file and its problems in the prompt', async () => {
    const { file, editor, transport, connect } = await setup([
      toolCall('Editing.', [use('edit', { path: 'a.ts', old_str: 'unsaved = true', new_str: 'unsaved = false' })], usage),
      answer('Done.', usage),
    ]);

    const { stop, hunks } = await connect(async (ctx, sessionId) => {
      const { stopReason } = await ctx.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: 'Flip the flag' }],
        _meta: { [INLINE_EDIT_META]: { path: file, startLine: 2, endLine: 2 } },
      });
      return { stop: stopReason, hunks: (await ctx.request<ReviewResponse, ReviewRequest>(REVIEW_METHOD, { sessionId, decisions: [] })).hunks };
    });

    expect(stop).toBe('end_turn');
    const first = transport.requests[0]!.body;
    expect(first.tools.map((tool: { name: string }) => tool.name)).toEqual(['edit']);
    expect(JSON.stringify(first.system)).toContain("You are g-code's edit applier.");
    const message = JSON.stringify(first.messages[0].content);
    expect(message).toContain('Change line 2 of a.ts');
    expect(message).toContain('Flip the flag');
    expect(message).toContain('2\\texport const unsaved = true;');
    expect(message).toContain("a.ts:2:14 error: Cannot find name 'nope'.");
    expect(editor.diagnosticRequests).toEqual([expect.objectContaining({ paths: [file] })]);
    expect(editor.buffers.get(file)).toBe('export const a = 1;\nexport const unsaved = false;\n');
    expect(hunks).toMatchObject([{ path: file, startLine: 2, oldText: 'export const unsaved = true;\n', newText: 'export const unsaved = false;\n', status: 'pending' }]);
  });
});
