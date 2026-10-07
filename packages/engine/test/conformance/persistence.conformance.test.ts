import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { call, closeServers, say, scripted, sessionIdOf, WIRES, type Wire } from './scripted.js';

afterEach(closeServers);

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
