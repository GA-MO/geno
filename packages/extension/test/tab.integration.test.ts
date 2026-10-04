import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { build, type BuildOptions } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Vitest runs from the repository root.
const root = path.resolve('packages/extension');
const COMPLETION = 'a + b;';

let server: Server;
const prompts: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk));
    req.on('end', () => {
      prompts.push((JSON.parse(body) as { prompt: string }).prompt);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const content of ['a + ', 'b;']) res.write(`data: ${JSON.stringify({ content, stop: false })}\n\n`);
      res.end(`data: ${JSON.stringify({ content: '', stop: true, model: 'fake-fim', tokens_evaluated: 40 })}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('Tab in VS Code', () => {
  it('shows ghost text from the completion server, accepts it, and logs both', async () => {
    const work = await mkdtemp(path.join(tmpdir(), 'gcode-ext-'));
    const workspace = path.join(work, 'workspace');
    const home = path.join(work, 'home');
    await mkdir(path.join(workspace, '.vscode'), { recursive: true });
    await writeFile(path.join(workspace, 'math.ts'), 'export function add(a: number, b: number): number {\n  return \n}\n');
    const { port } = server.address() as AddressInfo;
    await writeFile(
      path.join(workspace, '.vscode', 'settings.json'),
      JSON.stringify({
        'gcode.tab.endpoint': `http://127.0.0.1:${port}`,
        'gcode.tab.debounceMs': 10,
        // VS Code's chat panel otherwise opens at startup and takes keyboard focus from the editor under test.
        'chat.disableAIFeatures': true,
        'workbench.secondarySideBar.defaultVisibility': 'hidden',
      }),
    );

    const common: BuildOptions = { bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] };
    await build({ ...common, entryPoints: [path.join(root, 'src/extension.ts')], outfile: path.join(root, 'dist/extension.js') });
    const suite = path.join(work, 'suite.js');
    await build({ ...common, entryPoints: [path.join(root, 'test/suite/index.ts')], outfile: suite });

    const code = await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: suite,
      cachePath: path.resolve(root, '../../.vscode-test'),
      // A user-data dir under the repo makes VS Code's IPC socket path longer than macOS allows.
      launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${work}/ud`],
      extensionTestsEnv: { GCODE_HOME: home },
    });
    expect(code).toBe(0);

    const events = (await readFile(path.join(home, 'tab-events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const shown = events.find((e) => e.kind === 'request' && e.request.outcome.kind === 'shown');
    expect(shown.request).toMatchObject({ kind: 'fim', model: 'fake-fim', source: 'model', text: COMPLETION });
    expect(events).toContainEqual(expect.objectContaining({ kind: 'outcome', id: shown.request.id, outcome: { kind: 'accepted' } }));
    expect(prompts[0]).toContain('<|file_sep|>math.ts\n<|fim_prefix|>export function add');
    expect(prompts[0]).toMatch(/<\|fim_suffix\|>\n}\n<\|fim_middle\|>$/);
  }, 600_000);
});
