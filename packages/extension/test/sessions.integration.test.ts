import { mkdir, readdir, realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSessionId, type Session, type TurnEvent } from '@g-code/core';
import { answer, sseBody, type Reply } from '../../engine/test/fake-transport.js';
import { appendEvent } from '../../engine/src/sessions.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { setUp } from './launch.js';
import { captureWindow } from './screenshot.js';
import { leaseWindow } from './pool/client.js';
import { ANSWERS, ELSEWHERE, FILES, OLDER, TEMPORARY } from './suite/sessions-fixture.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

const replies: readonly Reply[] = [asModel(answer(ANSWERS.hello, usage)), asModel(answer(ANSWERS.more, usage))];
const requests: { messages: { role: string }[] }[] = [];
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
  evalPage: async ({ expression }, w) => (await w.page.send('Runtime.evaluate', { expression, returnByValue: true })).result.value,
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

/** A session log as the engine writes it: one prompt, a read, and the answer. */
async function logSession(home: string, id: string, workspace: string, prompt: string, at: string, steps: readonly TurnEvent[] = []): Promise<void> {
  const file = path.join(home, 'sessions', `${id}.jsonl`);
  const session: Session = { id: asSessionId(id), createdAt: at, workspace, provider: 'modelstudio', model: MODEL, effort: 'medium' };
  await appendEvent(file, { kind: 'session-start', session });
  await appendEvent(file, { kind: 'user', seq: 1, at, content: prompt });
  for (const step of steps) await appendEvent(file, step);
}

const assistant = (seq: number, at: string, content: unknown[]): TurnEvent => ({
  kind: 'assistant',
  seq,
  at,
  content: content as never,
  stopReason: 'end_turn',
  usage: { input: 1200, cacheRead: 0, cacheWrite: 0, output: 40 },
  costUsd: 0.0004,
  latencyMs: 900,
  model: MODEL,
});

describe('sessions and projects in VS Code', () => {
  it('starts new chats, lists this project or every project, loads an old session with its transcript, renames and trashes', async () => {
    const { work, home, workspace, suite } = await setUp('sessions', FILES, {});
    if (shots !== undefined) await mkdir(shots, { recursive: true });
    const real = await realpath(workspace);
    await logSession(home, OLDER.id, real, OLDER.prompt, '2026-10-04T09:00:00.000Z', [
      assistant(2, '2026-10-04T09:00:02.000Z', [
        { type: 'text', text: OLDER.text },
        { type: 'tool_use', id: 'tu_old_read', name: 'read', input: { path: 'a.ts' } },
      ]),
      { kind: 'tool-result', seq: 3, at: '2026-10-04T09:00:02.300Z', toolUseId: 'tu_old_read', name: 'read', status: 'ok', output: '1\texport const a = 1;' },
      assistant(4, '2026-10-04T09:00:04.000Z', [{ type: 'text', text: OLDER.answer }]),
    ]);
    await logSession(home, ELSEWHERE.id, ELSEWHERE.workspace, ELSEWHERE.prompt, '2026-10-03T09:00:00.000Z');
    await logSession(home, TEMPORARY.id, path.join(tmpdir(), 'gcode-eval-clone'), TEMPORARY.prompt, '2026-10-04T10:00:00.000Z');
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
    // The follow-up to the loaded session carries its earlier turn: the prompt, the read and the answer.
    expect(requests[1]!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect((await readdir(path.join(home, 'trash'))).length).toBe(1);
  }, 600_000);
});
