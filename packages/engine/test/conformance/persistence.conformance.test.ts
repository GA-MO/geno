import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { call, report, say, scripted, sessionIdOf, WIRES, type Wire } from './scripted.js';

const KEY = 'sk-wirelogtest0123456789abcdef';

describe.each(WIRES)('request snapshots and the wire log on the %s wire', (wire: Wire) => {
  it('T-PERSIST-02 every model call can be rebuilt from the log, and GCODE_WIRE_LOG holds each request with the key cut out', async () => {
    const { workspace, env, cli, bodies, log } = await scripted(wire, [call('Looking.', [{ id: 'tu_read', name: 'read', input: { path: 'a.ts' } }]), say('Done.')]);
    const wireLog = path.join(await mkdtemp(path.join(tmpdir(), 'gcode-wire-')), 'wire.jsonl');
    Object.assign(env, { GCODE_WIRE_LOG: wireLog, DASHSCOPE_API_KEY: KEY, OPENAI_API_KEY: KEY });
    const run = await cli(['agent', '--workspace', workspace, '--non-interactive', `Read a.ts. The key is ${KEY}, keep it out of logs.`]);
    expect(run.code).toBe(0);

    const sent = bodies();
    const turns = (await log(run.stdout)).flatMap((e) => (e.kind === 'assistant' ? [e] : []));
    expect(turns).toHaveLength(sent.length);
    for (const [i, turn] of turns.entries()) {
      const shown = await cli(['session', 'request', sessionIdOf(run.stdout), String(turn.seq)]);
      expect(shown.code, shown.stderr).toBe(0);
      expect(JSON.parse(shown.stdout), `call ${i} rebuilt from the log`).toEqual(sent[i]);
    }

    const lines = (await readFile(wireLog, 'utf8')).trim().split('\n');
    expect(JSON.stringify(sent), 'the key went out in the prompt').toContain(KEY);
    expect(lines.join('\n')).not.toContain(KEY);
    const requests = lines.map((line) => JSON.parse(line) as { request?: unknown }).flatMap((entry) => (entry.request === undefined ? [] : [entry.request]));
    expect(requests).toEqual(JSON.parse(JSON.stringify(sent).replaceAll(KEY, '[redacted]')));
  });
});

describe.each(WIRES)('a child transcript on the %s wire', (wire: Wire) => {
  it("T-PERSIST-03 a child has its own log, whose session-start names its parent, the call that started it, its role and its depth", async () => {
    const explore = call('', [{ id: 'tu_agent', name: 'agent', input: { agent: 'explore', task: 'Where is a defined?' } }]);
    const run = await scripted(wire, [explore, report('a.ts:1.'), say('a is in a.ts.')], { 'a.ts': 'export const a = 1;\n', '.gcode.json': '{"agentTool":["non-interactive"]}\n' });
    const parent = await run.cli(['agent', '--workspace', run.workspace, '--non-interactive', 'Where is a defined?']);
    expect(parent.code, parent.stderr).toBe(0);

    const parentId = sessionIdOf(parent.stdout);
    const [started] = (await run.log(parent.stdout)).flatMap((e) => (e.kind === 'child-start' ? [e] : []));
    expect(started?.role).toBe('explore');
    const child = await run.events(started!.child);
    const head = child[0]!;
    expect(head.kind === 'session-start' && head.child).toEqual({ parentId, toolUseId: 'tu_agent', role: 'explore', caps: { maxTurns: 4, maxCostUsd: 0.02 }, start: 'fresh', depth: 1 });
    expect(child.some((e) => e.kind === 'user' && e.content === 'Where is a defined?'), "the task is in the child's own log").toBe(true);
  });
});
