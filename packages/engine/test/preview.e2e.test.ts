import { readFileSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { answers } from '../src/preview.js';
import { answer, fakeTransport, loadTools, toolCall, type FakeToolUse } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand, runCli } from './helpers.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const SERVER = readFileSync(path.join(import.meta.dirname, 'fixtures', 'fake-dev-server.mjs'), 'utf8');

let nextId = 0;
const use = (name: string, input: unknown): FakeToolUse => ({ id: `tu_preview_${nextId++}`, name, input });

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

const launch = (configurations: unknown[]) => JSON.stringify({ version: '0.0.1', configurations });

async function setup(files: Record<string, string>) {
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files }]));
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-home-')));
  const env = { GCODE_HOME: home, GCODE_PROVIDER: 'modelstudio', DASHSCOPE_API_KEY: 'sk-fake', DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic', GCODE_RG: rgCommand(), PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
  return { workspace, env };
}

type Body = { messages: { role: string; content: { type: string; content?: string; tool_use_id?: string; is_error?: boolean }[] }[] };
const resultOf = (body: Body, id: string) => body.messages.at(-1)!.content.find((block) => block.tool_use_id === id)!;

async function run(workspace: string, env: Record<string, string>, steps: readonly (readonly FakeToolUse[])[], between?: (request: number) => Promise<void>) {
  const transport = fakeTransport([...steps.map((uses, i) => toolCall(`Step ${i}.`, uses, usage)), answer('Done.', usage)]);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    await between?.(transport.requests.length);
    return transport.fetch(input, init);
  };
  const result = await runCli(['agent', '--workspace', workspace, '--non-interactive', 'Check the app'], env, { fetch });
  expect(result.code).toBe(0);
  const bodies = transport.requests.map((r) => r.body as Body);
  return (use: FakeToolUse) => resultOf(bodies.find((body) => body.messages.at(-1)!.content.some((block) => block.tool_use_id === use.id))!, use.id);
}

// Linux sandboxes give each command its own network namespace, so there the engine cannot reach a server a command started.
describe.runIf(process.platform === 'darwin')('the dev server preview in a run', () => {
  it('starts the server from the launch file, reuses it, reads its errors, refuses names it does not know, and stops it', async () => {
    const port = await freePort();
    const url = `http://localhost:${port}`;
    const { workspace, env } = await setup({
      'server.mjs': SERVER,
      '.claude/launch.json': launch([{ name: 'web', runtimeExecutable: 'node', runtimeArgs: ['server.mjs'], port }]),
    });
    const start = use('preview_start', { name: 'web' });
    const again = use('preview_start', { name: 'web' });
    const errors = use('preview_logs', { name: 'web', level: 'error' });
    const requests = use('preview_logs', { search: 'get /' });
    const unknown = use('preview_start', { name: 'admin' });
    const stranger = use('preview_stop', { name: 'admin' });
    const stop = use('preview_stop', { name: 'web' });
    const list = use('preview_list', {});
    let answeredWhileRunning = false;
    const resultOfUse = await run(
      workspace,
      env,
      [[loadTools('preview_start', 'preview_logs', 'preview_stop', 'preview_list')], [start], [again], [errors, requests], [unknown, stranger], [stop], [list]],
      async (request) => {
        if (request === 3) answeredWhileRunning = await answers(url);
      },
    );

    expect(resultOfUse(start).content).toMatch(
      new RegExp(`^Started dev server "web" \\(\`node server\\.mjs\`\\) as bg-1\\. It answers at ${url}\\. GET ${url}/ returned 200, titled "Fake app"\\. To see it, open ${url} with the browser tool mcp__browser__new_page`),
    );
    expect(resultOfUse(again).content).toMatch(/^The dev server "web" \(`node server\.mjs`\) already runs in this session as bg-1\. It answers/);
    expect(answeredWhileRunning).toBe(true);

    const errorLines = resultOfUse(errors).content!;
    expect(errorLines).toContain('Error: failed to load posts from the fake CMS');
    expect(errorLines).not.toContain('GET /');
    // The first GET was preview_start's own check of the page, and the reuse checked it again.
    expect(resultOfUse(requests).content).toMatch(/2 of its \d+ kept lines match "get \/":\nGET \/\nGET \/$/);

    expect(resultOfUse(unknown)).toMatchObject({ is_error: true, content: 'No launch entry is named "admin" in .claude/launch.json. Its entries: web.' });
    expect(resultOfUse(stranger)).toMatchObject({ is_error: true });
    expect(resultOfUse(stranger).content).toMatch(/^No dev server named "admin" was started in this session; Geno stops and reads only the servers it started\. Started here: web\./);

    expect(resultOfUse(stop).content).toBe('Stopped the dev server "web" (bg-1): it was stopped.');
    expect(await answers(url)).toBe(false);
    expect(resultOfUse(list).content).toBe(
      ['Launch entries (.claude/launch.json):', `- web: \`node server.mjs\`, ${url}`, 'Dev servers this session started:', '- web (bg-1, `node server.mjs`): was stopped'].join('\n'),
    );
  }, 60_000);

  it('reports a server that dies before it answers with the end of its output', async () => {
    const port = await freePort();
    const { workspace, env } = await setup({ '.claude/launch.json': launch([{ name: 'web', runtimeExecutable: 'node', runtimeArgs: ['-e', 'console.error("Error: Cannot find module next"); process.exit(1)'], port }]) });
    const start = use('preview_start', {});
    const resultOfUse = await run(workspace, env, [[loadTools('preview_start')], [start]]);
    const text = resultOfUse(start).content!;
    expect(text).toMatch(/^Started dev server "web" \(`node -e 'console\.error\("Error: Cannot find module next"\); process\.exit\(1\)'`\) as bg-1\. It exited with code 1 before it answered/);
    expect(text).toContain('The end of its output:\nError: Cannot find module next');
  }, 60_000);
});

describe('the dev server preview without a usable launch file', () => {
  it('explains the launch file with an entry from the dev script, and judges an entry\'s command as bash would', async () => {
    const port = await freePort();
    const bare = await setup({ 'package.json': JSON.stringify({ scripts: { dev: 'next dev' } }), 'pnpm-lock.yaml': '' });
    const missing = use('preview_start', {});
    const missingResult = (await run(bare.workspace, bare.env, [[loadTools('preview_start')], [missing]]))(missing);
    expect(missingResult.is_error).toBe(true);
    expect(missingResult.content).toMatch(/^This workspace has no launch file: neither \.g-code\/launch\.json nor \.claude\/launch\.json exists\. Create \.claude\/launch\.json with edit/);
    expect(missingResult.content).toContain('"runtimeExecutable": "pnpm",\n      "runtimeArgs": [\n        "dev"\n      ]');

    const flagged = await setup({ '.g-code/launch.json': launch([{ name: 'web', runtimeExecutable: 'curl', runtimeArgs: ['https://example.com'], port }, { name: 'bad', port: 'x' }]) });
    const start = use('preview_start', { name: 'web' });
    const list = use('preview_list', {});
    const resultOfUse = await run(flagged.workspace, flagged.env, [[loadTools('preview_start', 'preview_list')], [start], [list]]);
    expect(resultOfUse(start).content).toMatch(/^denied: `curl https:\/\/example\.com` uses curl or wget/);
    expect(resultOfUse(list).content).toContain('Left out:\n- .g-code/launch.json: configurations[1]: runtimeExecutable: ');
    expect(resultOfUse(list).content).toContain('No dev server was started in this session.');
  }, 60_000);
});
