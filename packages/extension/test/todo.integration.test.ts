import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MODE_NOTICES } from '@g-code/core';
import { answer, sseBody, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { cachePath, root, setUp } from './launch.js';
import { capturePanel, resizeSideBar } from './media.js';
import { captureWindow, freePort } from './screenshot.js';
import { ANSWERS, FILES, LISTS, MARKER, RELEASES, waitFor } from './suite/todo-fixture.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

/** `hold` keeps a reply back until the suite releases it by name. */
type Scripted = { readonly reply: Reply; readonly hold?: string };

const todo = (id: string, items: (typeof LISTS)[keyof typeof LISTS]) => ({ id, name: 'todo', input: { items } });

const SCRIPT: readonly Scripted[] = [
  { reply: asModel(toolCall('Planning.', [todo('tu_plan', LISTS.planned)], usage)) },
  { reply: asModel(answer(ANSWERS.plan, usage)) },
  { reply: asModel(toolCall('Reading a.ts.', [todo('tu_read', LISTS.reading), { id: 'tu_r1', name: 'read', input: { path: 'a.ts' } }], usage)), hold: 'build' },
  { reply: asModel(toolCall('Writing the tests.', [todo('tu_write', LISTS.writing), { id: 'tu_wait', name: 'bash', input: { command: waitFor(RELEASES.write), description: 'Wait for the tests', timeout_seconds: 600 } }], usage)) },
  { reply: asModel(toolCall('Done.', [todo('tu_done', LISTS.finished)], usage)) },
  { reply: asModel(answer(ANSWERS.built, usage)) },
];

type Body = { messages: { role: string; content: string | { type: string; text?: string }[] }[]; tools?: { name: string }[] };
const requests: Body[] = [];
const shots = process.env['GCODE_SCREENSHOTS'];
let debugPort = 0;
let failure: string | undefined;
let window: Window | undefined;
const releases = new Map<string, () => void>();
const holds = new Map<string, Promise<void>>([['build', new Promise<void>((resolve) => releases.set('build', resolve))]]);

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
  release: async ({ name }) => releases.get(name)?.(),
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
      res.writeHead(500).end('not the chat');
      return;
    }
    const step = SCRIPT[requests.push(body) - 1];
    if (step === undefined) {
      res.writeHead(500).end(`no reply ${requests.length - 1}`);
      return;
    }
    if (step.hold !== undefined) await holds.get(step.hold);
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseBody(step.reply));
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

const todoInputs = (body: Body): string[] =>
  body.messages.flatMap((m) => (m.role !== 'assistant' || typeof m.content === 'string' ? [] : m.content.flatMap((b) => (b.type === 'tool_use' && (b as { name?: string }).name === 'todo' ? [JSON.stringify((b as { input?: unknown }).input)] : []))));

describe('the todo list in VS Code', () => {
  it('pins the plan as the list Start building ticks off, folds it to one line, keeps it where it last changed, and fits at 300px', async () => {
    const { home, suite, launchArgs } = await setUp('todo', FILES, { 'gcode.approvalMode': 'auto', 'gcode.chat.detail': 'full', 'chat.mcp.enabled': false });
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
    expect(requests).toHaveLength(SCRIPT.length);
    expect(requests[0]!.tools?.map((t) => t.name), 'Plan offers the todo tool').toContain('todo');
    expect(JSON.stringify(requests[0]!.messages), 'the plan turn ran in Plan').toContain(JSON.stringify(MODE_NOTICES.plan));
    expect(JSON.stringify(requests[2]!.messages.at(-1)), 'and the building turn outside it').toContain(JSON.stringify(MODE_NOTICES.auto));
    expect(todoInputs(requests[2]!), "the building turn's model sees the plan's list").toEqual([JSON.stringify({ items: LISTS.planned })]);
  }, 600_000);
});
