import { readFileSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STEER_META, type SteerOutcome, type TurnEvent, userSteerText } from '@g-code/core';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, loadTools, toolCall, type Reply } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand } from './helpers.js';

// A steer that never lands must fail here in seconds, never leave a worker spinning.
vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

/**
 * Every wait in these tests is bounded, so a steer that never lands fails fast and names the step it waited on. The
 * fake model's and the editor's own waits give up first and are listed in the test's failure, since they fail inside
 * the engine rather than in the test.
 */
const INNER_MS = 2000;
const OUTER_MS = 4000;
const stalls: string[] = [];
beforeEach(() => {
  stalls.length = 0;
});

function within<T>(work: Promise<T>, step: string, ms = OUTER_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stalls.push(step);
      const inner = stalls.length > 1 ? ` (stalled first: ${stalls.slice(0, -1).join('; ')})` : '';
      reject(new Error(`timed out after ${ms}ms waiting for ${step}${inner}`));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** A wait inside the fake model or the editor. */
const inner = <T>(work: Promise<T>, step: string): Promise<T> => within(work, step, INNER_MS);

async function until(done: () => boolean, step: string): Promise<void> {
  const deadline = Date.now() + OUTER_MS;
  while (!done()) {
    if (Date.now() > deadline) return within(new Promise<void>(() => {}), step, 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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
        if (sent === served.holdAfter) await inner(served.until!, 'the held model stream to be released');
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
    // U44's background child holds its parent's turn open, as it does where nothing wakes a session.
    GCODE_AUTO_WAKE: 'off',
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
        await inner(release.opened, 'the held read of a.ts to be released');
      },
      async (editor) => {
        const turn = editor.prompt('[parent] what is alpha?');
        await within(reading.opened, 'the read of a.ts to start');
        const steered = editor.steer('also look at b.ts');
        let settled = false;
        void steered.then(() => (settled = true));
        await new Promise((resolve) => setTimeout(resolve, 100));
        const beforeRelease = settled;
        release.open();
        return { steered: await within(steered, 'the steer to be delivered after the tool batch'), turn: await within(turn, 'the turn to end'), beforeRelease };
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
      ['text', userSteerText('also look at b.ts')],
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
        await until(() => updates.some((u) => u.update.sessionUpdate === 'agent_message_chunk'), 'the model to start streaming');
        streaming.open();
        const steered = editor.steer('mind b.ts as well');
        await new Promise((resolve) => setTimeout(resolve, 50));
        finish.open();
        return { steered: await within(steered, 'the steer sent while streaming to be delivered after the batch'), turn: await within(turn, 'the turn to end') };
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
        await within(model.arrived('[parent]', 0), 'the first model call');
        const steered = editor.steer('and beta?').then((r) => (order.push('steer'), r));
        await new Promise((resolve) => setTimeout(resolve, 50));
        finish.open();
        return { turn: await within(turn, 'the first turn to end'), steered: await within(steered, 'the steer to run as the next turn'), order };
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

  it('gives a steer back, unrun, when the user stops the turn it was waiting on', async () => {
    const model = models({
      '[parent]': () => ({ reply: { ...answer('thinking about alpha', usage), stallAfter: 3 } }),
    });
    const { log, result } = await serve(
      model.fetch,
      async () => {},
      async (editor) => {
        const turn = editor.prompt('[parent] what is alpha?');
        await within(model.arrived('[parent]', 0), 'the first model call');
        const steered = editor.steer('and beta?').then(
          () => 'ran',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        await editor.ctx.notify(acp.methods.agent.session.cancel, { sessionId: editor.sessionId });
        return { turn: await within(turn, 'the stopped turn to end'), steered: await within(steered, 'the steer to be given back') };
      },
    );

    expect(result.turn.stopReason).toBe('cancelled');
    expect(result.steered).toMatch(/the turn was stopped before the steer landed/);
    expect(model.requests('[parent]'), 'no turn ran for the steer').toHaveLength(1);
    expect(log.events.filter((e) => e.kind === 'user').map((e) => (e.kind === 'user' ? e.content : ''))).toEqual(['[parent] what is alpha?']);
  });

  it('runs two steers that missed the turn as two turns, one after the other, and Stop still reaches the second', async () => {
    const finish = gate();
    const model = models({
      '[parent]': (n) =>
        n === 0
          ? { reply: answer('alpha is 1.', usage), holdAfter: 6, until: finish.opened }
          : n === 1
            ? { reply: answer('answer 1', usage) }
            : { reply: { ...answer('answer 2', usage), stallAfter: 3 } },
    });
    const { log, result } = await serve(
      model.fetch,
      async () => {},
      async (editor) => {
        const order: string[] = [];
        const turn = editor.prompt('[parent] what is alpha?').then((r) => (order.push('turn'), r));
        await within(model.arrived('[parent]', 0), 'the first model call');
        const first = editor.steer('and beta?').then((r) => (order.push('first'), r));
        const second = editor.steer('and gamma?').then((r) => (order.push('second'), r));
        await new Promise((resolve) => setTimeout(resolve, 50));
        finish.open();
        await within(model.arrived('[parent]', 2), "the second steer's turn to call the model");
        await editor.ctx.notify(acp.methods.agent.session.cancel, { sessionId: editor.sessionId });
        await within(Promise.all([turn, first, second]), 'all three turns to end, the last one stopped');
        return { order, outcomes: [outcomeOf(await first), outcomeOf(await second)], stopped: (await second).stopReason };
      },
    );

    expect(result.order).toEqual(['turn', 'first', 'second']);
    expect(result.outcomes).toEqual([{ kind: 'next-turn' }, { kind: 'next-turn' }]);
    expect(result.stopped, "Stop reaches the second steer's turn").toBe('cancelled');
    expect(kinds(log.events)).toEqual(['user', 'checkpoint', 'assistant', 'user', 'checkpoint', 'assistant', 'user', 'checkpoint', 'error']);
    const third = model.requests('[parent]')[2]!;
    expect(JSON.stringify(third.messages.at(-2)), 'the second steer ran after the first turn it started had its answer').toContain('answer 1');
  });

  it('message_agent steers a running background child: its next request carries the fenced message', async () => {
    const steered = gate();
    const parentWaits = gate();
    let childId = '';
    const model = models({
      '[parent]': async (n, body) => {
        if (n === 0) return { reply: toolCall('Starting an explorer.', [{ id: 'tu_a', name: 'agent', input: { agent: 'explore', task: '[child] where is alpha', background: true } }, loadTools('message_agent')], usage) };
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
          await inner(steered.opened, "the parent's message to be queued for the child");
          return { reply: toolCall('Reading a.ts.', [read('tu_c', 'a.ts')], usage) };
        }
        await inner(parentWaits.opened, "the parent's third model call, after message_agent returned");
        return { reply: answer('b.ts:1 defines beta.', usage) };
      },
    });
    const { log, childLog } = await serve(
      model.fetch,
      async () => {},
      async (editor) => {
        const turn = editor.prompt('[parent] find alpha, in the background');
        await within(model.arrived('[parent]', 1), "the parent's second model call");
        // message_agent runs once the parent's second call has streamed.
        await new Promise((resolve) => setTimeout(resolve, 100));
        steered.open();
        return within(turn, "the parent's turn to end with the child's report");
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

  it('cancels a background child once its parent run stops for a reason other than the end of its turn', async () => {
    const model = models({
      '[parent]': (n) =>
        n === 0
          ? { reply: toolCall('Starting an explorer.', [{ id: 'tu_a', name: 'agent', input: { agent: 'explore', task: '[child] where is alpha', background: true } }], usage) }
          : { reply: answer('I cannot help with that.', usage, { stopReason: 'refusal' }) },
      '[child]': () => ({ reply: { ...answer('never sent', usage), stallAfter: 1 } }),
    });
    const { log, result } = await serve(
      model.fetch,
      async () => {},
      async (editor) => within(editor.prompt('[parent] find alpha, in the background'), 'the refused turn to end with its child cancelled'),
    );

    expect(result.stopReason).toBe('refusal');
    const end = log.events.find((e) => e.kind === 'child-end');
    expect(end?.kind === 'child-end' && end.end.kind, 'the child no longer runs or spends').toBe('cancelled');
  });

  it('message_agent to a child that finished says so', async () => {
    const childDone = gate();
    let childId = '';
    const model = models({
      '[parent]': async (n, body) => {
        if (n === 0) return { reply: toolCall('Starting an explorer.', [{ id: 'tu_a', name: 'agent', input: { agent: 'explore', task: '[child] where is alpha', background: true } }, loadTools('message_agent')], usage) };
        if (n === 1) {
          childId = /session ([0-9a-f-]{36})/.exec(JSON.stringify(lastContent(body)))![1]!;
          await inner(childDone.opened, 'the user to steer the finished child');
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
        await until(() => ended() !== undefined, 'the background child to end');
        await new Promise((resolve) => setTimeout(resolve, 20));
        const update = ended()!.update;
        const child = update.sessionUpdate === 'subagent_update' ? update.sessionId : '';
        const refused = await within(editor.steer('you there?', child), 'the steer to the finished child to be refused').then(
          () => 'answered',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        childDone.open();
        await within(turn, "the parent's turn to end");
        return { refused };
      },
    );

    const messaged = log.events.find((e) => e.kind === 'tool-result' && e.toolUseId === 'tu_m');
    expect(messaged?.kind === 'tool-result' && 'output' in messaged ? messaged.output : '').toMatch(/^child already finished/);
    expect(result.refused, "the user's steer to the finished child is refused").toMatch(/the subagent already finished/);
    expect(log.events.some((e) => e.kind === 'user' && e.from === 'child'), "the child's report still reached the parent").toBe(true);
  });
});
