import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import { COMPACT_META, REPLAYED_TURN_META, REWIND_TURN_METHOD, summarizeSession, SUMMARY_SYSTEM, type CompactMark, type ReplayedTurn, type TurnEvent } from '@g-code/core';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore, type Store } from '../src/store.js';
import { answer, fakeTransport, httpError, toolCall, type RecordedRequest, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand } from './helpers.js';

vi.setConfig({ testTimeout: 30_000 });

const small = { input: 2_000, cacheRead: 0, cacheWrite: 0 };
// GCODE_COMPACT_AT sets the threshold at 8,000 tokens, so a test's few kilobytes of files fill the context.
const COMPACT_AT = '8000';
const under = { input: 7_000, cacheRead: 0, cacheWrite: 0 };
const over = { input: 8_200, cacheRead: 0, cacheWrite: 0 };
// About 6,000 tokens, which a compaction can take out of the context.
const bigFile = ['export const PARSER_MARKER = 1;', ...Array.from({ length: 300 }, (_, i) => `export const line${i} = 'a line the parser keeps as it is, number ${i}';`)].join('\n');
const read = (id: string, file: string) => ({ id, name: 'read', input: { path: file } });
const tooLong = httpError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 1048576 tokens > 1000000 maximum' } });

type Connection = { readonly ctx: acp.ClientContext; readonly updates: acp.SessionNotification[] };

function connect<T>(io: Io, store: Store, run: (connection: Connection) => Promise<T>): Promise<T> {
  const updates: acp.SessionNotification[] = [];
  const client = acp
    .client({ name: 'test-editor' })
    .onRequest(acp.methods.client.fs.readTextFile, async ({ params }) => ({ content: readFileSync(params.path, 'utf8') }))
    .onRequest(acp.methods.client.fs.writeTextFile, async ({ params }) => {
      writeFileSync(params.path, params.content);
      return {};
    })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => ({ outcome: { outcome: 'selected', optionId: params.options[0]!.optionId } }))
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params);
    });
  return client.connectWith(gcodeAgent(io, store, { maxTurns: 10, maxCostUsd: 1 }), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
    return run({ ctx, updates });
  });
}

async function setup(replies: readonly Reply[], extra: Readonly<Record<string, string>> = {}) {
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': `${bigFile}\n`, 'b.ts': 'export const b = 2;\n' } }]));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const env = {
    GCODE_HOME: home,
    HOME: home,
    GCODE_PROVIDER: 'modelstudio',
    DASHSCOPE_API_KEY: 'sk-fake',
    DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
    GCODE_RG: rgCommand(),
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    ...extra,
  };
  const store = openStore(env);
  const model = fakeTransport(replies);
  const errors: string[] = [];
  const io: Io = { env, cwd: workspace, out: () => {}, err: (line) => errors.push(line), write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch: model.fetch };
  const log = async (id: string): Promise<readonly TurnEvent[]> => (await readSessionLog(sessionFile(store, id as never))).events;
  return { workspace, store, model, io, log, errors };
}

const prompt = (ctx: acp.ClientContext, sessionId: string, text: string) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
const sent = (request: RecordedRequest): string => JSON.stringify(request.body.messages);
const marks = (updates: readonly acp.SessionNotification[]): CompactMark[] =>
  updates.flatMap(({ update }) => (update.sessionUpdate === 'agent_message_chunk' && update._meta?.[COMPACT_META] !== undefined ? [update._meta[COMPACT_META] as CompactMark] : []));
const compactions = (events: readonly TurnEvent[]) => events.filter((e): e is Extract<TurnEvent, { kind: 'compact' }> => e.kind === 'compact');

describe('gcode serve: context compaction', () => {
  it('compacts on its own past the threshold, keeps the turn going, and rebuilds the context after a reload', async () => {
    const { workspace, store, model, io, log } = await setup([
      toolCall('Reading.', [read('r1', 'a.ts')], small),
      answer('Read it.', under),
      toolCall('Checking b.', [read('r2', 'b.ts')], over),
      answer('## Goal\nFix the parser.\n## Progress\nRead a.ts.\n## Decisions\nNone yet.\n## Next steps\nFix it.', small),
      answer('Fixed.', small),
      answer('You are welcome.', small),
      answer('## Goal\nSECOND SUMMARY\n## Progress\n## Decisions\n## Next steps', small),
      answer('Going on.', small),
      answer('Redone.', small),
    ], { GCODE_COMPACT_AT: COMPACT_AT });

    const { sessionId, fixTurn } = await connect(io, store, async ({ ctx, updates }) => {
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
      await prompt(ctx, sessionId, 'Read a.ts');
      const fix = await prompt(ctx, sessionId, 'Now fix it');
      expect(fix.stopReason).toBe('end_turn');

      const summaryCall = model.requests[3]!.body;
      expect(summaryCall.system[0].text, 'the summary call has its own system prompt').toBe(SUMMARY_SYSTEM);
      expect(summaryCall.tools, 'and no tools, so it can only summarize').toBeUndefined();
      expect(summaryCall.model, "on the session's own model").toBe('qwen3.8-flash');
      expect(sent(model.requests[3]!)).toContain('PARSER_MARKER');

      const after = sent(model.requests[4]!);
      expect(after, 'the turn goes on from the summary').toContain('<compacted_context>');
      expect(after).toContain('Fix the parser.');
      expect(after, 'the summarized read is gone from the context').not.toContain('PARSER_MARKER');
      expect(after, 'the recent turns stay verbatim').toContain('Checking b.');

      const [mark] = marks(updates);
      expect(mark).toMatchObject({ trigger: 'auto', tokensBefore: expect.any(Number), summary: expect.stringContaining('## Goal') });
      expect(mark!.tokensBefore).toBeGreaterThanOrEqual(8_200);
      expect(mark!.tokensAfter).toBeLessThan(Number(COMPACT_AT));
      const used = updates.flatMap(({ update }) => (update.sessionUpdate === 'usage_update' ? [update.used] : []));
      expect(used, 'the ring drops to the estimate once compacted').toContain(mark!.tokensAfter);
      return { sessionId, fixTurn: fix._meta?.['gcode/turnSeq'] as number };
    });

    const events = await log(sessionId);
    const [compact] = compactions(events);
    expect(compact).toMatchObject({ trigger: 'auto', keptFrom: expect.any(Number) });
    expect(events.filter((e) => e.kind === 'error'), 'nothing failed').toEqual([]);
    const head = events[0]!;
    expect(head.kind === 'session-start' && summarizeSession(head.session, events).costUsd, "the summary call's cost counts").toBeCloseTo(
      events.reduce((sum, e) => sum + (e.kind === 'assistant' || e.kind === 'compact' ? (e.costUsd ?? 0) : 0), 0),
    );
    expect(compact!.costUsd).toBeGreaterThan(0);

    await connect(io, store, async ({ ctx, updates }) => {
      await ctx.request(acp.methods.agent.session.load, { sessionId, cwd: workspace, mcpServers: [] });
      expect(marks(updates).map((m) => m.seq), 'a reload draws the divider again').toEqual([compact!.seq]);

      await prompt(ctx, sessionId, 'thanks');
      const resumed = sent(model.requests[5]!);
      expect(resumed, 'a resumed session sends the compacted context').toContain('<compacted_context>');
      expect(resumed).not.toContain('PARSER_MARKER');

      updates.length = 0;
      const manual = await prompt(ctx, sessionId, '/compact keep the parser notes');
      expect(manual.stopReason).toBe('end_turn');
      expect(manual.usage?.outputTokens, "the /compact turn reports its summary call's usage").toBe(42);
      const second = sent(model.requests[6]!);
      expect(second).toContain('The user asked the summary to focus on: keep the parser notes');
      expect(second, 'the second summary reads the first').toContain('Fix the parser.');
      expect(marks(updates)).toMatchObject([{ trigger: 'manual', focus: 'keep the parser notes' }]);

      await prompt(ctx, sessionId, 'go on');
      const next = sent(model.requests[7]!);
      expect(next).toContain('SECOND SUMMARY');
      expect(next, 'the second compaction replaces the first').not.toContain('Fix the parser.');

      updates.length = 0;
      await ctx.request(acp.methods.agent.session.load, { sessionId, cwd: workspace, mcpServers: [] });
      const turns = updates.flatMap(({ update }) =>
        update.sessionUpdate === 'user_message_chunk' && update.content.type === 'text' && update._meta?.[REPLAYED_TURN_META] !== undefined
          ? [{ text: update.content.text, turn: update._meta[REPLAYED_TURN_META] as ReplayedTurn }]
          : [],
      );
      const compactTurn = turns.find((t) => t.text === '/compact keep the parser notes');
      expect(compactTurn?.turn, 'the replay shows /compact as its own turn, with no prompt to rewind to').toMatchObject({ command: { name: 'compact', args: 'keep the parser notes' } });
      expect(compactTurn?.turn.seq).toBeUndefined();
      expect(marks(updates).map((m) => m.trigger)).toEqual(['auto', 'manual']);

      await ctx.request(REWIND_TURN_METHOD, { sessionId, turnSeq: fixTurn, choice: { kind: 'conversation' } });
      await prompt(ctx, sessionId, 'redo it');
      const redone = sent(model.requests[8]!);
      expect(redone, 'a rewind to before the compactions rebuilds from the whole log').toContain('PARSER_MARKER');
      expect(redone).not.toContain('<compacted_context>');
    });
    expect(model.requests).toHaveLength(9);
    expect(compactions(await readSessionLog(sessionFile(store, sessionId as never)).then((l) => l.events)), 'the cut view drops the compactions').toEqual([]);
    const written = readFileSync(sessionFile(store, sessionId as never), 'utf8');
    expect(written.split('\n').filter((line) => line.includes('"kind":"compact"')), 'the log keeps every compaction').toHaveLength(2);
  });

  it('compacts once and retries once when the provider refuses a request as too long', async () => {
    const { workspace, store, model, io, log } = await setup([
      answer('First.', small),
      tooLong,
      answer('## Goal\nAnswer the user.\n## Progress\n## Decisions\n## Next steps', small),
      answer('Second, after compacting.', small),
      answer('More.', small),
      tooLong,
      answer('## Goal\nStill too long.\n## Progress\n## Decisions\n## Next steps', small),
      tooLong,
    ]);
    await connect(io, store, async ({ ctx }) => {
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
      await prompt(ctx, sessionId, 'first');
      await prompt(ctx, sessionId, 'second');
      expect(sent(model.requests[3]!), 'the retry carries the compacted context').toContain('<compacted_context>');
      let events = await log(sessionId);
      expect(compactions(events).map((c) => c.trigger)).toEqual(['overflow']);
      expect(events.filter((e) => e.kind === 'error'), 'a retry that worked logs no failure').toEqual([]);

      await prompt(ctx, sessionId, 'more');
      const third = await prompt(ctx, sessionId, 'third');
      expect(third.stopReason).toBe('end_turn');
      events = await log(sessionId);
      expect(compactions(events)).toHaveLength(2);
      expect(events.at(-1), 'a second refusal is not retried again').toMatchObject({ kind: 'error', error: 'overflow' });
    });
    expect(model.requests).toHaveLength(8);
  });

  it('logs the overflow when there is nothing to compact, and /compact says so without a model call', async () => {
    const { workspace, store, model, io, log } = await setup([tooLong]);
    await connect(io, store, async ({ ctx, updates }) => {
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
      await prompt(ctx, sessionId, 'one huge prompt');
      expect((await log(sessionId)).at(-1)).toMatchObject({ kind: 'error', error: 'overflow' });
      updates.length = 0;
      await prompt(ctx, sessionId, '/compact');
      const text = updates.flatMap(({ update }) => (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : [])).join('');
      expect(text).toContain('Nothing to compact yet');
    });
    expect(model.requests).toHaveLength(1);
  });
});
