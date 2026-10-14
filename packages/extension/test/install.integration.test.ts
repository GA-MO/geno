import { randomUUID } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Writable } from 'node:stream';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, sseBody, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { BARE_PATH, buildSuite, cachePath, installClean, makeWorkspace } from './launch.js';
import { reserveLaunch } from './pool/client.js';

const KEY = `sk-install-test-${randomUUID()}`;
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const replies: readonly Reply[] = [
  toolCall('Writing it.', [{ id: 'tu_0', name: 'bash', input: { command: 'pwd > proof.txt' } }], usage),
  answer('Done.', usage),
];

const requests: { authorization: string | undefined; body: any }[] = [];
const fimPrompts: string[] = [];

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const sse = (res: ServerResponse, chunks: string) => res.writeHead(200, { 'content-type': 'text/event-stream' }).end(chunks);

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  'POST /v1/messages': async (req, res) => {
    const index = requests.push({ authorization: req.headers.authorization, body: JSON.parse(await bodyOf(req)) }) - 1;
    const reply = replies[index];
    if (reply === undefined) res.writeHead(500).end(`no reply for request ${index}`);
    else sse(res, sseBody(reply));
  },
  'GET /health': async (_req, res) => void res.end('{"status":"ok"}'),
  'POST /completion': async (req, res) => {
    fimPrompts.push((JSON.parse(await bodyOf(req)) as { prompt: string }).prompt);
    const chunks = [{ content: 'a + b;', stop: false }, { content: '', stop: true, model: 'fake-fim', tokens_evaluated: 40 }];
    sse(res, chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(''));
  },
};

const fake = createServer((req, res) => {
  const route = ROUTES[`${req.method} ${req.url?.split('?')[0]}`];
  if (route === undefined) res.writeHead(404).end();
  else void route(req, res);
});

beforeAll(() => new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve)));
afterAll(() => new Promise<void>((resolve) => fake.close(() => resolve())));

/** Every file under `dir` whose bytes contain `needle`. */
async function filesContaining(dir: string, needle: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { recursive: true })) {
    const file = path.join(dir, entry);
    if ((await stat(file)).isFile() && (await readFile(file)).includes(needle)) found.push(file);
  }
  return found;
}

describe('g-code installed from its .vsix', () => {
  it('runs a chat turn and a Tab completion in a clean VS Code with no node on PATH, and never writes the key down', async () => {
    // The packed extension, not the source, in a VS Code of its own.
    await reserveLaunch();
    const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    const { work, workspace, home } = await makeWorkspace(
      { 'add.ts': 'export function add(a: number, b: number): number {\n  return \n}\n' },
      {
        'gcode.provider': 'modelstudio',
        'gcode.model': 'qwen3.8-flash',
        'gcode.tab.endpoint': url,
        'gcode.tab.debounceMs': 10,
      },
      // Geno reads the endpoint, which decides where the key goes, from the user's settings only.
      { 'gcode.baseUrl': url },
    );
    const installed = await installClean(work);
    const suite = await buildSuite(work, 'installed');
    const keyFile = path.join(work, 'key');
    await writeFile(keyFile, KEY, { mode: 0o600 });
    let output = '';
    const capture = (stream: NodeJS.WriteStream) =>
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          output += chunk.toString();
          stream.write(chunk, done);
        },
      });

    const code = await runTests({
      vscodeExecutablePath: installed.executable,
      extensionDevelopmentPath: installed.harness,
      extensionTestsPath: suite,
      cachePath,
      launchArgs: [workspace, ...installed.launchArgs],
      extensionTestsEnv: {
        PATH: BARE_PATH,
        GCODE_HOME: home,
        GCODE_TEST_EXTENSIONS_DIR: installed.extensionsDir,
        GCODE_TEST_KEY_FILE: keyFile,
        DASHSCOPE_API_KEY: '',
        DASHSCOPE_BASE_URL: '',
      },
      stdout: capture(process.stdout),
      stderr: capture(process.stderr),
    });
    expect(code).toBe(0);

    expect(installed.installOutput).toContain("Extension 'g-code.vsix' was successfully installed.");
    expect((await stat(installed.vsix)).size).toBeGreaterThan(0);
    expect(requests.map((r) => r.authorization)).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`]);
    expect(requests[0]!.body.model).toBe('qwen3.8-flash');
    const result = requests[1]!.body.messages.at(-1).content.find((block: { type: string }) => block.type === 'tool_result');
    expect(result.is_error).toBeFalsy();
    expect(path.basename((await readFile(path.join(workspace, 'proof.txt'), 'utf8')).trim()), 'the command ran in the workspace').toBe(path.basename(workspace));
    expect(fimPrompts[0]).toContain('<|fim_prefix|>export function add');

    expect(output).not.toContain(KEY);
    expect(await filesContaining(work, KEY)).toEqual([]);
  }, 600_000);
});
