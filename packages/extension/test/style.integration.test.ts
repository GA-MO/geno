import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, sseBody, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, hover, press, typeText, webview, type Window } from './cdp.js';
import { cachePath, root, setUp } from './launch.js';
import { capturePanel, panelCost, pauseRainbow, playRainbow, recordRainbow, trace, webviewPid, type PanelCost } from './media.js';
import { captureWindow, freePort } from './screenshot.js';
import { ANSWER, EDIT, FILES } from './suite/style-fixture.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

/** The fake transport's answers name another model; the footers should show the one configured. */
const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

const replies: readonly Reply[] = [
  toolCall('Reading the code first.', [{ id: 'tu_read_a', name: 'read', input: { path: 'a.ts' } }, { id: 'tu_read_b', name: 'read', input: { path: 'b.ts' } }], usage),
  toolCall('Making the edit.', [{ id: 'tu_edit_a', name: 'edit', input: EDIT }], usage),
  asModel(answer(ANSWER, usage)),
  toolCall('Removing the build output.', [{ id: 'tu_rm', name: 'bash', input: { command: 'rm -rf build' } }], usage),
  asModel(answer('Removed `build`.', usage)),
  { ...asModel(answer('Once upon a time there was a very long essay that never ended.', usage)), stallAfter: 8 },
];

const requests: unknown[] = [];
/** GCODE_SCREENSHOTS names a folder for the screenshots and the rainbow GIF; GCODE_PERF=1 also traces the panel. */
const shots = process.env['GCODE_SCREENSHOTS'];
const perf = process.env['GCODE_PERF'] === '1';
const costs: (PanelCost & { readonly label: string })[] = [];
let debugPort = 0;
/** The renderer hosting the panel, found in the first trace and kept, since a trace of an idle panel cannot name it. */
let panelPid: number | undefined;
let window: Window | undefined;

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const READY = '.transcript';
const TRACE_MS = 3000;
const RUNS = 5;

async function measure(w: Window, label: string): Promise<void> {
  if (!perf) return;
  const events = await trace(w, TRACE_MS);
  panelPid ??= webviewPid(events);
  if (panelPid === undefined) throw new Error('the first trace shows no script in the panel, so its renderer is unknown');
  const cost = { label, ...panelCost(events, panelPid) };
  costs.push(cost);
  console.log(`perf ${label}: ${cost.busyMs.toFixed(1)}ms main-thread busy in ${cost.seconds.toFixed(2)}s (${cost.busyPercent.toFixed(1)}%), ${cost.frames} frames, ${cost.fps.toFixed(1)} fps`);
}

const UI: Readonly<Record<string, (action: any, window: Window) => Promise<unknown>>> = {
  eval: async ({ expression }, w) => evaluate(await webview(w, EXTENSION, READY), expression),
  click: async ({ selector, text }, w) => click(await webview(w, EXTENSION, READY), selector, text),
  type: async ({ text }, w) => typeText(await webview(w, EXTENSION, READY), text),
  press: async ({ key, modifiers }, w) => press(await webview(w, EXTENSION, READY), key, modifiers),
  motion: async ({ value }, w) =>
    (await webview(w, EXTENSION, READY)).send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] }),
  screenshot: async ({ name }) => {
    if (shots !== undefined) await captureWindow(debugPort, path.resolve(shots, `${name}.png`));
  },
  evalPage: async ({ expression }, w) => (await w.page.send('Runtime.evaluate', { expression, returnByValue: true })).result.value,
  hover: async ({ selector }, w) => hover(await webview(w, EXTENSION, READY), selector),
  /** Rests the pointer over the empty editor, so no hover from earlier lingers in a window capture. */
  pointerAway: async (_action, w) => w.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 300 }),
  panelshot: async ({ name }, w) => {
    if (shots !== undefined) await capturePanel(w, path.resolve(shots, `${name}.png`));
  },
  /** The rainbow GIF when `gif`, and traces with the rainbow running and held, alternated so drift falls on both. */
  media: async ({ label, gif }, w) => {
    const view = await webview(w, EXTENSION, READY);
    if (gif === true && shots !== undefined) await recordRainbow(w, view, path.resolve(shots, 'rainbow.gif'));
    if (!perf) return;
    for (let run = 0; run < RUNS; run++) {
      await measure(w, `glass, ${label}, rainbow running`);
      await pauseRainbow(view);
      await measure(w, `glass, ${label}, rainbow held`);
      await playRainbow(view);
    }
  },
  perf: async ({ label }, w) => {
    for (let run = 0; run < RUNS; run++) await measure(w, label);
  },
};

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  'POST /v1/messages': async (req, res) => {
    const reply = replies[requests.push(JSON.parse(await bodyOf(req))) - 1];
    if (reply === undefined) {
      res.writeHead(500).end(`no reply for request ${requests.length - 1}`);
      return;
    }
    if (reply.stallAfter === undefined) {
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseBody(reply));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' }).write(sseBody({ events: reply.events.slice(0, reply.stallAfter) }));
    await new Promise((resolve) => res.on('close', resolve));
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

describe('the chat panel style', () => {
  it('is glass with a rainbow on the composer, native on request and in high contrast', async () => {
    // These assertions open the steps of finished turns, which full detail draws as the panel did before U17.
    const { home, suite, launchArgs } = await setUp('style', FILES, { 'gcode.chat.detail': 'full' });
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
      },
    });
    if (perf && shots !== undefined) await writeFile(path.resolve(shots, 'perf.json'), `${JSON.stringify(costs, null, 2)}\n`);
    expect(code).toBe(0);
    expect(requests).toHaveLength(replies.length);
  }, 600_000);
});
