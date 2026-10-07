import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { cachePath, root, setUp } from './launch.js';
import { freePort } from './screenshot.js';
import { BAD_REQUEST, MARKERS } from './suite/turn-end-fixture.js';

const EXTENSION = 'g-code.g-code';
const READY = '.transcript';

let debugPort = 0;
let window: Window | undefined;
const asked: Record<string, number> = {};
let release: () => void = () => {};
/** The away turn's model call waits until the suite has left its chat. */
const held = new Promise<void>((resolve) => (release = resolve));

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const UI: Readonly<Record<string, (action: any, window: Window) => Promise<unknown>>> = {
  eval: async ({ expression }, w) => evaluate(await webview(w, EXTENSION, READY), expression),
  workbench: async ({ expression }, w) =>
    (await w.page.send<{ result: { value: unknown } }>('Runtime.evaluate', { expression, returnByValue: true })).result.value,
  click: async ({ selector, text }, w) => click(await webview(w, EXTENSION, READY), selector, text),
  type: async ({ text }, w) => typeText(await webview(w, EXTENSION, READY), text),
  press: async ({ key, modifiers }, w) => press(await webview(w, EXTENSION, READY), key, modifiers),
  asked: async ({ marker }) => asked[marker] ?? 0,
  release: async () => release(),
};

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse, body: string) => Promise<void>> = {
  'POST /v1/messages': async (_req, res, body) => {
    const marker = Object.values(MARKERS).find((m) => body.includes(m)) ?? 'none';
    asked[marker] = (asked[marker] ?? 0) + 1;
    if (marker === MARKERS.away) await held;
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: BAD_REQUEST } }));
  },
  'POST /ui': async (_req, res, body) => {
    try {
      window ??= await connectWindow(debugPort);
      const action = JSON.parse(body) as { do: string };
      const result = await UI[action.do]!(action, window);
      res.writeHead(200, { 'content-type': 'application/json' }).end(result === undefined ? '' : JSON.stringify(result));
    } catch (error) {
      res.writeHead(500).end(String(error));
    }
  },
};

const fake = createServer((req, res) => {
  void bodyOf(req).then((body) => {
    const route = ROUTES[`${req.method} ${req.url?.split('?')[0]}`];
    if (route === undefined) res.writeHead(404).end();
    else void route(req, res, body);
  });
});

beforeAll(() => new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve)));
afterAll(() => {
  window?.browser.close();
  fake.closeAllConnections();
  return new Promise<void>((resolve) => fake.close(() => resolve()));
});

describe('a turn that ends on a model error', () => {
  it('shows Failed in the panel, and VS Code says it failed and lists it under Needs you, though ACP stops it with end_turn', async () => {
    const { home, suite, launchArgs } = await setUp('turn-end', { 'a.ts': 'export const a = 1;\n' }, { 'chat.mcp.enabled': false });
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
        GCODE_MODEL: 'qwen3.8-flash',
        DASHSCOPE_API_KEY: 'sk-fake',
        DASHSCOPE_BASE_URL: url,
        GCODE_FAKE_MODEL: url,
        GCODE_CLASSIFIER_MODEL: 'off',
      },
    });
    expect(code).toBe(0);
    expect(asked, 'each turn made one model call, and the 400 was not retried').toEqual({ [MARKERS.watched]: 1, [MARKERS.away]: 1 });
  }, 600_000);
});
