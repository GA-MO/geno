import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, sseBody, toolCall, type FakeToolUse, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { cachePath, root, setUp } from './launch.js';
import { captureWindow, freePort } from './screenshot.js';
import { ANSWER, EDITS, FILES, TOOL_IDS } from './suite/panel-fixture.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

/** The fake transport's answers name another model; the panel's footer should show the one configured. */
const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

const tool = (id: string, name: string, input: unknown): FakeToolUse => ({ id, name, input });
/** Message start, a thinking block and the first two text chunks, then nothing until the turn is stopped. */
const stalled = (): Reply => ({ ...asModel(answer('Once upon a time there was a very long essay that never ended.', usage)), stallAfter: 8 });

const replies: readonly Reply[] = [
  toolCall(
    'Let me look at the code first.',
    [
      tool(TOOL_IDS.grep, 'grep', { pattern: 'greeting|double' }),
      tool(TOOL_IDS.read, 'read', { path: 'a.ts' }),
      tool(TOOL_IDS.readB, 'read', { path: 'b.ts' }),
      tool(TOOL_IDS.readC, 'read', { path: 'c.ts' }),
    ],
    usage,
  ),
  toolCall('Making the three edits.', [tool(TOOL_IDS.editA, 'edit', EDITS.addOrder), tool(TOOL_IDS.editB, 'edit', EDITS.greeting), tool(TOOL_IDS.editC, 'edit', EDITS.double)], usage),
  asModel(answer(ANSWER, usage)),
  toolCall('Removing the build output.', [tool('tu_rm_1', 'bash', { command: 'rm -rf build' })], usage),
  toolCall('Removing it.', [tool('tu_rm_2', 'bash', { command: 'rm -rf build' })], usage),
  asModel(answer('Removed `build`.', usage)),
  stalled(),
  stalled(),
];

const requests: unknown[] = [];
const shots = process.env['GCODE_SCREENSHOTS'];
let debugPort = 0;
let window: Window | undefined;

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

/** The panel's document is ready once its transcript element exists. */
const READY = '.transcript';

/** What the suite inside VS Code can ask this process to do to the window. */
const UI: Readonly<Record<string, (action: any, window: Window) => Promise<unknown>>> = {
  eval: async ({ expression }, w) => evaluate(await webview(w, EXTENSION, READY), expression),
  evalPage: async ({ expression }, w) => (await w.page.send('Runtime.evaluate', { expression, returnByValue: true })).result.value,
  click: async ({ selector, text }, w) => click(await webview(w, EXTENSION, READY), selector, text),
  type: async ({ text }, w) => typeText(await webview(w, EXTENSION, READY), text),
  press: async ({ key, modifiers }, w) => press(await webview(w, EXTENSION, READY), key, modifiers),
  motion: async ({ value }, w) =>
    (await webview(w, EXTENSION, READY)).send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] }),
  screenshot: async ({ name }) => {
    if (shots !== undefined) await captureWindow(debugPort, path.resolve(shots, `${name}.png`));
  },
};

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  'POST /v1/messages': async (req, res) => {
    const reply = replies[requests.push(JSON.parse(await bodyOf(req))) - 1];
    if (reply === undefined) {
      res.writeHead(500).end(`no reply for request ${requests.length - 1}`);
      return;
    }
    if (reply.stallAfter === undefined) {
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseBody(reply));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' }).write(sseBody({ events: reply.events.slice(0, reply.stallAfter) }));
    // Held open until the engine aborts the request.
    await new Promise((resolve) => res.on('close', resolve));
  },
  'POST /ui': async (req, res) => {
    const action = JSON.parse(await bodyOf(req)) as { do: string };
    try {
      window ??= await connectWindow(debugPort);
      const result = await UI[action.do]!(action, window);
      res.writeHead(200, { 'content-type': 'application/json' }).end(result === undefined ? '' : JSON.stringify(result));
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  },
};

const fake = createServer((req, res) => {
  const route = ROUTES[`${req.method} ${req.url?.split('?')[0]}`];
  if (route === undefined) res.writeHead(404).end();
  else void route(req, res);
});

beforeAll(() => new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve)));
afterAll(() => {
  window?.browser.close();
  return new Promise<void>((resolve) => fake.close(() => resolve()));
});

describe('the chat panel in VS Code', () => {
  it('sends, stops, asks, and keeps and undoes edits through clicks and keys in the real panel', async () => {
    // These assertions open the steps of finished turns, which full detail draws as the panel did before U17.
    const { home, suite, launchArgs } = await setUp('panel', FILES, { 'gcode.chat.detail': 'full', 'gcode.review.mode': 'review' });
    if (shots !== undefined) await mkdir(shots, { recursive: true });
    debugPort = await freePort();
    const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

    const code = await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: suite,
      cachePath,
      ...(process.env['GCODE_VSCODE_VERSION'] ? { version: process.env['GCODE_VSCODE_VERSION'] } : {}),
      launchArgs: [...launchArgs, `--remote-debugging-port=${debugPort}`],
      extensionTestsEnv: {
        GCODE_HOME: home,
        GCODE_PROVIDER: 'modelstudio',
        GCODE_MODEL: MODEL,
        DASHSCOPE_API_KEY: 'sk-fake',
        DASHSCOPE_BASE_URL: url,
        GCODE_FAKE_MODEL: url,
      },
    });
    expect(code).toBe(0);
    expect(requests).toHaveLength(replies.length);
  }, 600_000);
});
