import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeToolUse } from '../fake-transport.js';
import { call, closeServers, say, scripted, sessionIdOf, WIRES } from './scripted.js';

afterEach(closeServers);

let ids = 0;
const use = (name: string, input: unknown): FakeToolUse => ({ id: `call_${ids++}`, name, input });
const read = (file: string) => use('read', { path: file });
const bash = (command: string) => use('bash', { command });
const agent = (workspace: string, prompt: string) => ['agent', '--workspace', workspace, '--non-interactive', prompt];
const resume = (id: string, prompt: string) => ['agent', '--session', id, '--non-interactive', prompt];

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
