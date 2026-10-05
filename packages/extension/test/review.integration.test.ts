import { mkdir, readdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, sseBody, toolCall, type FakeToolUse, type Reply } from '../../engine/test/fake-transport.js';
import { buildSuite, cachePath, root, setUp } from './launch.js';
import { captureWindow, freePort } from './screenshot.js';
import { EDITS, FILES, INSTRUCTION } from './suite/review-fixture.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
let nextId = 0;
const use = (name: string, input: unknown): FakeToolUse => ({ id: `tu_${nextId++}`, name, input });

const replies: readonly Reply[] = [
  toolCall('Reading.', [use('read', { path: 'a.ts' }), use('read', { path: 'b.ts' })], usage),
  toolCall('Editing.', [use('edit', EDITS.addOrder), use('edit', EDITS.three), use('edit', EDITS.greeting)], usage),
  answer('Swapped the addition, raised three and shortened the greeting.', usage),
  toolCall('Editing.', [use('edit', EDITS.double)], usage),
  answer('It multiplies now.', usage),
];

const requests: any[] = [];
/** Where the suite's screenshots go: GCODE_SCREENSHOTS, a directory, or nowhere. */
const shots = process.env['GCODE_SCREENSHOTS'];
let debugPort = 0;

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  'POST /v1/messages': async (req, res) => {
    const reply = replies[requests.push(JSON.parse(await bodyOf(req))) - 1];
    if (reply === undefined) res.writeHead(500).end(`no reply for request ${requests.length - 1}`);
    else res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseBody(reply));
  },
  'POST /screenshot': async (req, res) => {
    const name = new URL(req.url!, 'http://localhost').searchParams.get('name')!;
    try {
      if (shots !== undefined) await captureWindow(debugPort, path.resolve(shots, `${name}.png`));
      res.end();
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  },
};

const model = createServer((req, res) => {
  const route = ROUTES[`${req.method} ${req.url?.split('?')[0]}`];
  if (route === undefined) res.writeHead(404).end();
  else void route(req, res);
});

beforeAll(() => new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve)));
afterAll(() => new Promise<void>((resolve) => model.close(() => resolve())));

const userText = (index: number): string =>
  requests[index].messages.at(-1).content.flatMap((block: { type: string; text?: string }) => (block.type === 'text' ? [block.text] : [])).join('');

describe('review in VS Code', () => {
  it('keeps and undoes hunks that follow the text, undoes the session, lands Cmd-K as hunks, and restores review after a reload', async () => {
    const { work, home, suite, launchArgs } = await setUp('review', FILES, {});
    if (shots !== undefined) await mkdir(shots, { recursive: true });
    debugPort = await freePort();
    const url = `http://127.0.0.1:${(model.address() as AddressInfo).port}`;
    const launch = (extensionTestsPath: string) =>
      runTests({
        extensionDevelopmentPath: root,
        extensionTestsPath,
        cachePath,
        launchArgs: [...launchArgs, `--remote-debugging-port=${debugPort}`],
        extensionTestsEnv: {
          GCODE_HOME: home,
          GCODE_PROVIDER: 'modelstudio',
          GCODE_MODEL: 'qwen3.8-flash',
          DASHSCOPE_API_KEY: 'sk-fake',
          DASHSCOPE_BASE_URL: url,
          GCODE_FAKE_MODEL: url,
        },
      });

    expect(await launch(suite)).toBe(0);

    expect(requests).toHaveLength(replies.length);
    expect(requests[3].tools.map((tool: { name: string }) => tool.name)).toEqual(['edit']);
    expect(userText(3)).toContain('Change lines 1 to 3 of c.ts');
    expect(userText(3)).toContain(INSTRUCTION);
    const [log] = await readdir(path.join(home, 'sessions'));
    const events = (await readFile(path.join(home, 'sessions', log!), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.filter((e) => e.kind === 'review').map((e) => e.status)).toEqual(['kept', 'undone']);
    expect(events.filter((e) => e.kind === 'restored')).toHaveLength(1);

    // Same workspace, user data and GCODE_HOME: a window reload, as far as the extension can tell.
    expect(await launch(await buildSuite(work, 'review-reload'))).toBe(0);
    expect(requests).toHaveLength(replies.length);
  }, 600_000);
});
