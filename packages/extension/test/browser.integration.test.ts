import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, sseBody, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { cachePath, root, setUp } from './launch.js';
import { captureWindow, freePort } from './screenshot.js';
import { HEADING } from './suite/browser-fixture.js';

const EXTENSION = 'g-code.g-code';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
// The pinned server from the engine's devDependency, so the test needs no download.
const SERVER_BIN = path.join(path.dirname(createRequire(path.resolve('packages/engine/package.json')).resolve('chrome-devtools-mcp/package.json')), 'build', 'src', 'bin', 'chrome-devtools-mcp.js');

const MODEL = 'qwen3.8-flash';
const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

let pageUrl = '';
const replies = (): readonly Reply[] => [
  asModel(toolCall('Opening the page.', [{ id: 'tu_open', name: 'mcp__browser__new_page', input: { url: pageUrl } }], usage)),
  asModel(toolCall('Taking a look.', [{ id: 'tu_shot', name: 'mcp__browser__take_screenshot', input: { pageId: 2 } }], usage)),
  asModel(answer(`The heading says "${HEADING}".`, usage)),
];

const requests: { tools: { name: string }[]; messages: unknown[] }[] = [];
const shots = process.env['GCODE_SCREENSHOTS'];
let debugPort = 0;
let window: Window | undefined;

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
  screenshot: async ({ name }) => {
    if (shots !== undefined) await captureWindow(debugPort, path.resolve(shots, `${name}.png`));
  },
};

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  'POST /v1/messages': async (req, res) => {
    const reply = replies()[requests.push(JSON.parse(await bodyOf(req))) - 1];
    if (reply === undefined) res.writeHead(500).end(`no reply for request ${requests.length - 1}`);
    else res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseBody(reply));
  },
  'GET /page': async (_req, res) => {
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        `<title>Fixture</title><body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:48px;font:bold 96px sans-serif;background:#f4f1ea;color:#1d3557"><h1 style="font-size:120px;text-align:center;margin:0 40px">${HEADING}</h1><button style="font-size:80px;padding:24px 64px">Press me</button></body>`,
      );
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

describe('the browser in the chat panel', () => {
  it('turns on from the MCP pane, starts Chrome at the first browser step, and shows the screenshot as a thumbnail on the rail', async () => {
    const { home, suite, launchArgs } = await setUp('browser', { 'a.ts': 'export const a = 1;\n' }, { 'gcode.approvalMode': 'auto', 'gcode.chat.detail': 'full', 'chat.mcp.enabled': false });
    if (shots !== undefined) await mkdir(shots, { recursive: true });
    debugPort = await freePort();
    const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    pageUrl = `${url}/page`;

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
        GCODE_CLASSIFIER_MODEL: 'off',
        GCODE_BROWSER_SERVER_BIN: SERVER_BIN,
      },
    });
    expect(code).toBe(0);
    expect(requests).toHaveLength(3);
    expect(requests[0]!.tools.map((t) => t.name)).toContain('mcp__browser__new_page');
    expect(JSON.stringify(requests[2]!.messages)).toMatch(/"type":"image","source":\{"type":"base64","media_type":"image\/png"/);
  }, 600_000);
});
