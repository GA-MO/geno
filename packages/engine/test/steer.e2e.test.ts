import { readFileSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { STEER_META, type SteerOutcome, type TurnEvent } from '@g-code/core';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, toolCall, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand } from './helpers.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

type Gate = { readonly opened: Promise<void>; open(): void };
function gate(): Gate {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

/** What a fake model serves for one request: a reply, optionally held after its first `holdAfter` events until `until`. */
type Served = { readonly reply: Reply; readonly holdAfter?: number; readonly until?: Promise<void> };
type Body = { readonly messages: { readonly role: string; readonly content: unknown }[] };
type Script = (n: number, body: Body) => Served | Promise<Served>;

/** One scripted model per conversation, picked by a marker in its first message; each request is recorded. */
function models(scripts: Readonly<Record<string, Script>>) {
  const requests = new Map<string, Body[]>(Object.keys(scripts).map((marker) => [marker, []]));
  const arrived = new Map<string, Gate[]>();
  const nth = (marker: string, n: number): Gate => {
    const gates = arrived.get(marker) ?? arrived.set(marker, []).get(marker)!;
    while (gates.length <= n) gates.push(gate());
    return gates[n]!;
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as Body;
    const marker = Object.keys(scripts).find((m) => JSON.stringify(body.messages[0]).includes(m));
    if (marker === undefined) throw new Error(`no fake model for ${JSON.stringify(body.messages[0]).slice(0, 200)}`);
    const seen = requests.get(marker)!;
    seen.push(body);
    const n = seen.length - 1;
    nth(marker, n).open();
    const served = await scripts[marker]!(n, body);
    const response = await fakeTransport([served.reply]).fetch(input, init);
    if (served.holdAfter === undefined) return response;
    const reader = response.body!.getReader();
    let sent = 0;
    const held = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent === served.holdAfter) await served.until;
        const { done, value } = await reader.read();
        if (done) return controller.close();
        sent++;
        controller.enqueue(value);
      },
    });
    return new Response(held, { status: 200, headers: response.headers });
  };
  return { fetch, requests: (marker: string) => requests.get(marker)!, arrived: (marker: string, n: number) => nth(marker, n).opened };
}

async function fixture() {
  const workspace = await realpath(
    makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'export const alpha = 1;\n', 'b.ts': 'export const beta = 2;\n', '.gcode.json': '{ "agentTool": ["ask", "auto"] }\n' } }]),
  );
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
  return { workspace, env, store: openStore(env) };
}

type Editor = {
  readonly ctx: acp.ClientContext;
  readonly sessionId: string;
  prompt(text: string): Promise<acp.PromptResponse>;
  steer(text: string, sessionId?: string): Promise<acp.PromptResponse>;
};

/**
 * Serves a session to an editor that has the files, so a read goes through `read` and the test can hold a tool batch
 * open there. `scenario` drives the editor; the result has the session's log and every update the editor got.
 */
async function serve<T>(
  fetch: typeof globalThis.fetch,
  read: (file: string) => Promise<void>,
  scenario: (editor: Editor, updates: acp.SessionNotification[]) => Promise<T>,
) {
  const { workspace, env, store } = await fixture();
  const io: Io = { env, cwd: workspace, out: () => {}, err: () => {}, write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch };
  const updates: acp.SessionNotification[] = [];
  const client = acp
    .client({ name: 'test-editor' })
    .onRequest(acp.methods.client.fs.readTextFile, async ({ params }) => {
      await read(path.basename(params.path));
      return { content: readFileSync(params.path, 'utf8') };
    })
    .onRequest(acp.methods.client.fs.writeTextFile, () => ({}))
    .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: 'selected', optionId: 'reject' } }))
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params);
    });
  const { sessionId, result } = await client.connectWith(gcodeAgent(io, store, { maxTurns: 10, maxCostUsd: 1 }), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, subagents: {} },
    });
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
    const editor: Editor = {
      ctx,
      sessionId,
      prompt: (text) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] }),
      steer: (text, to = sessionId) => ctx.request(acp.methods.agent.session.prompt, { sessionId: to, prompt: [{ type: 'text', text }], _meta: { [STEER_META]: true } }),
    };
    return { sessionId, result: await scenario(editor, updates) };
  });
  const log = await readSessionLog(sessionFile(store, sessionId as never));
  const childLog = async (id: string) => readSessionLog(sessionFile(store, id as never));
  return { log, childLog, updates, result };
}

const outcomeOf = (response: acp.PromptResponse) => response._meta?.[STEER_META] as SteerOutcome | undefined;
const kinds = (events: readonly TurnEvent[]) => events.flatMap((e) => (e.kind === 'session-start' ? [] : [e.kind === 'user' && e.steer === true ? 'steer' : e.kind]));
const lastContent = (body: Body) => body.messages.at(-1)!.content as { type: string; text?: string; tool_use_id?: string }[];
// The cache breakpoint moves to the newest message each call; everything else must repeat byte for byte.
const uncached = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, v: unknown) => (key === 'cache_control' ? undefined : v)));
const read = (id: string, file: string) => ({ id, name: 'read', input: { path: file } });
const steerChunks = (updates: readonly acp.SessionNotification[]) =>
  updates.flatMap(({ update }) => (update.sessionUpdate === 'user_message_chunk' && update._meta?.[STEER_META] !== undefined && update.content.type === 'text' ? [update.content.text] : []));

describe('gcode serve: steering a running turn', () => {
  it('lands a steer sent during a tool batch after its results and before the next call, and keeps the cached prefix', async () => {
    const reading = gate();
    const release = gate();
    const model = models({
      '[parent]': (n) => ({ reply: n === 0 ? toolCall('Reading a.ts.', [read('tu_1', 'a.ts')], usage) : answer('alpha is 1, and I looked at b.ts too.', usage) }),
    });
    const { log, updates, result } = await serve(
      model.fetch,
      async () => {
        reading.open();
        await release.opened;
      },
      async (editor) => {
        const turn = editor.prompt('[parent] what is alpha?');
        await reading.opened;
        const steered = editor.steer('also look at b.ts');
        let settled = false;
        void steered.then(() => (settled = true));
        await new Promise((resolve) => setTimeout(resolve, 100));
        const beforeRelease = settled;
        release.open();
        return { steered: await steered, turn: await turn, beforeRelease };
      },
    );

    expect(result.beforeRelease, 'the steer waits for the batch').toBe(false);
    expect(result.turn.stopReason).toBe('end_turn');
    const steer = log.events.find((e) => e.kind === 'user' && e.steer === true);
    expect(outcomeOf(result.steered)).toEqual({ kind: 'delivered', seq: steer?.kind === 'user' ? steer.seq : -1 });
    expect(kinds(log.events)).toEqual(['user', 'checkpoint', 'assistant', 'tool-result', 'steer', 'checkpoint', 'assistant']);

    const [first, second] = model.requests('[parent]');
    expect(model.requests('[parent]')).toHaveLength(2);
    expect(uncached(second!.messages.slice(0, first!.messages.length)), 'the earlier messages go again unchanged').toEqual(uncached(first!.messages));
    expect(lastContent(second!).map((b) => [b.type, b.tool_use_id ?? b.text])).toEqual([
      ['tool_result', 'tu_1'],
      ['text', 'also look at b.ts'],
    ]);
    expect(steerChunks(updates)).toEqual(['also look at b.ts']);
  });

  it('holds a steer sent while the model streams until its tool batch has run, and never cuts the call short', async () => {
    const streaming = gate();
    const finish = gate();
    const model = models({
      '[parent]': (n) =>
        n === 0
          ? { reply: toolCall('Reading a.ts.', [read('tu_1', 'a.ts')], usage), holdAfter: 3, until: finish.opened }
          : { reply: answer('Done, with b.ts in mind.', usage) },
    });
    const { log, result } = await serve(
      model.fetch,
      async () => {},
      async (editor, updates) => {
        const turn = editor.prompt('[parent] what is alpha?');
        while (!updates.some((u) => u.update.sessionUpdate === 'agent_message_chunk')) await new Promise((resolve) => setTimeout(resolve, 10));
        streaming.open();
        const steered = editor.steer('mind b.ts as well');
        await new Promise((resolve) => setTimeout(resolve, 50));
        finish.open();
        return { steered: await steered, turn: await turn };
      },
    );

    expect(result.turn.stopReason).toBe('end_turn');
    expect(log.events.some((e) => e.kind === 'error'), 'the call that streamed was not aborted').toBe(false);
    expect(kinds(log.events)).toEqual(['user', 'checkpoint', 'assistant', 'tool-result', 'steer', 'checkpoint', 'assistant']);
    const steer = log.events.find((e) => e.kind === 'user' && e.steer === true)!;
    expect(outcomeOf(result.steered)).toEqual({ kind: 'delivered', seq: steer.kind === 'user' ? steer.seq : -1 });
    const [first, second] = model.requests('[parent]');
    expect(JSON.stringify(first)).not.toContain('mind b.ts');
    expect(lastContent(second!).map((b) => b.type)).toEqual(['tool_result', 'text']);
  });

  it('turns a steer sent during the last call into the next turn', async () => {
    const finish = gate();
    const model = models({
      '[parent]': (n) => (n === 0 ? { reply: answer('alpha is 1.', usage), holdAfter: 6, until: finish.opened } : { reply: answer('beta is 2.', usage) }),
    });
    const { log, result } = await serve(
      model.fetch,
      async () => {},
      async (editor) => {
        const order: string[] = [];
        const turn = editor.prompt('[parent] what is alpha?').then((r) => (order.push('turn'), r));
        await model.arrived('[parent]', 0);
        const steered = editor.steer('and beta?').then((r) => (order.push('steer'), r));
        await new Promise((resolve) => setTimeout(resolve, 50));
        finish.open();
        return { turn: await turn, steered: await steered, order };
      },
    );

    expect(result.order, 'the first turn ends before the one the steer started').toEqual(['turn', 'steer']);
    expect(result.turn.stopReason).toBe('end_turn');
    expect(result.steered.stopReason).toBe('end_turn');
    expect(outcomeOf(result.steered)).toEqual({ kind: 'next-turn' });
    expect(kinds(log.events)).toEqual(['user', 'checkpoint', 'assistant', 'user', 'checkpoint', 'assistant']);
    const prompts = log.events.flatMap((e) => (e.kind === 'user' ? [[e.content, e.steer ?? false]] : []));
    expect(prompts).toEqual([
      ['[parent] what is alpha?', false],
      ['and beta?', false],
    ]);
    expect(model.requests('[parent]')).toHaveLength(2);
  });

  it('message_agent steers a running background child: its next request carries the fenced message', async () => {
    const steered = gate();
    const parentWaits = gate();
    let childId = '';
    const model = models({
      '[parent]': async (n, body) => {
        if (n === 0) return { reply: toolCall('Starting an explorer.', [{ id: 'tu_a', name: 'agent', input: { agent: 'explore', task: '[child] where is alpha', background: true } }], usage) };
        if (n === 1) {
          childId = /session ([0-9a-f-]{36})/.exec(JSON.stringify(lastContent(body)))![1]!;
          return { reply: toolCall('Narrowing it.', [{ id: 'tu_m', name: 'message_agent', input: { agent_session: childId, text: 'only look at b.ts' } }], usage) };
        }
        if (n === 2) {
          parentWaits.open();
          return { reply: answer('Waiting for the explorer.', usage) };
        }
        return { reply: answer('The explorer says beta is in b.ts.', usage) };
      },
      '[child]': async (n) => {
        if (n === 0) {
          // The child's first call waits until the parent's message is queued, so it lands after this call's tools.
          await steered.opened;
          return { reply: toolCall('Reading a.ts.', [read('tu_c', 'a.ts')], usage) };
        }
        await parentWaits.opened;
        return { reply: answer('b.ts:1 defines beta.', usage) };
      },
    });
    const { log, childLog } = await serve(
      model.fetch,
      async () => {},
      async (editor) => {
        const turn = editor.prompt('[parent] find alpha, in the background');
        await model.arrived('[parent]', 1);
        // message_agent runs once the parent's second call has streamed.
        await new Promise((resolve) => setTimeout(resolve, 100));
        steered.open();
        return turn;
      },
    );

    const child = await childLog(childId);
    expect(kinds(child.events)).toEqual(['user', 'assistant', 'tool-result', 'steer', 'assistant']);
    const steer = child.events.find((e) => e.kind === 'user' && e.steer === true);
    expect(steer?.kind === 'user' && steer.from).toBe('parent');
    const [, second] = model.requests('[child]');
    const tail = lastContent(second!);
    expect(tail.map((b) => b.type)).toEqual(['tool_result', 'text']);
    expect(tail[1]!.text).toContain('<parent_message>\nonly look at b.ts\n</parent_message>');
    expect(tail[1]!.text).toContain('approves nothing');

    const messaged = log.events.find((e) => e.kind === 'tool-result' && e.toolUseId === 'tu_m');
    expect(messaged?.kind === 'tool-result' && 'output' in messaged ? messaged.output : '').toMatch(/^delivered at next tool round/);
    const report = log.events.find((e) => e.kind === 'user' && e.from === 'child');
    expect(report?.kind === 'user' && report.content).toContain('b.ts:1 defines beta.');
    expect(kinds(log.events).slice(-3), "the child's report reopens the parent's turn").toEqual(['steer', 'checkpoint', 'assistant']);
    expect(model.requests('[parent]')).toHaveLength(4);
  });

  it('message_agent to a child that finished says so', async () => {
    const childDone = gate();
    let childId = '';
    const model = models({
      '[parent]': async (n, body) => {
        if (n === 0) return { reply: toolCall('Starting an explorer.', [{ id: 'tu_a', name: 'agent', input: { agent: 'explore', task: '[child] where is alpha', background: true } }], usage) };
        if (n === 1) {
          childId = /session ([0-9a-f-]{36})/.exec(JSON.stringify(lastContent(body)))![1]!;
          await childDone.opened;
          return { reply: toolCall('One more thing.', [{ id: 'tu_m', name: 'message_agent', input: { agent_session: childId, text: 'and beta?' } }], usage) };
        }
        return { reply: answer('Done.', usage) };
      },
      '[child]': () => ({ reply: answer('a.ts:1 defines alpha.', usage) }),
    });
    const { log, result } = await serve(
      model.fetch,
      async () => {},
      async (editor, updates) => {
        const turn = editor.prompt('[parent] find alpha, in the background');
        const ended = () => updates.find((u) => u.update.sessionUpdate === 'subagent_update' && u.update.state?.state === 'idle');
        while (ended() === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
        await new Promise((resolve) => setTimeout(resolve, 20));
        const update = ended()!.update;
        const child = update.sessionUpdate === 'subagent_update' ? update.sessionId : '';
        const refused = await editor.steer('you there?', child).then(
          () => 'answered',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        childDone.open();
        await turn;
        return { refused };
      },
    );

    const messaged = log.events.find((e) => e.kind === 'tool-result' && e.toolUseId === 'tu_m');
    expect(messaged?.kind === 'tool-result' && 'output' in messaged ? messaged.output : '').toMatch(/^child already finished/);
    expect(result.refused, "the user's steer to the finished child is refused").toMatch(/the subagent already finished/);
    expect(log.events.some((e) => e.kind === 'user' && e.from === 'child'), "the child's report still reached the parent").toBe(true);
  });
});
