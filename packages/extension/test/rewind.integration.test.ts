import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, sseBody, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { setUp } from './launch.js';
import { capturePanel, resizeSideBar } from './media.js';
import { captureWindow } from './screenshot.js';
import { leaseWindow } from './pool/client.js';
import { ANSWERS, FILES, MARKER, PROMPTS } from './suite/rewind-fixture.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

const read = (id: string) => ({ id, name: 'read', input: { path: 'a.ts' } });
const edit = (id: string, from: string, to: string) => ({ id, name: 'edit', input: { path: 'a.ts', old_str: from, new_str: to } });

/** The original's two turns, its rewound one, then the fork's own turn, in the order the suite sends them. */
const SCRIPT: readonly Reply[] = [
  toolCall('Making it two.', [read('tu_r1'), edit('tu_e1', 'one', 'two')], usage),
  answer(ANSWERS.two, usage),
  toolCall('Making it three.', [read('tu_r2'), edit('tu_e2', 'two', 'three')], usage),
  answer(ANSWERS.three, usage),
  answer(ANSWERS.edited, usage),
  answer(ANSWERS.forked, usage),
].map(asModel);

type Block = { type: string; text?: string };
type Body = { messages: { role: string; content: string | Block[] }[] };
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

/** The user's prose in a request, without the loaded context, Geno's own notes and the tool results. */
const prose = (body: Body): string[] =>
  body.messages.flatMap((m) =>
    m.role !== 'user' ? [] : (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content).flatMap((b) => (b.type === 'text' && b.text !== undefined && !b.text.startsWith('<') && !b.text.startsWith('[Geno]') ? [b.text] : [])),
  );

describe('rewind and fork from the panel in VS Code', () => {
  it('rewinds files after a confirm, cuts the conversation back into the composer, and forks into a new chat linked from History and Tasks', async () => {
    const { workspace, work, home, suite } = await setUp('rewind', FILES, { 'gcode.approvalMode': 'auto', 'gcode.chat.detail': 'full', 'chat.mcp.enabled': false });
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
    expect(failure).toBeUndefined();
    expect(requests).toHaveLength(SCRIPT.length);

    // The edited message went in place of the cut one, which the model never saw again.
    expect(prose(requests[4]!)).toEqual([PROMPTS.two, PROMPTS.edited]);
    // The fork's turn carried the first turn and nothing after it.
    expect(prose(requests[5]!)).toEqual([PROMPTS.two, PROMPTS.forked]);
  }, 600_000);
});
