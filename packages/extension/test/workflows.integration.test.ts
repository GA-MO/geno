import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, handBack, sseBody, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { cachePath, root, setUp } from './launch.js';
import { capturePanel, resizeSideBar } from './media.js';
import { captureWindow, freePort } from './screenshot.js';
import { ANSWERS, FILES, SLOW_MS, SLOW_STEP } from './suite/workflows-fixture.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

type Body = { messages: { role: string; content: string | { type: string; text?: string }[] }[] };
const requests = new Map<string, Body[]>();
const strays: string[] = [];
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
  workbench: async ({ expression }, w) => (await w.page.send<{ result: { value: unknown } }>('Runtime.evaluate', { expression, returnByValue: true })).result.value,
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
    const first = JSON.stringify(body.messages[0]);
    const marker = Object.keys(ANSWERS).find((m) => first.includes(m));
    if (marker === undefined) {
      strays.push(first.slice(0, 200));
      res.writeHead(500).end('no script for this request');
      return;
    }
    requests.set(marker, [...(requests.get(marker) ?? []), body]);
    if (marker === SLOW_STEP) await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
    // A step is a child, which hands its report back through the report tool; the starting session answers.
    const reply = marker.startsWith('[wf-') ? handBack(ANSWERS[marker]!, usage) : answer(ANSWERS[marker]!, usage);
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseBody(asModel(reply)));
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

const firstText = (body: Body): string => {
  const content = body.messages[0]!.content;
  return typeof content === 'string' ? content : (content.findLast((b) => b.type === 'text')?.text ?? '');
};

describe('workflows in the panel', () => {
  it('starts a workflow from the composer, confirms its preview, follows it in Tasks and gets its report back as a woken turn', async () => {
    const { home, suite, launchArgs } = await setUp('workflows', FILES, { 'gcode.approvalMode': 'ask', 'gcode.chat.detail': 'full', 'chat.mcp.enabled': false });
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
    expect(code).toBe(0);
    expect(failure).toBeUndefined();
    expect(strays, 'every request is a step or the woken turn').toEqual([]);
    expect([...requests.entries()].map(([marker, bodies]) => [marker, bodies.length])).toEqual([
      ['[wf-review]', 1],
      ['[wf-fix]', 1],
      ['[wf-verify]', 1],
      ['Run the workflow', 1],
    ]);
    expect(firstText(requests.get('[wf-fix]')![0]!)).toBe('[wf-fix] Fix these findings:\n["src/app.ts:1 port has no type"]');
    const woken = JSON.stringify(requests.get('Run the workflow')![0]!.messages);
    expect(woken).toContain('<subagent_report agent=\\"workflow review-fix-verify\\"');
    expect(woken).toContain('Workflow review-fix-verify finished: 3 steps ran');
  }, 900_000);
});
