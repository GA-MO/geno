import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { build, type BuildOptions } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Vitest runs from the repository root.
const root = path.resolve('packages/extension');
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

const common: BuildOptions = { bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] };

/** A workspace with one file and settings, a fresh GCODE_HOME, and the extension and the named suite built. */
async function setUp(suiteName: string, file: string, text: string, settings: Record<string, unknown>) {
  const work = await mkdtemp(path.join(tmpdir(), 'gcode-ext-'));
  const workspace = path.join(work, 'workspace');
  const home = path.join(work, 'home');
  await mkdir(path.join(workspace, '.vscode'), { recursive: true });
  await writeFile(path.join(workspace, file), text);
  const quiet = {
    // VS Code's chat panel otherwise opens at startup and takes keyboard focus from the editor under test.
    'chat.disableAIFeatures': true,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
  };
  await writeFile(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({ ...quiet, ...settings }));
  await build({ ...common, entryPoints: [path.join(root, 'src/extension.ts')], outfile: path.join(root, 'dist/extension.js') });
  const suite = path.join(work, 'suite.js');
  await build({ ...common, entryPoints: [path.join(root, `test/suite/${suiteName}.ts`)], outfile: suite });
  // A user-data dir under the repo makes VS Code's IPC socket path longer than macOS allows.
  const launchArgs = [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${work}/ud`];
  return { home, suite, launchArgs };
}

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
      'math.ts',
      'export function add(a: number, b: number): number {\n  return \n}\n',
      { 'gcode.tab.endpoint': `http://127.0.0.1:${portOf(fimServer)}`, 'gcode.tab.debounceMs': 10 },
    );
    const code = await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: suite,
      cachePath: path.resolve(root, '../../.vscode-test'),
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
    const { home, suite, launchArgs } = await setUp('next-edit', 'stats.ts', text, {
      'gcode.tab.nextEdit': true,
      'gcode.tab.nextEditEndpoint': `http://127.0.0.1:${portOf(nextEditServer)}`,
      'gcode.tab.endpoint': `http://127.0.0.1:${portOf(fimServer)}`,
      'gcode.tab.debounceMs': 10,
    });
    const code = await runTests({
      version: 'insiders',
      extensionDevelopmentPath: root,
      extensionTestsPath: suite,
      cachePath: path.resolve(root, '../../.vscode-test'),
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
