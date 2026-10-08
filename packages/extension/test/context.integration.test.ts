import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NOT_USER_LINE } from '@g-code/core';
import { answer, loadTools, offeredTools, sseBody, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { setUp } from './launch.js';
import { captureWindow } from './screenshot.js';
import { leaseWindow } from './pool/client.js';
import { ANSWER, NOTE, QUESTION } from './suite/context-fixture.js';

const EXTENSION = 'g-code.g-code';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const MODEL = 'qwen3.8-flash';
const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

const replies: readonly Reply[] = [
  asModel(toolCall('', [loadTools('remember')], usage)),
  asModel(toolCall('I will remember that.', [{ id: 'tu_remember', name: 'remember', input: { text: NOTE, scope: 'project' } }], usage)),
  asModel(answer('Noted.', usage)),
  asModel(toolCall('One question first.', [{ id: 'tu_ask', name: 'ask_user', input: QUESTION }], usage)),
  asModel(answer('Setting up SQLite.', usage)),
];

type Body = { tools: { name: string }[]; system: { text: string }[]; messages: { role: string; content: string | { type: string; text?: string }[] }[] };
const userTexts = (body: Body): string[] =>
  body.messages.flatMap((m) => (m.role !== 'user' || typeof m.content === 'string' ? [] : m.content.flatMap((b) => (b.type === 'text' && b.text !== undefined ? [b.text] : []))));
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
    const { workspace, work, home, suite } = await setUp(
      'context',
      { 'AGENTS.md': 'Use pnpm.\n', '.cursor/rules/react.mdc': '---\nglobs: *.tsx\n---\nFunction components.\n', 'a.ts': 'export const a = 1;\n' },
      { 'gcode.approvalMode': 'ask', 'gcode.chat.detail': 'full' },
    );
    await mkdir(home, { recursive: true });
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
    });
    expect(requests).toHaveLength(replies.length);
    const names = (i: number) => offeredTools(requests[i]!);
    expect(names(0), 'the panel shows both cards, so Ask offers both tools').toEqual(expect.arrayContaining(['ask_user', 'remember']));
    expect(JSON.stringify(requests[2]!.messages)).toContain('Saved to project memory.');
    expect(JSON.stringify(requests[0]), 'no note before the user approves it').not.toContain(NOTE);
    const told = userTexts(requests[3]!).filter((text) => text.includes(`<note scope="project">${NOTE}</note>`));
    expect(told.map((text) => text.startsWith(`${NOT_USER_LINE}\n`)), 'the approved note reaches the next prompt once, as a notice not from the user').toEqual([true]);
    expect(requests[3]!.system, 'and the system prompt stays byte-stable').toEqual(requests[0]!.system);
    expect(JSON.stringify(requests[4]!.messages)).toContain(`The user answered: ${ANSWER}`);
  }, 600_000);
});
