import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { setUp } from './launch.js';
import { capturePanel } from './media.js';
import { captureWindow } from './screenshot.js';
import { leaseWindow } from './pool/client.js';
import { IDLE_LIMIT_MS, FIRST_BYTE_LIMIT_MS } from './suite/stall-fixture.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

const sse = (event: Record<string, unknown>) => `event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ANSWER = asModel(answer('Here is the maze.', usage));
const [messageStart, thinkingStart] = ANSWER.events;

const shots = process.env['GCODE_SCREENSHOTS'];
const calls: number[] = [];
let debugPort = 0;
let failure: string | undefined;
let window: Window | undefined;
let release: () => void = () => {};
const released = new Promise<void>((resolve) => (release = resolve));

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

/** Thinks for 2 s, a delta every 200 ms, then sends nothing more while the connection stays open. */
async function thinkThenGoQuiet(res: ServerResponse): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(sse(messageStart!) + sse(thinkingStart!));
  for (let i = 0; i < 10 && !res.closed; i++) {
    await sleep(200);
    res.write(sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Laying out the maze, tile by tile. '.repeat(4) } }));
  }
}

const READY = '.transcript';

const UI: Readonly<Record<string, (action: any, window: Window) => Promise<unknown>>> = {
  eval: async ({ expression }, w) => evaluate(await webview(w, EXTENSION, READY), expression),
  click: async ({ selector, text }, w) => click(await webview(w, EXTENSION, READY), selector, text),
  type: async ({ text }, w) => typeText(await webview(w, EXTENSION, READY), text),
  press: async ({ key, modifiers }, w) => press(await webview(w, EXTENSION, READY), key, modifiers),
  pointerAway: async (_action, w) => w.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 300 }),
  release: async () => release(),
  screenshot: async ({ name }, w) => {
    if (shots === undefined) return;
    await captureWindow(debugPort, path.resolve(shots, `${name}.png`));
    await capturePanel(w, path.resolve(shots, `${name}-panel.png`), 2);
  },
};

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  'POST /v1/messages': async (req, res) => {
    await bodyOf(req);
    const call = calls.push(Date.now()) - 1;
    // The first try thinks, then goes quiet; the retry gets no answer at all until the suite has seen the row say so.
    if (call === 0) return thinkThenGoQuiet(res);
    if (call === 1) await released;
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(ANSWER.events.map(sse).join(''));
  },
  'POST /fail': async (req, res) => {
    failure = await bodyOf(req);
    console.error(`suite failed: ${failure}`);
    res.writeHead(200).end();
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
  fake.closeAllConnections();
  return new Promise<void>((resolve) => fake.close(() => resolve()));
});

describe('a model call that goes quiet, in VS Code', () => {
  it('counts the thinking on the working row, retries the quiet try, and says when the retry has had no response', async () => {
    const { workspace, work, home, suite } = await setUp('stall', { 'a.ts': 'export const a = 1;\n' }, { 'chat.mcp.enabled': false });
    if (shots !== undefined) await mkdir(shots, { recursive: true });
    const vscodeWindow = await leaseWindow();
    debugPort = vscodeWindow.debugPort;
    const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

    await vscodeWindow.run(suite, { workspace, work }, {
      GCODE_HOME: home,
      GCODE_PROVIDER: 'modelstudio',
      GCODE_MODEL: MODEL,
      DASHSCOPE_API_KEY: 'sk-fake',
      DASHSCOPE_BASE_URL: url,
      GCODE_FAKE_MODEL: url,
      GCODE_CLASSIFIER_MODEL: 'off',
      GCODE_STREAM_FIRST_BYTE_TIMEOUT_MS: String(FIRST_BYTE_LIMIT_MS),
      GCODE_STREAM_IDLE_TIMEOUT_MS: String(IDLE_LIMIT_MS),
    });
    expect(failure).toBeUndefined();
    expect(calls, 'the quiet try, then its one retry').toHaveLength(2);
  }, 600_000);
});
