import { mkdir, readdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BreakdownView, SessionSpendView } from '@g-code/core';
import { run as gcode } from '../../engine/src/run.js';
import { answer, sseBody, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { cachePath, root, setUp } from './launch.js';
import { capturePanel, resizeSideBar } from './media.js';
import { captureWindow, freePort } from './screenshot.js';
import { ANSWERS, FILES, MARKER, type ShownRow, type ShownSpend } from './suite/usage-fixture.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';

const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

/** The first turn reads a.ts and answers; the second answers from the cache. */
const SCRIPT: readonly Reply[] = [
  toolCall('Reading a.ts.', [{ id: 'tu_r1', name: 'read', input: { path: 'a.ts' } }], { input: 300, cacheRead: 0, cacheWrite: 5200 }),
  answer(ANSWERS.read, { input: 2600, cacheRead: 5200, cacheWrite: 300 }),
  answer(ANSWERS.again, { input: 40, cacheRead: 8100, cacheWrite: 0 }),
].map(asModel);

type Body = { messages: { role: string; content: unknown }[] };
let requests = 0;
let report: ShownSpend | undefined;
const shots = process.env['GCODE_SCREENSHOTS'];
let debugPort = 0;
let failure: string | undefined;
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
    const body = JSON.parse(await bodyOf(req)) as Body;
    if (!JSON.stringify(body.messages[0]).includes(MARKER)) {
      res.writeHead(500).end(`no script for ${JSON.stringify(body.messages[0]).slice(0, 200)}`);
      return;
    }
    const reply = SCRIPT[requests++];
    if (reply === undefined) {
      res.writeHead(500).end(`no reply ${requests - 1}`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseBody(reply));
  },
  'POST /report': async (req, res) => {
    report = JSON.parse(await bodyOf(req)) as ShownSpend;
    res.writeHead(200).end();
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

const shownRows = (view: BreakdownView): ShownRow[] => view.rows.map((r) => ({ label: r.label, tokens: r.tokens, percent: r.percent, baht: r.cost.baht, usd: r.cost.usd }));

async function usageJson(home: string, sessionId: string) {
  const out: string[] = [];
  const io = { env: { GCODE_HOME: home }, cwd: root, out: (line: string) => out.push(line), err: () => {}, write: () => {}, confirm: async () => false, interrupts: () => new AbortController().signal };
  expect(await gcode(['usage', '--session', sessionId, '--json'], io)).toBe(0);
  return JSON.parse(out.join('\n')) as { view: { session: SessionSpendView; turns: ({ seq: number; kind: 'model' } & BreakdownView)[] } };
}

describe('where the tokens went, in VS Code', () => {
  it('opens a turn’s breakdown from its usage line, switches to the session, and shows the numbers gcode usage prints', async () => {
    const { home, suite, launchArgs } = await setUp('usage', FILES, { 'gcode.approvalMode': 'auto', 'gcode.chat.detail': 'full', 'chat.mcp.enabled': false });
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
        GCODE_CLASSIFIER_MODEL: 'off',
      },
    });
    expect(failure).toBeUndefined();
    expect(code).toBe(0);
    expect(requests).toBe(SCRIPT.length);

    const [log] = await readdir(path.join(home, 'sessions'));
    const cli = await usageJson(home, path.basename(log!, '.jsonl'));
    const first = cli.view.turns[0]!;
    expect(report!.turn).toEqual(shownRows(first));
    expect(report!.driver).toBe(first.driver);
    expect(report!.session).toEqual(shownRows(cli.view.session.breakdown!));
    expect(report!.total).toBe(`${cli.view.session.turns} · ${cli.view.session.cost.baht}${cli.view.session.cost.usd}`);
    expect(report!.top).toEqual(cli.view.session.top.map((t) => t.prompt));
  }, 600_000);
});
