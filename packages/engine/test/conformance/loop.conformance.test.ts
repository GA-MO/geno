import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { gcodeAgent } from '../../src/serve.js';
import type { FakeToolUse } from '../fake-transport.js';
import { call, say, scripted, sessionIdOf, WIRES } from './scripted.js';

let ids = 0;
const use = (name: string, input: unknown): FakeToolUse => ({ id: `call_${ids++}`, name, input });
const read = (file: string) => use('read', { path: file });
const bash = (command: string) => use('bash', { command });
const agent = (workspace: string, prompt: string) => ['agent', '--workspace', workspace, '--non-interactive', prompt];
const resume = (id: string, prompt: string) => ['agent', '--session', id, '--non-interactive', prompt];
// The cache breakpoint moves to the newest message each call; everything else must repeat byte for byte.
const uncached = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, v: unknown) => (key === 'cache_control' ? undefined : v)));

describe.each(WIRES)('the agent loop on the %s wire', (wire) => {
  it('T-LOOP-01 every tool use gets a result with its id, in the order the model asked', async () => {
    const uses = [read('a.ts'), use('glob', { pattern: '**/*.ts' }), read('b.ts')];
    const { workspace, cli, seen } = await scripted(wire, [call('Looking.', uses), say('Done.')], { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 2;\n' });

    expect((await cli(agent(workspace, 'Look around'))).code).toBe(0);

    expect(seen()[1]!.results.map((r) => [r.id, r.error])).toEqual(uses.map((u) => [u.id, false]));
  });

  it('T-LOOP-02 a denied call does not stop the other calls of its batch', async () => {
    const uses = [read('a.ts'), bash('git push origin main'), read('b.ts')];
    const { workspace, cli, seen, log } = await scripted(wire, [call('Trying.', uses), say('Done.')], { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 2;\n' });

    const result = await cli(agent(workspace, 'Push it'));

    expect(result.code).toBe(0);
    const results = seen()[1]!.results;
    expect(results.map((r) => [r.id, r.error])).toEqual([
      [uses[0]!.id, false],
      [uses[1]!.id, true],
      [uses[2]!.id, false],
    ]);
    expect(results[2]!.text).toContain('export const b = 2;');
    expect((await log(result.stdout)).flatMap((e) => (e.kind === 'tool-result' ? [e.status] : []))).toEqual(['ok', 'denied', 'ok']);
  });

  it('a tool call whose arguments are not JSON gets an error result and the turn goes on, instead of failing', async () => {
    const broken: FakeToolUse = { id: `call_${ids++}`, name: 'edit', input: {}, rawJson: '{"path":"game.js","create":}' };
    const fixed = use('edit', { path: 'game.js', create: true, new_str: 'export const game = 1;\n' });
    const { workspace, cli, seen } = await scripted(wire, [call('Writing.', [broken]), call('Again.', [fixed]), say('Written.')]);

    const result = await cli(agent(workspace, 'Write the game'));

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('Written.');
    expect(seen()[1]!.results[0]).toMatchObject({ id: broken.id, error: true });
    expect(readFileSync(path.join(workspace, 'game.js'), 'utf8'), 'the call the model sent again runs').toBe('export const game = 1;\n');
  });

  it('T-LOOP-04 a tool call cut off at max_tokens does not run, gets an error result, and the turn goes on', async () => {
    // The cut lands in the long description, after a whole command: on the Anthropic wire the SDK's partial parse keeps the command and drops the rest.
    const description = 'Record that the command ran, in a description long enough that the output limit cuts it short';
    const cut = use('bash', { command: 'echo ran >> ran.txt', description });
    const { workspace, cli, seen } = await scripted(wire, [call('Recording.', [read('a.ts'), cut], { cutOff: true }), say('Retried smaller.')]);

    const result = await cli(agent(workspace, 'Record a run'));

    expect(existsSync(path.join(workspace, 'ran.txt')), 'the cut-off command never runs').toBe(false);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Retried smaller.');
    const [first, second] = seen()[1]!.results;
    expect(first, 'the complete call before it still runs').toMatchObject({ error: false, text: expect.stringContaining('export const a = 1;') });
    expect(second).toMatchObject({ id: cut.id, error: true, text: expect.stringMatching(/output limit/i) });
  });

  it('A/A-10 a call the user stopped never runs again, and the next prompt sees it was stopped', async () => {
    const stopped = bash('echo run >> runs.txt; sleep 5');
    const { workspace, cli, seen } = await scripted(wire, [call('Running it.', [stopped]), say('I will leave it.')]);
    const runs = path.join(workspace, 'runs.txt');
    let interrupt: AbortController | undefined;
    const poll = setInterval(() => {
      if (existsSync(runs)) interrupt?.abort();
    }, 20);
    const first = await cli(agent(workspace, 'Run the slow thing'), { onWrite: (_text, controller) => (interrupt = controller) }).finally(() => clearInterval(poll));
    expect(first.code).toBe(130);

    const second = await cli(resume(sessionIdOf(first.stdout), "don't run that"));

    expect(second.code).toBe(0);
    expect(readFileSync(runs, 'utf8'), 'the stopped command ran once').toBe('run\n');
    const next = seen()[1]!;
    expect(next.results).toEqual([{ id: stopped.id, error: true, text: expect.stringMatching(/interrupted by (the )?user/i) }]);
    expect(next.text).toContain("don't run that");
  });

  it('A/A-10 in the editor a Stop keeps what finished, answers the rest as stopped, and the next prompt runs none of it', async () => {
    const finished = read('a.ts');
    const stopped = bash('echo run >> runs.txt; sleep 5');
    const queued = read('b.ts');
    const { workspace, store, io, seen, events } = await scripted(wire, [call('Working.', [finished, stopped, queued]), say('Left as it is.')], {
      'a.ts': 'export const a = 1;\n',
      'b.ts': 'export const b = 2;\n',
    });
    const runs = path.join(workspace, 'runs.txt');
    const updates: acp.SessionUpdate[] = [];
    const editor = acp
      .client({ name: 'test-editor' })
      .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: 'cancelled' } }))
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params.update);
      });

    const sessionId = await editor.connectWith(gcodeAgent(io, store, { maxTurns: 10, maxCostUsd: 1 }), async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
      const prompt = (text: string) => ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
      const stopping = setInterval(() => {
        if (existsSync(runs)) void ctx.notify(acp.methods.agent.session.cancel, { sessionId });
      }, 20);
      await prompt('Do the three things').finally(() => clearInterval(stopping));
      await prompt("don't run that");
      return sessionId;
    });

    expect(readFileSync(runs, 'utf8'), 'the stopped command ran once').toBe('run\n');
    const next = seen()[1]!;
    expect(next.results).toEqual([
      { id: finished.id, error: false, text: expect.stringContaining('export const a = 1;') },
      { id: stopped.id, error: true, text: expect.stringMatching(/interrupted by user.*may have partly run/) },
      { id: queued.id, error: true, text: expect.stringMatching(/interrupted by user.*did not run/) },
    ]);
    expect(next.text).toContain("don't run that");
    const log = await events(sessionId);
    const stop = log.findIndex((e) => e.kind === 'error');
    expect(log.slice(stop - 3, stop + 1).map((e) => (e.kind === 'tool-result' ? `${e.toolUseId}:${e.status}` : e.kind)), 'the results are logged before the abort').toEqual([
      `${finished.id}:ok`,
      `${stopped.id}:error`,
      `${queued.id}:error`,
      'error',
    ]);
    expect(log[stop]).toMatchObject({ error: 'abort', tools: [expect.objectContaining({ toolUseId: stopped.id })] });
    expect(updates, 'the editor shows the call that never started, and its result').toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionUpdate: 'tool_call', toolCallId: queued.id, title: expect.stringContaining('b.ts') }),
        expect.objectContaining({ sessionUpdate: 'tool_call_update', toolCallId: queued.id, status: 'failed' }),
      ]),
    );
  });

  it('A/B-11 a tight --max-turns tells the model once what is left, without moving the cached prefix, and the run ends with its report', async () => {
    const steps = [read('a.ts'), use('glob', { pattern: '**/*.ts' }), read('a.ts'), use('grep', { pattern: 'const' })];
    const closing = 'Checked a.ts: it exports a = 1. Nothing changed; the open item is b.ts, which I did not reach.';
    const { workspace, cli, seen, bodies, log } = await scripted(wire, [...steps.map((step) => call('Looking.', [step])), say(closing)]);

    const result = await cli([...agent(workspace, 'Audit the exports'), '--max-turns', '5']);

    expect(result.code, 'the model ended the run itself, not the limit').toBe(0);
    const reminded = seen().map((request) => /near its limits: about (\d+) more model calls? (?:is|are) left \(\d+ of its 5 calls/.exec(request.text)?.[1]);
    expect(reminded, 'once, before the last call, with one call left').toEqual([undefined, undefined, undefined, undefined, '1']);
    const events = await log(result.stdout);
    expect(events.filter((e) => e.kind === 'notice' && e.budget !== undefined)).toHaveLength(1);
    const last = events.findLast((e) => e.kind === 'assistant');
    expect(last?.kind === 'assistant' && last.stopReason).toBe('end_turn');
    expect(last?.kind === 'assistant' && last.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')).toBe(closing);
    const [before, after] = bodies().slice(-2).map(uncached) as { system?: unknown; tools?: unknown; messages: unknown[] }[];
    expect(after!.system).toEqual(before!.system);
    expect(after!.tools).toEqual(before!.tools);
    expect(after!.messages.slice(0, before!.messages.length), 'the reminder only adds to the conversation').toEqual(before!.messages);
  });
});

describe('the agent loop on the anthropic wire', () => {
  it('A/A-08 a model_context_window_exceeded stop compacts the context and sends again once', async () => {
    const { workspace, cli, seen, log } = await scripted('anthropic', [
      say('First answer.'),
      say('Cut short by the window', 'model_context_window_exceeded'),
      say('## Goal\nAnswer the user.\n## Progress\n## Decisions\n## Next steps'),
      say('Second answer, after compacting.'),
    ]);
    const first = await cli(agent(workspace, 'first'));
    expect(first.code).toBe(0);

    const second = await cli(resume(sessionIdOf(first.stdout), 'second'));

    expect(second.code).toBe(0);
    expect(second.stdout).toContain('Second answer, after compacting.');
    expect(seen()).toHaveLength(4);
    expect(seen()[3]!.text, 'the retry carries the compacted context').toContain('<compacted_context>');
    const events = await log(second.stdout);
    expect(events.filter((e) => e.kind === 'compact').map((e) => e.kind === 'compact' && e.trigger)).toEqual(['overflow']);
    expect(events.flatMap((e) => (e.kind === 'assistant' ? [e.stopReason] : [])), 'the cut-short turn is not kept').toEqual(['end_turn', 'end_turn']);
  });
});
