import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, sseBody, toolCall, type FakeToolUse, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { cachePath, root, setUp } from './launch.js';
import { capturePanel, resizeSideBar } from './media.js';
import { captureWindow, freePort } from './screenshot.js';
import { ANSWERS, FILES, MARKERS, TASKS } from './suite/subagents-fixture.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

/** `hold` keeps a reply back until the suite releases it by name; `hang` never answers, so only a cancel ends the call. */
type Scripted = { readonly reply: Reply; readonly hold?: string; readonly hang?: true };

const agent = (id: string, task: string): FakeToolUse => ({ id, name: 'agent', input: { agent: 'explore', task } });

/** One script per conversation, picked by the marker in its first message. */
const SCRIPTS: Readonly<Record<string, readonly Scripted[]>> = {
  [MARKERS.parent]: [
    { reply: asModel(toolCall('Asking two explorers.', [agent('tu_alpha', TASKS.alpha), agent('tu_beta', TASKS.beta)], usage)) },
    { reply: asModel(answer(ANSWERS.parent, usage)) },
  ],
  [MARKERS.alpha]: [
    { reply: asModel(toolCall('Reading a.ts.', [{ id: 'tu_read_a', name: 'read', input: { path: 'a.ts' } }], usage)) },
    { reply: asModel(answer(ANSWERS.alpha, usage)), hold: 'alpha' },
  ],
  [MARKERS.beta]: [{ reply: asModel(answer(ANSWERS.beta, usage)), hold: 'beta' }],
  [MARKERS.cancel]: [
    { reply: asModel(toolCall('Asking an explorer.', [agent('tu_gamma', TASKS.gamma)], usage)) },
    { reply: asModel(answer(ANSWERS.cancelled, usage)) },
  ],
  [MARKERS.gamma]: [{ reply: asModel(answer('never sent', usage)), hang: true }],
};

const requests: Record<string, { messages: { content: unknown }[] }[]> = {};
const shots = process.env['GCODE_SCREENSHOTS'];
let debugPort = 0;
let window: Window | undefined;
const releases = new Map<string, () => void>();
const released = (name: string) => new Promise<void>((resolve) => releases.set(name, resolve));
const holds = new Map<string, Promise<void>>(['alpha', 'beta'].map((name) => [name, released(name)]));

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
    const body = JSON.parse(await bodyOf(req)) as { messages: { content: unknown }[] };
    const first = JSON.stringify(body.messages[0]);
    // A child's task opens its conversation; the parent's two prompts share one, so its newest prompt decides.
    const all = JSON.stringify(body.messages);
    const parents = [MARKERS.parent, MARKERS.cancel].filter((m) => all.includes(m)).toSorted((a, b) => all.lastIndexOf(b) - all.lastIndexOf(a));
    const marker = [MARKERS.alpha, MARKERS.beta, MARKERS.gamma].find((m) => first.includes(m)) ?? parents[0];
    if (marker === undefined) {
      res.writeHead(500).end(`no script for ${first.slice(0, 200)}`);
      return;
    }
    const seen = (requests[marker] ??= []);
    const step = SCRIPTS[marker]![seen.push(body) - 1];
    if (step === undefined) {
      res.writeHead(500).end(`no reply ${seen.length - 1} for ${marker}`);
      return;
    }
    if (step.hang) {
      res.writeHead(200, { 'content-type': 'text/event-stream' }).flushHeaders();
      await new Promise((resolve) => res.on('close', resolve));
      return;
    }
    if (step.hold !== undefined) await holds.get(step.hold);
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseBody(step.reply));
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

describe('subagents in the chat panel', () => {
  it('nests children under their agent call, opens one and comes back, cancels one, and counts the running ones in the pill', async () => {
    const { home, suite, launchArgs } = await setUp('subagents', FILES, { 'gcode.approvalMode': 'ask', 'gcode.chat.detail': 'full', 'chat.mcp.enabled': false });
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
    expect(Object.fromEntries(Object.entries(requests).map(([marker, sent]) => [marker, sent.length]))).toEqual({
      [MARKERS.parent]: 2,
      [MARKERS.alpha]: 2,
      [MARKERS.beta]: 1,
      [MARKERS.cancel]: 2,
      [MARKERS.gamma]: 1,
    });
    // The parent went on after the cancel, with gamma's report marked as cut short.
    const report = JSON.stringify(requests[MARKERS.cancel]![1]!.messages.at(-1)!.content);
    expect(report).toContain('status=\\"cancelled\\" partial=\\"true\\"');
  }, 600_000);
});
