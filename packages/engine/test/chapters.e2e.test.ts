import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  CHAPTER_CAPABILITY,
  CHAPTER_MARK_METHOD,
  CHAPTER_META,
  CHAPTER_NOTE,
  chaptersOf,
  REPLAYED_TURN_META,
  REWIND_TURN_METHOD,
  TURN_SEQ_META,
  type ChapterMarkResponse,
} from '@g-code/core';
import type { Io } from '../src/command.js';
import { mcpSessions } from '../src/mcp/sessions.js';
import { engineShared, gcodeAgent } from '../src/serve.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, loadTools, offeredTools, toolCall, type FakeToolUse } from './fake-transport.js';
import { rgCommand } from './helpers.js';

vi.setConfig({ testTimeout: 30_000 });

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const mark = (id: string, title: string, summary?: string): FakeToolUse => ({ id, name: 'mark_chapter', input: { title, ...(summary === undefined ? {} : { summary }) } });

const resultOf = (updates: readonly acp.SessionNotification[], toolCallId: string) =>
  updates.flatMap(({ update }) => (update.sessionUpdate === 'tool_call_update' && update.toolCallId === toolCallId && update.status !== undefined && update.content != null ? [update] : [])).at(-1);
const textOf = (update: acp.SessionUpdate | undefined): string =>
  update?.sessionUpdate === 'tool_call_update' ? (update.content ?? []).flatMap((c) => (c.type === 'content' && c.content.type === 'text' ? [c.content.text] : [])).join('') : '';
const promptsOf = (updates: readonly acp.SessionNotification[]) => updates.flatMap(({ update }) => (update.sessionUpdate === 'user_message_chunk' && update._meta?.[REPLAYED_TURN_META] !== undefined ? [update] : []));
/** The chapters a replay draws, in order: a call's divider, or a mark on a message. */
const replayedChapters = (updates: readonly acp.SessionNotification[]): string[] =>
  updates.flatMap(({ update }) => {
    const meta = update._meta?.[CHAPTER_META] as { title: string } | undefined;
    if (meta === undefined) return [];
    return [update.sessionUpdate === 'tool_call_update' ? `call ${update.toolCallId}: ${meta.title}` : `message: ${meta.title}`];
  });

describe('gcode serve: chapters', () => {
  it('lets the model mark chapters without asking, in Plan too, takes the user\'s mark on a message, and replays and rewinds them', async () => {
    const repo = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-chapters-')));
    await writeFile(path.join(repo, 'date.ts'), 'export const parseDate = (s: string) => new Date(s);\n');
    const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
    const env = { GCODE_HOME: home, HOME: home, GCODE_PROVIDER: 'modelstudio', DASHSCOPE_API_KEY: 'sk-fake', DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic', GCODE_RG: rgCommand(), PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
    const model = fakeTransport([
      toolCall('Reading the parser.', [loadTools('mark_chapter'), { id: 'tu_read', name: 'read', input: { path: 'date.ts' } }], usage),
      toolCall('Explored; planning the fix now.', [mark('tu_ch1', 'Parser fix', 'Plan the off-by-one fix in parseDate.')], usage),
      answer('The plan: guard the month index.', usage),
      toolCall('Same phase still.', [mark('tu_again', 'parser FIX')], usage),
      toolCall('Fixed; verifying.', [mark('tu_ch2', 'Test verification')], usage),
      answer('Verified.', usage),
      answer('Changelog written.', usage),
      answer('No chapters here.', usage),
    ]);
    const io: Io = { env, cwd: repo, out: () => {}, err: () => {}, write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch: model.fetch };
    const store = openStore(env);
    const updates: acp.SessionNotification[] = [];
    let asked = 0;
    const window = acp
      .client({ name: 'test-window' })
      .onRequest(acp.methods.client.fs.readTextFile, ({ params }) => ({ content: readFileSync(params.path, 'utf8') }))
      .onRequest(acp.methods.client.fs.writeTextFile, ({ params }) => {
        writeFileSync(params.path, params.content);
        return {};
      })
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
        asked++;
        return { outcome: { outcome: 'selected', optionId: params.options[0]!.optionId } };
      })
      .onNotification(acp.methods.client.session.update, ({ params }) => void updates.push(params));
    const open = async (meta: Record<string, unknown>, shared = engineShared(io)) => {
      const connection = window.connect(gcodeAgent(io, store, { maxTurns: 10, maxCostUsd: 1 }, mcpSessions(store, env), shared));
      await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, _meta: meta },
      });
      return connection.agent;
    };
    const prompt = async (agent: acp.AgentContext, sessionId: string, text: string): Promise<number> => {
      const response = await agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
      return (response as acp.PromptResponse)._meta?.[TURN_SEQ_META] as number;
    };
    const log = async (id: string) => (await readSessionLog(sessionFile(store, id as never))).events;

    const agent = await open({ [CHAPTER_CAPABILITY]: true });
    const { sessionId: chat } = await agent.request(acp.methods.agent.session.new, { cwd: repo, mcpServers: [] });
    await agent.request(acp.methods.agent.session.setMode, { sessionId: chat, modeId: 'plan' });
    const first = await prompt(agent, chat, 'plan the parser fix');
    const tools = model.requests[0]!.body.tools.map((tool: { name: string }) => tool.name);
    expect(offeredTools(model.requests[0]!.body), 'Plan offers mark_chapter').toContain('mark_chapter');
    expect(tools, 'deferred, by name in tool_search').not.toContain('mark_chapter');
    expect(model.requests.every((request) => JSON.stringify(request.body.system).includes(CHAPTER_NOTE)), 'every call says when to mark one').toBe(true);
    expect(resultOf(updates, 'tu_ch1')).toMatchObject({ status: 'completed', _meta: { [CHAPTER_META]: { title: 'Parser fix', summary: 'Plan the off-by-one fix in parseDate.' } } });
    expect(textOf(resultOf(updates, 'tu_ch1'))).toBe('Chapter "Parser fix" starts here. The user sees it as a divider and in the chapter list. Go on with the work, and mark the next chapter only when the work moves to another phase.');
    expect(asked, 'no chapter asks for approval, in Plan too').toBe(0);

    await agent.request(acp.methods.agent.session.setMode, { sessionId: chat, modeId: 'ask' });
    const second = await prompt(agent, chat, 'fix it and run the tests');
    expect(resultOf(updates, 'tu_again'), 'the chapter the session is in is refused').toMatchObject({ status: 'failed' });
    expect(textOf(resultOf(updates, 'tu_again'))).toContain('"Parser fix" is already the current chapter');
    expect(resultOf(updates, 'tu_again')?._meta?.[CHAPTER_META]).toBeUndefined();
    expect(resultOf(updates, 'tu_ch2')?._meta?.[CHAPTER_META]).toEqual({ title: 'Test verification' });
    const third = await prompt(agent, chat, 'write the changelog');

    const marked = await agent.request<ChapterMarkResponse>(CHAPTER_MARK_METHOD, { sessionId: chat, turnSeq: first, mark: { title: '  Exploration ' } });
    expect(marked.mark).toEqual({ title: 'Exploration' });
    await agent.request(CHAPTER_MARK_METHOD, { sessionId: chat, turnSeq: third, mark: { title: 'Release notes' } });
    await expect(agent.request(CHAPTER_MARK_METHOD, { sessionId: chat, turnSeq: first + 1, mark: { title: 'Nope' } }), 'a seq that starts no turn is refused').rejects.toThrow(`no message of the user's starts a turn at ${first + 1}`);
    await expect(agent.request(CHAPTER_MARK_METHOD, { sessionId: chat, turnSeq: first, mark: { title: 'x'.repeat(41) } })).rejects.toThrow('title is 41 characters; keep it to 40');
    expect(chaptersOf(await log(chat)).map((chapter) => chapter.title)).toEqual(['Exploration', 'Parser fix', 'Test verification', 'Release notes']);
    expect(model.requests.length, 'a mark by the user reaches no model').toBe(7);

    const seen = updates.length;
    const later = await open({ [CHAPTER_CAPABILITY]: true });
    await later.request(acp.methods.agent.session.load, { sessionId: chat, cwd: repo, mcpServers: [] });
    const replay = updates.slice(seen);
    expect(replayedChapters(replay), 'a fresh engine replays every chapter where it was marked').toEqual(['message: Exploration', 'call tu_ch1: Parser fix', 'call tu_ch2: Test verification', 'message: Release notes']);
    expect(replay.find(({ update }) => update.sessionUpdate === 'tool_call' && update.toolCallId === 'tu_ch1')?.update).toMatchObject({ title: 'mark_chapter Parser fix' });
    const events = await log(chat);
    const answered = events.findLast((e) => e.kind === 'assistant');
    expect((promptsOf(replay)[2]?._meta?.[REPLAYED_TURN_META] as { endedAt: number }).endedAt, 'the last turn ends at its answer, not at the marks logged after it').toBe(Date.parse(answered!.at));

    await later.request(REWIND_TURN_METHOD, { sessionId: chat, turnSeq: second, choice: { kind: 'conversation' } });
    const rewound = updates.length;
    await later.request(acp.methods.agent.session.load, { sessionId: chat, cwd: repo, mcpServers: [] });
    expect(replayedChapters(updates.slice(rewound)), 'a rewind to before a chapter removes it, and keeps the ones before').toEqual(['message: Exploration', 'call tu_ch1: Parser fix']);

    await later.request(CHAPTER_MARK_METHOD, { sessionId: chat, turnSeq: first, mark: null });
    expect(chaptersOf(await log(chat)).map((chapter) => chapter.title), 'the user removes their own mark').toEqual(['Parser fix']);

    const plain = await open({});
    const { sessionId: other } = await plain.request(acp.methods.agent.session.new, { cwd: repo, mcpServers: [] });
    await prompt(plain, other, 'hello');
    expect(offeredTools(model.requests.at(-1)!.body), 'a client that draws no chapters gets no mark_chapter').not.toContain('mark_chapter');
    expect(JSON.stringify(model.requests.at(-1)!.body.system)).not.toContain(CHAPTER_NOTE);
  });
});
