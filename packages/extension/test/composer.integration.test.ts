import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, loadTools, sseBody, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { setUp } from './launch.js';
import { capturePanel, resizeSideBar } from './media.js';
import { captureWindow } from './screenshot.js';
import { leaseWindow } from './pool/client.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
// The pinned server from the engine's devDependency, so the test needs no download.
const SERVER_BIN = path.join(path.dirname(createRequire(path.resolve('packages/engine/package.json')).resolve('chrome-devtools-mcp/package.json')), 'build', 'src', 'bin', 'chrome-devtools-mcp.js');

const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

/** A reply the fake holds back until the suite asks for it, so the turn stays running for as long as the suite needs. */
type Held = Reply & { readonly held?: true };

let pageUrl = '';
const replies = (): readonly Held[] => [
  asModel(toolCall('Loading the browser tool.', [loadTools('mcp__browser__new_page')], usage)),
  asModel(toolCall('Opening the page.', [{ id: 'tu_open', name: 'mcp__browser__new_page', input: { url: pageUrl } }], usage)),
  asModel(answer('The page is open.', usage)),
  asModel(toolCall('Reading.', [{ id: 'tu_read', name: 'read', input: { path: 'a.ts' } }], usage)),
  { ...asModel(answer('It exports one constant.', usage)), held: true },
  asModel(answer('It exports one constant. It exports one constant.', usage)),
  { ...asModel(answer('Once upon a time there was a very long essay that never ended.', usage)), stallAfter: 8 },
];

const requests: { messages: unknown[]; output_config?: unknown }[] = [];
const shots = process.env['GCODE_SCREENSHOTS'];
let debugPort = 0;
let window: Window | undefined;
let release: () => void = () => {};
const released = new Promise<void>((resolve) => (release = resolve));

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const READY = '.transcript';

const UI: Readonly<Record<string, (action: any, window: Window) => Promise<unknown>>> = {
  eval: async ({ expression }, w) => evaluate(await webview(w, EXTENSION, READY), expression),
  click: async ({ selector, text }, w) => click(await webview(w, EXTENSION, READY), selector, text),
  type: async ({ text }, w) => typeText(await webview(w, EXTENSION, READY), text),
  press: async ({ key, modifiers }, w) => press(await webview(w, EXTENSION, READY), key, modifiers),
  pointerAway: async (_action, w) => w.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 300 }),
  release: async () => release(),
  resize: async ({ width }, w) => resizeSideBar(w, width),
  screenshot: async ({ name }, w) => {
    if (shots === undefined) return;
    await captureWindow(debugPort, path.resolve(shots, `${name}.png`));
    await capturePanel(w, path.resolve(shots, `${name}-panel.png`), 2);
  },
};

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  'POST /v1/messages': async (req, res) => {
    const reply = replies()[requests.push(JSON.parse(await bodyOf(req))) - 1];
    if (reply === undefined) {
      res.writeHead(500).end(`no reply for request ${requests.length - 1}`);
      return;
    }
    if (reply.held) await released;
    if (reply.stallAfter === undefined) {
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseBody(reply));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' }).write(sseBody({ events: reply.events.slice(0, reply.stallAfter) }));
    // Held open until the engine aborts the request.
    await new Promise((resolve) => res.on('close', resolve));
  },
  'GET /page': async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Fixture</title><h1>Dev server</h1>');
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

describe('the composer in VS Code', () => {
  it('drives its tray, +, /, mode, model and effort menu, context ring, running status, queue and the IME guard', async () => {
    const { workspace, work, home, suite } = await setUp(
      'composer',
      { 'a.ts': 'export const a = 1;\n', 'notes.md': '# Notes\n' },
      { 'gcode.approvalMode': 'auto', 'gcode.chat.detail': 'full', 'chat.mcp.enabled': false },
      { 'gcode.browser.enabled': true },
    );
    if (shots !== undefined) await mkdir(shots, { recursive: true });
    const vscodeWindow = await leaseWindow();
    debugPort = vscodeWindow.debugPort;
    const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    pageUrl = `${url}/page`;

    await vscodeWindow.run(suite, { workspace, work }, {
      GCODE_HOME: home,
      GCODE_PROVIDER: 'modelstudio',
      GCODE_MODEL: MODEL,
      DASHSCOPE_API_KEY: 'sk-fake',
      DASHSCOPE_BASE_URL: url,
      GCODE_FAKE_MODEL: url,
      GCODE_CLASSIFIER_MODEL: 'off',
      GCODE_BROWSER_SERVER_BIN: SERVER_BIN,
      GCODE_PAGE_HOST: `127.0.0.1:${(fake.address() as AddressInfo).port}`,
    });
    expect(requests).toHaveLength(replies().length);
    // The effort chosen in the composer's menu reaches the model from the next call.
    expect(requests.map((r) => (r.output_config as { effort?: string } | undefined)?.effort)).toEqual(['high', 'high', 'high', 'high', 'high', 'high', 'high']);
  }, 600_000);
});
