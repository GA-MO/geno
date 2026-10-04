import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { asCompletionId, type CompletionRequest, type TabEvent } from '@g-code/core/tab';
import { runCli } from './helpers.js';

const request = (n: number, latencyMs: number): CompletionRequest => ({
  id: asCompletionId(`c${n}`),
  kind: 'fim',
  path: '/w/a.ts',
  version: 1,
  offset: 0,
  inputs: { repo: 'w', path: 'a.ts', prefix: 'const a = ', suffix: '', snippets: [] },
  model: 'qwen2.5-coder-1.5b-q8_0',
  source: 'model',
  promptTokens: 300,
  sentAt: `2026-10-0${n}T00:00:00.000Z`,
  ttftMs: latencyMs / 2,
  latencyMs,
  text: '1;',
  outcome: { kind: 'shown' },
  persisted: 'unknown',
});

async function homeWith(events: TabEvent[], tail = ''): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-tab-'));
  await writeFile(path.join(home, 'tab-events.jsonl'), events.map((e) => `${JSON.stringify(e)}\n`).join('') + tail);
  return home;
}

describe('gcode tab report', () => {
  it('prints outcome counts, latency percentiles and rates per model, skipping a torn last line', async () => {
    const home = await homeWith(
      [
        { kind: 'request', request: request(1, 100) },
        { kind: 'request', request: request(2, 300) },
        { kind: 'outcome', id: asCompletionId('c1'), at: '2026-10-03T00:00:00.000Z', outcome: { kind: 'accepted' } },
        { kind: 'persisted', id: asCompletionId('c1'), at: '2026-10-03T00:05:00.000Z', persisted: true },
      ],
      '{"kind":"outc',
    );
    const { code, stdout } = await runCli(['tab', 'report'], { GCODE_HOME: home });
    expect(code).toBe(0);
    expect(stdout).toContain('model: qwen2.5-coder-1.5b-q8_0');
    expect(stdout).toContain('    accepted: 1');
    expect(stdout).toContain('    shown: 1');
    expect(stdout).toContain('  time to first token: p50 100 ms, p90 140 ms');
    expect(stdout).toContain('  total latency: p50 200 ms, p90 280 ms');
    expect(stdout).toContain('  accept per shown: 50.0%');
    expect(stdout).toContain('  persisted per accepted: 100.0%');
  });

  it('filters by --since and rejects a bad date', async () => {
    const home = await homeWith([{ kind: 'request', request: request(1, 100) }]);
    const since = await runCli(['tab', 'report', '--since', '2026-10-02'], { GCODE_HOME: home });
    expect(since.stdout).toContain('no completion requests');
    const bad = await runCli(['tab', 'report', '--since', 'yesterday'], { GCODE_HOME: home });
    expect(bad.code).toBe(2);
  });

  it('fails on a corrupt line that is not the last', async () => {
    const home = await homeWith([], '{"kind":"request"}\n');
    const { code, stderr } = await runCli(['tab', 'report'], { GCODE_HOME: home });
    expect(code).toBe(1);
    expect(stderr).toContain('line 1');
  });
});
