import { readFile } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cachePath, root, setUp } from './launch.js';

const COMPLETION = 'a + b;';
const EXTENSION_ID = 'g-code.g-code';

const fimPrompts: string[] = [];
const nextEditPrompts: string[] = [];

const sse = (res: Parameters<RequestListener>[1], chunks: object[]) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(''));
};

const promptOf = (handle: (prompt: string, res: Parameters<RequestListener>[1]) => void): RequestListener => (req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk));
  req.on('end', () => handle((JSON.parse(body) as { prompt: string }).prompt, res));
};

const fimServer = createServer(
  promptOf((prompt, res) => {
    fimPrompts.push(prompt);
    sse(res, [
      { content: 'a + ', stop: false },
      { content: 'b;', stop: false },
      { content: '', stop: true, model: 'fake-fim', tokens_evaluated: 40 },
    ]);
  }),
);

/** Plays Zeta: rewrites the editable region so the call to the renamed function follows the rename. */
const nextEditServer = createServer(
  promptOf((prompt, res) => {
    nextEditPrompts.push(prompt);
    const region = /<\|marker_1\|>([\s\S]*)<\|marker_2\|>/.exec(prompt)?.[1] ?? '';
    const rewritten = region.replace('<|user_cursor|>', '').replace('return total(items)', 'return sumOf(items)');
    sse(res, [
      { content: '<|marker_1|>', stop: false },
      { content: `${rewritten}<|marker_2|>`, stop: false },
      { content: '', stop: true, model: 'fake-zeta', tokens_evaluated: 120 },
    ]);
  }),
);

const listen = (server: Server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));
const portOf = (server: Server) => (server.address() as AddressInfo).port;

beforeAll(async () => {
  await Promise.all([listen(fimServer), listen(nextEditServer)]);
});

afterAll(() => Promise.all([close(fimServer), close(nextEditServer)]));

async function events(home: string) {
  return (await readFile(path.join(home, 'tab-events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

describe('Tab in VS Code', () => {
  it('shows ghost text from the completion server, accepts it, and logs both', async () => {
    const { home, suite, launchArgs } = await setUp(
      'index',
      { 'math.ts': 'export function add(a: number, b: number): number {\n  return \n}\n' },
      { 'gcode.tab.endpoint': `http://127.0.0.1:${portOf(fimServer)}`, 'gcode.tab.debounceMs': 10 },
    );
    const code = await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: suite,
      cachePath,
      launchArgs,
      extensionTestsEnv: { GCODE_HOME: home },
    });
    expect(code).toBe(0);

    const log = await events(home);
    const shown = log.find((e) => e.kind === 'request' && e.request.outcome.kind === 'shown');
    expect(shown.request).toMatchObject({ kind: 'fim', model: 'fake-fim', source: 'model', text: COMPLETION });
    expect(log).toContainEqual(expect.objectContaining({ kind: 'outcome', id: shown.request.id, outcome: { kind: 'accepted' } }));
    expect(fimPrompts[0]).toContain('<|file_sep|>math.ts\n<|fim_prefix|>export function add');
    expect(fimPrompts[0]).toMatch(/<\|fim_suffix\|>\n}\n<\|fim_middle\|>$/);
  }, 600_000);

  it('offers an off-cursor inline edit from the edit history in VS Code Insiders, and applies it where predicted', async () => {
    const text = [
      'export function total(items: number[]): number {',
      '  let sum = 0;',
      '  for (const item of items) sum += item;',
      '  return sum;',
      '}',
      'export function average(items: number[]): number {',
      '  return total(items) / items.length;',
      '}',
      '',
    ].join('\n');
    const { home, suite, launchArgs } = await setUp('next-edit', { 'stats.ts': text }, {
      'gcode.tab.nextEdit': true,
      'gcode.tab.nextEditEndpoint': `http://127.0.0.1:${portOf(nextEditServer)}`,
      'gcode.tab.endpoint': `http://127.0.0.1:${portOf(fimServer)}`,
      'gcode.tab.debounceMs': 10,
    });
    const code = await runTests({
      version: 'insiders',
      extensionDevelopmentPath: root,
      extensionTestsPath: suite,
      cachePath,
      launchArgs: [...launchArgs, `--enable-proposed-api=${EXTENSION_ID}`],
      extensionTestsEnv: { GCODE_HOME: home },
    });
    expect(code).toBe(0);

    const log = await events(home);
    const call = text.indexOf('total(items)');
    const atCall = { model: 'fake-zeta', text: 'sumOf', edit: { start: call, end: call + 'total'.length, text: 'sumOf' } };
    const first = log.find((e) => e.kind === 'request' && e.request.kind === 'next-edit' && e.request.outcome.kind === 'shown');
    expect(first.request).toMatchObject(atCall);
    expect(first.request.offset).toBeLessThan(text.indexOf('\n'));
    const accepted = log.filter((e) => e.kind === 'outcome' && e.outcome.kind === 'accepted').map((e) => e.id);
    const requests = log.filter((e) => e.kind === 'request' && accepted.includes(e.request.id)).map((e) => e.request);
    expect(requests).toEqual([expect.objectContaining({ kind: 'next-edit', ...atCall })]);
    const prompt = nextEditPrompts.find((p) => p.includes('<filename>edit_history'))!;
    expect(prompt).toContain('--- a/stats.ts\n+++ b/stats.ts\n@@ -1,4 +1,4 @@\n-export function total(items: number[]): number {\n+export function sumOf(items: number[]): number {\n');
    expect(prompt.startsWith('<[begin▁of▁sentence]><[fim-suffix]>')).toBe(true);
  }, 900_000);
});
