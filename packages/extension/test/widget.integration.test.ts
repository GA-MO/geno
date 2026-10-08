import { mkdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, loadTools, offeredTools, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { root, setUp } from './launch.js';
import { captureWindow } from './screenshot.js';
import { FILES, GROW, GROW_TITLE, LOADING, SPEED_TITLE } from './suite/widget-fixture.js';
import { clickInWidget, inWidget } from './widget-cdp.js';
import { leaseWindow } from './pool/client.js';

const EXTENSION = 'g-code.g-code';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

const requests: unknown[] = [];
const shots = process.env['GCODE_SCREENSHOTS'];
let debugPort = 0;
let window: Window | undefined;
let replies: Reply[] = [];

/** The first widget's reply streams up to its first half of input, then waits for the suite to let the rest through. */
let release: () => void = () => {};
const held = new Promise<void>((resolve) => (release = resolve));
const HOLD_AFTER = (reply: Reply) => reply.events.findIndex((e) => e.type === 'content_block_delta' && (e['delta'] as { type: string }).type === 'input_json_delta') + 1;

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const sse = (event: { type: string }) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

const PANEL = '.transcript';
const TAB = '.widget-stage';

const UI: Readonly<Record<string, (action: any, window: Window) => Promise<unknown>>> = {
  eval: async ({ expression }, w) => evaluate(await webview(w, EXTENSION, PANEL), expression),
  evalTab: async ({ expression }, w) => evaluate(await webview(w, EXTENSION, TAB), expression),
  click: async ({ selector, text }, w) => click(await webview(w, EXTENSION, PANEL), selector, text),
  type: async ({ text }, w) => typeText(await webview(w, EXTENSION, PANEL), text),
  press: async ({ key, modifiers }, w) => press(await webview(w, EXTENSION, PANEL), key, modifiers),
  widget: async ({ name, expression }, w) => inWidget(w, name, expression),
  /** Clicks inside a widget's frame at an element's center, as the user's pointer would. */
  clickWidget: async ({ name, selector }, w) => clickInWidget(w, name, selector),
  workbench: async ({ expression }, w) => {
    const { result, exceptionDetails } = await w.page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails !== undefined) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  },
  release: async () => release(),

  screenshot: async ({ name }) => {
    if (shots !== undefined) await captureWindow(debugPort, path.resolve(shots, `${name}.png`));
  },
};

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  'POST /v1/messages': async (req, res) => {
    const reply = replies[requests.push(JSON.parse(await bodyOf(req))) - 1];
    if (reply === undefined) return void res.writeHead(500).end(`no reply for request ${requests.length - 1}`);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const hold = requests.length === 2 ? HOLD_AFTER(reply) : reply.events.length;
    for (const event of reply.events.slice(0, hold)) res.write(sse(event));
    if (hold < reply.events.length) {
      await held;
      for (const event of reply.events.slice(hold)) res.write(sse(event));
    }
    res.end();
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

describe('widgets in the chat panel', () => {
  it('shows the loading state while the model writes, draws the widget, sizes it, keeps it across reloads, and offers its actions', async () => {
    const speed = await readFile(path.join(root, 'test/fixtures/widgets/speed-chart.html'), 'utf8');
    replies = [
      toolCall('', [loadTools('show_widget')], usage),
      toolCall('Here is where the time goes.', [{ id: 'tu_speed', name: 'show_widget', input: { title: SPEED_TITLE, loading_messages: [...LOADING], html: speed } }], usage),
      answer('Thinking is the largest part.', usage),
      toolCall('', [{ id: 'tu_grow', name: 'show_widget', input: { title: GROW_TITLE, html: GROW } }], usage),
      answer('Click More rows to grow it.', usage),
    ];
    const { work, home, workspace, suite } = await setUp('widget', FILES, {}, { 'files.simpleDialog.enable': true });
    if (shots !== undefined) await mkdir(shots, { recursive: true });
    const vscodeWindow = await leaseWindow();
    debugPort = vscodeWindow.debugPort;
    const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

    await vscodeWindow.run(suite, { workspace, work }, {
      GCODE_HOME: home,
      GCODE_PROVIDER: 'modelstudio',
      GCODE_MODEL: 'qwen3.8-flash',
      DASHSCOPE_API_KEY: 'sk-fake',
      DASHSCOPE_BASE_URL: url,
      GCODE_FAKE_MODEL: url,
      GCODE_TEST_WORKSPACE: workspace,
    });
    expect(requests).toHaveLength(replies.length);
    const tools = offeredTools(requests[0] as { tools: { name: string }[] });
    expect(tools).toContain('show_widget');
  }, 600_000);
});
