import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHAPTER_NOTE } from '@g-code/core';
import { answer, loadTools, sseBody, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { buildSuite, cachePath, root, setUp } from './launch.js';
import { capturePanel, resizeSideBar } from './media.js';
import { captureWindow, freePort } from './screenshot.js';
import { ANSWERS, CHAPTERS, FILES, MARKER } from './suite/chapters-fixture.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

const mark = (chapter: { readonly toolUseId: string; readonly title: string; readonly summary?: string }) => ({
  id: chapter.toolUseId,
  name: 'mark_chapter',
  input: { title: chapter.title, ...(chapter.summary === undefined ? {} : { summary: chapter.summary }) },
});

/** The chat's replies, in order: a turn that only reads, two that each start a chapter, and one that only answers. */
const SCRIPT: readonly Reply[] = [
  asModel(toolCall('Reading it.', [{ id: 'tu_read', name: 'read', input: { path: 'src/date.ts' } }], usage)),
  asModel(answer(ANSWERS.look, usage)),
  asModel(toolCall('Exploring is done; fixing now.', [loadTools('mark_chapter')], usage)),
  asModel(toolCall('Marking the phase.', [mark(CHAPTERS.fix)], usage)),
  asModel(answer(ANSWERS.fix, usage)),
  asModel(toolCall('Fixed; verifying.', [mark(CHAPTERS.verify), { id: 'tu_test', name: 'read', input: { path: 'test/date.test.ts' } }], usage)),
  asModel(answer(ANSWERS.verify, usage)),
  asModel(answer(ANSWERS.notes, usage)),
];

type Body = { system?: unknown; messages: { role: string; content: unknown }[]; tools?: { name: string; description?: string }[] };
const requests: Body[] = [];
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
    if (!JSON.stringify(body.messages[0]).includes(MARKER)) {
      res.writeHead(500).end(`no script for ${JSON.stringify(body.messages[0]).slice(0, 200)}`);
      return;
    }
    const reply = SCRIPT[requests.push(body) - 1];
    if (reply === undefined) {
      res.writeHead(500).end(`no reply ${requests.length - 1}`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseBody(reply));
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

describe('chapters in the panel', () => {
  it("draws the agent's chapters as dividers and in a table of contents that jumps, takes the user's from a message's menu, and keeps them through a reload", async () => {
    const { work, home, suite, launchArgs } = await setUp('chapters', FILES, { 'gcode.approvalMode': 'ask', 'gcode.chat.detail': 'full', 'chat.mcp.enabled': false });
    if (shots !== undefined) await mkdir(shots, { recursive: true });
    debugPort = await freePort();
    const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    const launch = (extensionTestsPath: string) =>
      runTests({
        extensionDevelopmentPath: root,
        extensionTestsPath,
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
    expect(await launch(suite)).toBe(0);
    expect(failure).toBeUndefined();
    expect(requests).toHaveLength(SCRIPT.length);
    const block = requests[0]!.tools?.find((tool) => tool.name === 'tool_search')?.description ?? '';
    expect(block, 'the panel advertises chapters, so the chat lists mark_chapter').toContain('- mark_chapter: Mark the start of a new chapter');
    expect(requests.every((body) => JSON.stringify(body.system).includes(CHAPTER_NOTE)), 'every call says when to mark one').toBe(true);

    // Same workspace, user data and GCODE_HOME: a window reload, as far as the extension can tell.
    window?.browser.close();
    window = undefined;
    expect(await launch(await buildSuite(work, 'chapters-reload'))).toBe(0);
    expect(failure).toBeUndefined();
    expect(requests, 'the reload and the marks sent nothing to the model').toHaveLength(SCRIPT.length);
  }, 900_000);
});
