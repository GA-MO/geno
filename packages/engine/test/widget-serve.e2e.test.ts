import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { asSessionId, WIDGET_CAPABILITY, WIDGET_DRAFT_META, WIDGET_META, type TurnEvent } from '@g-code/core';
import { runAgent } from '../src/agent.js';
import { startSession } from '../src/chat.js';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, loadTools, offeredTools, toolCall, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

const HTML = '<style>.bar{width:100%;background:var(--chart-1)}</style><div class="bar">Speed</div><script>document.querySelector(".bar").title = "hi";</script>';
const INPUT = { title: 'Where a run spends its time', loading_messages: ['Laying out the bars', 'Adding the labels'], html: HTML };
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

async function setup(replies: readonly Reply[], capable = true) {
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'export const a = 1;\n' } }]));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const env = { GCODE_HOME: home, GCODE_PROVIDER: 'modelstudio', DASHSCOPE_API_KEY: 'sk-fake', DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic' };
  const transport = fakeTransport(replies);
  const io: Io = {
    env,
    cwd: workspace,
    out: () => {},
    err: () => {},
    write: () => {},
    interrupts: () => new AbortController().signal,
    confirm: async () => false,
    fetch: transport.fetch,
  };
  const updates: acp.SessionUpdate[] = [];
  const client = acp.client({ name: 'test-editor' }).onNotification(acp.methods.client.session.update, ({ params }) => {
    updates.push(params.update);
  });
  const connect = <T>(work: (ctx: acp.ClientContext) => Promise<T>) =>
    client.connectWith(gcodeAgent(io, openStore(env), { maxTurns: 10, maxCostUsd: 1 }), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: capable ? { _meta: { [WIDGET_CAPABILITY]: true } } : {},
      });
      return work(ctx);
    });
  const open = async (ctx: acp.ClientContext) => (await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] })).sessionId;
  const say = (ctx: acp.ClientContext, sessionId: string, text: string) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
  const events = async (sessionId: string) => (await readSessionLog(sessionFile(openStore(env), asSessionId(sessionId)))).events;
  return { workspace, home, transport, updates, connect, open, say, events };
}

const toolNames = offeredTools;
type Update = acp.SessionUpdate & { toolCallId?: string; _meta?: Record<string, unknown>; content?: acp.ToolCallContent[]; status?: string; title?: string };
const forCall = (updates: readonly acp.SessionUpdate[], id: string) => (updates as Update[]).filter((u) => u.toolCallId === id);

describe('gcode serve: show_widget', () => {
  it('stores the widget by its hash, logs the reference, and sends the html with the result', async () => {
    const { connect, open, say, events, updates, home, transport } = await setup([
      toolCall('', [loadTools('show_widget')], usage),
      toolCall('Here is the breakdown.', [{ id: 'tu_w', name: 'show_widget', input: INPUT }], usage),
      answer('The thinking phase is the largest.', usage),
    ]);
    const sessionId = await connect(async (ctx) => {
      const id = await open(ctx);
      await say(ctx, id, 'show where the time goes');
      return id;
    });

    expect(toolNames(transport.requests[0]!.body)).toContain('show_widget');
    const file = path.join(home, 'sessions', sessionId, 'attachments', `${sha256(HTML)}.html`);
    expect(await readFile(file, 'utf8')).toBe(HTML);
    const result = (await events(sessionId)).find((e): e is Extract<TurnEvent, { kind: 'tool-result' }> => e.kind === 'tool-result' && e.toolUseId === 'tu_w')!;
    expect(result.widget).toEqual({ sha256: sha256(HTML), title: INPUT.title, bytes: Buffer.byteLength(HTML) });
    expect(result.status).toBe('ok');
    expect('output' in result && result.output).toBe(`Shown to the user in the chat: "${INPUT.title}".`);
    expect(JSON.stringify(result), 'the log keeps the reference, not the html').not.toContain('var(--chart-1)');

    const calls = forCall(updates, 'tu_w');
    const drafts = calls.filter((u) => u._meta?.[WIDGET_DRAFT_META] !== undefined);
    expect(drafts[0]!.sessionUpdate, 'the step appears while the model is still writing').toBe('tool_call');
    expect(drafts[0]!.status).toBe('pending');
    expect(drafts.at(-1)!._meta![WIDGET_DRAFT_META]).toEqual({ title: INPUT.title, loadingMessages: INPUT.loading_messages });
    expect(calls.indexOf(drafts[0]!)).toBeLessThan(calls.findIndex((u) => u.status === 'in_progress'));
    const done = calls.find((u) => u.status === 'completed' && u.content !== undefined)!;
    expect(done._meta![WIDGET_META]).toEqual(result.widget);
    expect(done.content).toContainEqual({ type: 'content', content: { type: 'resource', resource: { uri: `file://${file}`, mimeType: 'text/html', text: HTML } } });
    expect(calls.find((u) => u.status === 'in_progress')!.title).toBe(`show_widget ${INPUT.title}`);
  });

  it('draws it again when the session is loaded, and says so when the stored file is gone', async () => {
    const { connect, open, say, updates, home, workspace } = await setup([toolCall('', [loadTools('show_widget')], usage), toolCall('', [{ id: 'tu_w', name: 'show_widget', input: INPUT }], usage), answer('Done.', usage)]);
    const sessionId = await connect(async (ctx) => {
      const id = await open(ctx);
      await say(ctx, id, 'draw it');
      return id;
    });
    const load = () =>
      connect(async (ctx) => {
        updates.length = 0;
        await ctx.request(acp.methods.agent.session.load, { sessionId, cwd: workspace, mcpServers: [] });
        return forCall(updates, 'tu_w');
      });
    const replayed = (await load()).find((u) => u.sessionUpdate === 'tool_call_update')!;
    expect(replayed._meta![WIDGET_META]).toMatchObject({ sha256: sha256(HTML), title: INPUT.title });
    expect(replayed.content).toContainEqual(expect.objectContaining({ content: expect.objectContaining({ type: 'resource', resource: expect.objectContaining({ text: HTML }) }) }));
    expect((await load()).find((u) => u.sessionUpdate === 'tool_call')!.title).toBe(`show_widget ${INPUT.title}`);

    await rm(path.join(home, 'sessions', sessionId, 'attachments', `${sha256(HTML)}.html`));
    const gone = (await load()).find((u) => u.sessionUpdate === 'tool_call_update')!;
    expect(gone._meta![WIDGET_META], 'the reference still names it').toMatchObject({ title: INPUT.title });
    expect(gone.content!.some((c) => c.type === 'content' && c.content.type === 'resource'), 'with no html to draw').toBe(false);
  });

  it('is offered in Plan and Auto too, and not to a client that cannot draw it', async () => {
    const planned = await setup([answer('a', usage), answer('b', usage)]);
    await planned.connect(async (ctx) => {
      const id = await planned.open(ctx);
      await ctx.request(acp.methods.agent.session.setMode, { sessionId: id, modeId: 'plan' });
      await planned.say(ctx, id, 'plan it');
      await ctx.request(acp.methods.agent.session.setMode, { sessionId: id, modeId: 'auto' });
      await planned.say(ctx, id, 'do it');
    });
    expect(planned.transport.requests.map((r) => toolNames(r.body).includes('show_widget'))).toEqual([true, true]);

    const plain = await setup([answer('a', usage)], false);
    await plain.connect(async (ctx) => plain.say(ctx, await plain.open(ctx), 'hi'));
    expect(toolNames(plain.transport.requests[0]!.body)).not.toContain('show_widget');
  });

  it('tells the model what is wrong with a widget it cannot show', async () => {
    const { connect, open, say, events } = await setup([
      toolCall('', [loadTools('show_widget')], usage),
      toolCall('', [{ id: 'tu_w', name: 'show_widget', input: { title: 'Speed', html: '<p>', width: 680 } }], usage),
      answer('Sorry.', usage),
    ]);
    const sessionId = await connect(async (ctx) => {
      const id = await open(ctx);
      await say(ctx, id, 'draw it');
      return id;
    });
    const result = (await events(sessionId)).find((e): e is Extract<TurnEvent, { kind: 'tool-result' }> => e.kind === 'tool-result' && e.toolUseId === 'tu_w')!;
    expect(result.status).toBe('error');
    expect('output' in result && result.output).toContain('show_widget has an unknown field "width"');
    expect(result.widget).toBeUndefined();
  });

  it('is never offered to a run with nobody watching, whatever the caller says', async () => {
    const { transport, workspace, home } = await setup([answer('Done.', usage)]);
    const env = { GCODE_HOME: home, GCODE_PROVIDER: 'modelstudio', DASHSCOPE_API_KEY: 'sk-fake', DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic' };
    const io: Io = { env, cwd: workspace, out: () => {}, err: () => {}, write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch: transport.fetch };
    const store = openStore(env);
    const opened = await startSession(store, io, { workspace, provider: undefined, model: undefined, effort: undefined });
    await runAgent(io, store, opened, 'draw it', {
      limits: { maxTurns: 2, maxCostUsd: 1 },
      check: undefined,
      checkAfterEdit: false,
      approval: { kind: 'non-interactive', mcp: false },
      widgets: true,
    });
    expect(toolNames(transport.requests[0]!.body)).not.toContain('show_widget');
  });
});
