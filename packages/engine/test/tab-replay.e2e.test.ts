import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from './helpers.js';

const lines = Array.from({ length: 12 }, (_, i) => `const v${i} = ${i};`);
const before = `${lines.join('\n')}\n`;
const expected = before.replace('const v1 = 1;', 'const v1 = one;').replace('const v8 = 8;', 'const v8 = eight;');

/** Answers every request with the target rewrite, so the grade depends only on the harness reading it back. */
function fakeServer(prompts: string[]): typeof globalThis.fetch {
  return async (_, init) => {
    const { prompt } = JSON.parse(String(init?.body)) as { prompt: string };
    prompts.push(prompt);
    const isWarmup = prompt.includes('<filename>warmup_');
    const content = isWarmup ? '<|marker_1|><|marker_1|>' : `<|marker_1|>${expected}<|marker_2|>`;
    const chunks = [
      { content, stop: false },
      { content: '', stop: true, model: 'zeta-fake', tokens_evaluated: 50, timings: { prompt_n: 40, prompt_ms: 9, predicted_n: 30, predicted_ms: 20 } },
    ];
    return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(''), { status: 200 });
  };
}

describe('gcode tab replay', () => {
  it('replays each hunk after the first as a next-edit moment, grades it, and writes one row per moment', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'gcode-replay-'));
    await mkdir(path.join(home, 'evals', 'apply'), { recursive: true });
    const triple = { id: 'demo-abc1234', repo: '/tmp/demo', commit: 'abc1234', path: 'src/v.ts', instruction: 'rename', before, expected };
    await writeFile(path.join(home, 'evals', 'apply', 'demo-abc1234.json'), JSON.stringify(triple));
    const out = path.join(home, 'rows.jsonl');
    const prompts: string[] = [];

    const { code, stdout } = await runCli(['tab', 'replay', '--history', '1', '--warmup', '2', '--out', out], { GCODE_HOME: home }, { fetch: fakeServer(prompts) });

    expect(code).toBe(0);
    expect(stdout).toContain('moments: 1, history: 1');
    expect(stdout).toContain('  exact: 1');
    expect(stdout).toContain('model: zeta-fake');
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain('<filename>edit_history\n--- a/src/v.ts\n+++ b/src/v.ts\n');
    expect(prompts[2]).toContain('+const v1 = one;\n');
    const rows = (await readFile(out, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toEqual([expect.objectContaining({ id: 'demo-abc1234#1', grade: 'exact', reachable: true, historyEntries: 1, generatedTokens: 30 })]);
  });

  it('reports an unreachable server as an error', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'gcode-replay-'));
    await mkdir(path.join(home, 'evals', 'apply'), { recursive: true });
    const triple = { id: 'demo-abc1234', repo: '/tmp/demo', commit: 'abc1234', path: 'src/v.ts', instruction: 'rename', before, expected };
    await writeFile(path.join(home, 'evals', 'apply', 'demo-abc1234.json'), JSON.stringify(triple));
    const down: typeof globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const { code, stderr } = await runCli(['tab', 'replay', '--warmup', '0', '--out', path.join(home, 'r.jsonl')], { GCODE_HOME: home }, { fetch: down });
    expect(code).toBe(1);
    expect(stderr).toContain('next-edit server at http://127.0.0.1:8013: fetch failed');
  });
});
