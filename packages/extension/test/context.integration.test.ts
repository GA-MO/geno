import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, sseBody, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { cachePath, root, setUp } from './launch.js';
import { captureWindow, freePort } from './screenshot.js';
import { ANSWER, NOTE, QUESTION } from './suite/context-fixture.js';

const EXTENSION = 'g-code.g-code';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const MODEL = 'qwen3.8-flash';
const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

const replies: readonly Reply[] = [
  asModel(toolCall('I will remember that.', [{ id: 'tu_remember', name: 'remember', input: { text: NOTE, scope: 'project' } }], usage)),
  asModel(answer('Noted.', usage)),
  asModel(toolCall('One question first.', [{ id: 'tu_ask', name: 'ask_user', input: QUESTION }], usage)),
  asModel(answer('Setting up SQLite.', usage)),
];

type Body = { tools: { name: string }[]; system: { text: string }[]; messages: unknown[] };
const requests: Body[] = [];
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
    const reply = replies[requests.push(JSON.parse(await bodyOf(req))) - 1];
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

describe('rules, memory and questions in the chat panel', () => {
  it('lists the rules, asks before remembering the exact note, asks a question with options, and edits and deletes memory', async () => {
    const { home, suite, launchArgs } = await setUp(
      'context',
      { 'AGENTS.md': 'Use pnpm.\n', '.cursor/rules/react.mdc': '---\nglobs: *.tsx\n---\nFunction components.\n', 'a.ts': 'export const a = 1;\n' },
      { 'gcode.approvalMode': 'ask' },
    );
    await mkdir(home, { recursive: true });
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
    expect(requests).toHaveLength(replies.length);
    const names = (i: number) => requests[i]!.tools.map((t) => t.name);
    expect(names(0), 'the panel shows both cards, so Ask offers both tools').toEqual(expect.arrayContaining(['ask_user', 'remember']));
    expect(JSON.stringify(requests[1]!.messages)).toContain('Saved to project memory.');
    expect(requests[0]!.system[0]!.text).not.toContain(NOTE);
    expect(requests[2]!.system[0]!.text, 'the approved note is in the next prompt').toContain(`<note scope="project">${NOTE}</note>`);
    expect(JSON.stringify(requests[3]!.messages)).toContain(`The user answered: ${ANSWER}`);
  }, 600_000);
});
