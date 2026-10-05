import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, sseBody, toolCall, type FakeToolUse, type Reply } from '../../engine/test/fake-transport.js';
import { buildEngine, cachePath, root, setUp } from './launch.js';
import { ORIGINAL } from './suite/chat-fixture.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
let nextId = 0;
const use = (name: string, input: unknown): FakeToolUse => ({ id: `tu_${nextId++}`, name, input });

/** Request 5, the second turn's edit, waits for the suite to change the buffer between the read and the write. */
const HELD = 5;
const replies: readonly Reply[] = [
  toolCall('Reading.', [use('read', { path: 'math.ts' })], usage),
  toolCall('Editing.', [use('edit', { path: 'math.ts', old_str: 'unsaved = 1', new_str: 'unsaved = 2' })], usage),
  toolCall('Checking.', [use('check', {})], usage),
  answer('Set it to 2.', usage),
  toolCall('Reading.', [use('read', { path: 'math.ts' })], usage),
  toolCall('Editing.', [use('edit', { path: 'math.ts', old_str: 'unsaved = 2', new_str: 'unsaved = 3' })], usage),
  answer('The file changed; I will read it again.', usage),
];

const requests: any[] = [];
let release: () => void = () => {};
const released = new Promise<void>((resolve) => (release = resolve));

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  'POST /v1/messages': async (req, res) => {
    const index = requests.push(JSON.parse(await bodyOf(req))) - 1;
    if (index === HELD) await released;
    const reply = replies[index];
    if (reply === undefined) {
      res.writeHead(500).end(`no reply for request ${index}`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseBody(reply));
  },
  'GET /held': async (_req, res) => void res.end(requests.length > HELD ? 'yes' : 'no'),
  'POST /go': async (_req, res) => {
    release();
    res.end();
  },
};

const model = createServer((req, res) => {
  const route = ROUTES[`${req.method} ${req.url?.split('?')[0]}`];
  if (route === undefined) res.writeHead(404).end();
  else void route(req, res);
});

beforeAll(() => new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve)));
afterAll(() => new Promise<void>((resolve) => model.close(() => resolve())));

const toolResult = (index: number): { content: string; is_error?: boolean } =>
  requests[index].messages.at(-1).content.find((block: { type: string }) => block.type === 'tool_result');

describe('chat in VS Code', () => {
  it('edits the unsaved buffer, not the disk, and refuses an edit whose buffer changed after the read', async () => {
    const engineCli = await buildEngine();
    const { home, suite, launchArgs } = await setUp('chat', { 'math.ts': ORIGINAL }, { 'gcode.engine.path': engineCli });
    const url = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;

    const code = await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: suite,
      cachePath,
      launchArgs,
      extensionTestsEnv: {
        GCODE_HOME: home,
        GCODE_PROVIDER: 'modelstudio',
        GCODE_MODEL: 'qwen3.8-flash',
        DASHSCOPE_API_KEY: 'sk-fake',
        DASHSCOPE_BASE_URL: url,
        GCODE_FAKE_MODEL: url,
      },
    });
    expect(code).toBe(0);

    expect(requests).toHaveLength(replies.length);
    expect(toolResult(1).content).toContain('export const unsaved = 1;');
    expect(toolResult(3).content).toBe('The editor reports these problems in the files you read or edited:\nmath.ts:2:14 warning: unsaved is never read');
    expect(toolResult(6)).toMatchObject({ is_error: true, content: 'math.ts changed since it was last read; read it again before editing' });
  }, 600_000);
});
