import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, loadTools, sseBody, toolCall, type FakeToolUse, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { setUp } from './launch.js';
import { capturePanel, resizeSideBar } from './media.js';
import { captureWindow, freePort } from './screenshot.js';
import { leaseWindow } from './pool/client.js';
import { ANSWER, CONSOLE_ERROR, SERVER_ERROR, URL_ENV } from './suite/preview-fixture.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const SERVER_BIN = path.join(path.dirname(createRequire(path.resolve('packages/engine/package.json')).resolve('chrome-devtools-mcp/package.json')), 'build', 'src', 'bin', 'chrome-devtools-mcp.js');
const FAKE_DEV_SERVER = readFileSync(path.resolve('packages/engine/test/fixtures/fake-dev-server.mjs'), 'utf8');

const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

let devUrl = '';
const call = (id: string, name: string, input: unknown): FakeToolUse => ({ id, name, input });
const replies = (): readonly Reply[] => [
  asModel(toolCall('Loading the tools.', [loadTools('preview_start', 'preview_logs', 'mcp__browser__new_page', 'mcp__browser__take_screenshot', 'mcp__browser__list_console_messages')], usage)),
  asModel(toolCall('Starting the dev server.', [call('tu_preview_start', 'preview_start', { name: 'web' })], usage)),
  asModel(toolCall('Opening the page.', [call('tu_open', 'mcp__browser__new_page', { url: `${devUrl}/` })], usage)),
  asModel(toolCall('Taking a look.', [call('tu_shot', 'mcp__browser__take_screenshot', { pageId: 2 })], usage)),
  asModel(toolCall('Reading the console.', [call('tu_console', 'mcp__browser__list_console_messages', { pageId: 2, types: ['error'] })], usage)),
  asModel(toolCall('Reading the server errors.', [call('tu_logs', 'preview_logs', { name: 'web', level: 'error' })], usage)),
  asModel(answer(ANSWER, usage)),
];

type Block = { type: string; tool_use_id?: string; content?: string | { type: string; text?: string }[] };
type Body = { messages: { role: string; content: string | Block[] }[] };
const requests: Body[] = [];
const shots = process.env['GCODE_SCREENSHOTS'];
let debugPort = 0;
let window: Window | undefined;

/** A tool result's text and whether it holds an image, in the request after the call. */
function resultOf(body: Body, id: string): { readonly text: string; readonly image: boolean } {
  const content = body.messages.at(-1)!.content;
  const block = typeof content === 'string' ? undefined : content.find((b) => b.tool_use_id === id);
  const parts = typeof block?.content === 'string' ? [{ type: 'text', text: block.content }] : (block?.content ?? []);
  return { text: parts.map((p) => p.text ?? '').join('\n'), image: parts.some((p) => p.type === 'image') };
}

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
    if (reply === undefined) res.writeHead(500).end(`no reply for request ${requests.length - 1}`);
    else res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseBody(reply));
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

// The Linux sandbox gives each command its own network namespace, so there neither the engine nor Chrome reaches the server.
describe.runIf(process.platform === 'darwin')('the dev server preview in the panel', () => {
  it('starts the server from the launch file, opens and screenshots its page in the browser, surfaces its console and server errors, and stops from Tasks', async () => {
    const port = await freePort();
    devUrl = `http://localhost:${port}`;
    const files = {
      'server.mjs': FAKE_DEV_SERVER,
      '.claude/launch.json': JSON.stringify({ version: '0.0.1', configurations: [{ name: 'web', runtimeExecutable: 'node', runtimeArgs: ['server.mjs'], port }] }, null, 2),
    };
    const { workspace, work, home, suite } = await setUp('preview', files, { 'gcode.approvalMode': 'ask', 'gcode.chat.detail': 'full', 'gcode.browser.enabled': true, 'chat.mcp.enabled': false });
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
      GCODE_BROWSER_SERVER_BIN: SERVER_BIN,
      [URL_ENV]: devUrl,
    });
    expect(requests).toHaveLength(replies().length);
    expect(resultOf(requests[2]!, 'tu_preview_start').text).toMatch(
      new RegExp(`^Started dev server "web" \\(\`node server\\.mjs\`\\) as bg-1\\. It answers at ${devUrl}\\. GET ${devUrl}/ returned 200, titled "Fake app"\\.`),
    );
    expect(resultOf(requests[4]!, 'tu_shot').image).toBe(true);
    expect(resultOf(requests[5]!, 'tu_console').text).toContain(CONSOLE_ERROR);
    const logs = resultOf(requests[6]!, 'tu_logs').text;
    expect(logs).toContain(SERVER_ERROR);
    expect(logs).not.toContain('ready on');
  }, 900_000);
});
