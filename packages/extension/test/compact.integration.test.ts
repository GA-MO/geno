import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { SUMMARY_SYSTEM } from '@g-code/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, sseBody, toolCall, type CacheUsage, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { setUp } from './launch.js';
import { capturePanel, resizeSideBar } from './media.js';
import { captureWindow } from './screenshot.js';
import { leaseWindow } from './pool/client.js';
import { ANSWERS, BIG_LOGS, COMPACT_AT, FILES, MARKER, SUMMARIES } from './suite/compact-fixture.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';
const usage = (input: number): CacheUsage => ({ input, cacheRead: 0, cacheWrite: 0 });

const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

/** `hold` keeps a reply back until the suite releases it by name. */
type Scripted = { readonly reply: Reply; readonly hold?: string };

const CHAT: readonly Scripted[] = [
  { reply: asModel(toolCall('Reading a.ts.', [{ id: 'tu_a', name: 'read', input: { path: 'a.ts' } }], usage(10_000))) },
  { reply: asModel(answer(ANSWERS.first, usage(850_000))) },
  { reply: asModel(toolCall('Reading the logs.', BIG_LOGS.map((file, i) => ({ id: `tu_log${i}`, name: 'read', input: { path: file } })), usage(3_000))) },
  { reply: asModel(answer(ANSWERS.logs, usage(45_000))) },
  { reply: asModel(answer(ANSWERS.next, usage(19_000))) },
];

const SUMMARY_CALLS: readonly Scripted[] = [
  { reply: asModel(answer(SUMMARIES.manual, usage(900))), hold: 'manual' },
  { reply: asModel(answer(SUMMARIES.auto, usage(900))), hold: 'auto' },
];

type Body = { system?: unknown; messages: { role: string; content: unknown }[] };
const chats: Body[] = [];
const summaries: Body[] = [];
const shots = process.env['GCODE_SCREENSHOTS'];
let debugPort = 0;
let failure: string | undefined;
let window: Window | undefined;
const releases = new Map<string, () => void>();
const holds = new Map(['manual', 'auto'].map((name) => [name, new Promise<void>((resolve) => releases.set(name, resolve))]));

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

const isSummary = (body: Body): boolean => JSON.stringify(body.system ?? '').includes(SUMMARY_SYSTEM.slice(0, 60));

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  'POST /v1/messages': async (req, res) => {
    const body = JSON.parse(await bodyOf(req)) as Body;
    const summary = isSummary(body);
    if (!summary && !JSON.stringify(body.messages[0]).includes(MARKER)) {
      res.writeHead(500).end('not the chat');
      return;
    }
    const list = summary ? summaries : chats;
    const step = (summary ? SUMMARY_CALLS : CHAT)[list.push(body) - 1];
    if (step === undefined) {
      res.writeHead(500).end(`no ${summary ? 'summary' : 'chat'} reply ${list.length - 1}`);
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

const textOf = (body: Body): string => JSON.stringify(body.messages);

describe('context compaction in VS Code', () => {
  it('offers Compact on the ring past 80%, runs /compact as a turn with a divider, compacts on its own mid-session, and replays both dividers', async () => {
    const { workspace, work, home, suite } = await setUp('compact', FILES, { 'gcode.approvalMode': 'auto', 'chat.mcp.enabled': false });
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
      GCODE_COMPACT_AT: String(COMPACT_AT),
    });
    expect(failure).toBeUndefined();
    expect(chats).toHaveLength(CHAT.length);
    expect(summaries, 'one summary for /compact and one on its own').toHaveLength(SUMMARY_CALLS.length);
    expect(textOf(chats[2]!), 'after /compact the model reads the summary').toContain('Read build.log and a.ts; the build is clean.');
    expect(textOf(chats[2]!), 'and not the build log it replaced').not.toContain('build: step ok');
    expect(textOf(chats[4]!), 'after the auto compaction the model reads its summary').toContain('Read the five logs; all passed.');
    expect(textOf(chats[4]!), 'and not the logs it replaced').not.toContain('three: step ok');
  }, 600_000);
});
