import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, sseBody, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { setUp } from './launch.js';
import { capturePanel, panelClip, panelCost, trace, webviewPid, type PanelCost } from './media.js';
import { captureWindow } from './screenshot.js';
import { leaseWindow } from './pool/client.js';
import { ANSWERS, FILES, PLAN, TROUBLE, WORK } from './suite/working-fixture.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

const rounds = (prefix: string, calls: readonly { readonly say: string; readonly name: string; readonly input: Readonly<Record<string, unknown>> }[]): Reply[] =>
  calls.map((call, i) => asModel(toolCall(call.say, [{ id: `${prefix}${i}`, name: call.name, input: call.input }], usage)));

/** The last turn does the work again, undoing the first turn's edits, while the suite records it. */
const AGAIN = WORK.map((call) =>
  call.name === 'edit' ? { ...call, input: { ...call.input, old_str: call.input['new_str'], new_str: call.input['old_str'] } } : call,
);

const replies: readonly Reply[] = [
  ...rounds('tu_work_', WORK),
  asModel(answer(ANSWERS.work, usage)),
  // The user denies the command, which ends the turn: no answer follows it.
  ...rounds('tu_trouble_', TROUBLE),
  ...rounds('tu_plan_', PLAN),
  asModel(answer(ANSWERS.plan, usage)),
  ...rounds('tu_again_', AGAIN),
  asModel(answer(ANSWERS.work, usage)),
];

/** GCODE_SCREENSHOTS names a folder for the screenshots, the GIF and the CPU profile's numbers. */
const shots = process.env['GCODE_SCREENSHOTS'];
const PROFILE_MS = 10_000;
const GIF_FRAMES = 170;
const GIF_MS = 70;
let debugPort = 0;
let window: Window | undefined;
const requests: unknown[] = [];
const costs: (PanelCost & { readonly label: string; readonly timers: number; readonly timerMs: number })[] = [];
let panelPid: number | undefined;

/** Each model reply waits until the suite lets it go, so the suite can look at each step's pose. */
let allowed = 0;
let wake: () => void = () => {};
const allow = (n = 1) => {
  allowed += n;
  wake();
};
async function turnFor(index: number): Promise<void> {
  while (index >= allowed) await new Promise<void>((resolve) => (wake = resolve));
}

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const READY = '.transcript';

/** The panel's lower part, where the running turn is, a still each tick, stitched into a looping GIF; `release` lets a reply go every `every` ms meanwhile. */
async function recordTurn(w: Window, file: string, every: number, release: () => void): Promise<void> {
  const clip = await panelClip(w);
  const height = Math.min(clip.height, 360);
  const dir = await mkdtemp(path.join(tmpdir(), 'gcode-working-'));
  const stills: string[] = [];
  const started = Date.now();
  let released = 0;
  for (let i = 0; i < GIF_FRAMES; i++) {
    if (Date.now() - started >= (released + 1) * every) {
      released++;
      release();
    }
    await evaluate(await webview(w, EXTENSION, READY), `(doc.defaultView.postMessage({ type: 'window-focus', focused: true }, '*'), 1)`);
    await new Promise((r) => setTimeout(r, Math.max(0, started + i * GIF_MS - Date.now())));
    const { data } = await w.page.send<{ data: string }>('Page.captureScreenshot', { format: 'png', clip: { ...clip, y: clip.y + clip.height - height, height, scale: 1 } });
    const still = path.join(dir, `${String(i).padStart(3, '0')}.png`);
    await writeFile(still, Buffer.from(data, 'base64'));
    stills.push(still);
  }
  const gif = spawnSync('python3', [path.resolve('scripts/frames-to-gif.py'), file, String(GIF_MS), ...stills], { encoding: 'utf8' });
  if (gif.status !== 0) throw new Error(`frames-to-gif failed: ${gif.stderr}`);
}

const UI: Readonly<Record<string, (action: any, window: Window) => Promise<unknown>>> = {
  eval: async ({ expression }, w) => evaluate(await webview(w, EXTENSION, READY), expression),
  click: async ({ selector, text }, w) => click(await webview(w, EXTENSION, READY), selector, text),
  type: async ({ text }, w) => typeText(await webview(w, EXTENSION, READY), text),
  press: async ({ key }, w) => press(await webview(w, EXTENSION, READY), key),
  motion: async ({ value }, w) =>
    (await webview(w, EXTENSION, READY)).send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] }),
  pointerAway: async (_action, w) => w.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 300 }),
  screenshot: async ({ name }) => {
    if (shots !== undefined) await captureWindow(debugPort, path.resolve(shots, `${name}.png`));
  },
  panelshot: async ({ name }, w) => {
    if (shots !== undefined) await capturePanel(w, path.resolve(shots, `${name}.png`));
  },
  /** Records the next turn while its replies go out; without a folder for media, the replies just go out. */
  record: async ({ name, replies: count, every }, w) => {
    const last = allowed + count;
    if (shots !== undefined) await recordTurn(w, path.resolve(shots, `${name}.gif`), every, () => allowed < last && allow());
    allow(Math.max(0, last - allowed));
  },
  /** A 10 s trace of the panel, with the timer callbacks it ran. */
  perf: async ({ label }, w) => {
    const events = await trace(w, PROFILE_MS);
    panelPid ??= webviewPid(events);
    if (panelPid === undefined) throw new Error('the first trace shows no script in the panel, so its renderer is unknown');
    const main = events.find((e) => e.ph === 'M' && e.name === 'thread_name' && e.pid === panelPid && e.args?.name === 'CrRendererMain')?.tid;
    const fired = events.filter((e) => e.pid === panelPid && e.tid === main && e.name === 'TimerFire');
    // The time inside timer callbacks: Noodle's ticks and their canvas paints, apart from the turn's own animations.
    const timerMs = fired.reduce((sum, e) => sum + (e.dur ?? 0), 0) / 1000;
    const cost = { label, timers: fired.length, timerMs, ...panelCost(events, panelPid) };
    costs.push(cost);
    console.log(`perf ${label}: ${cost.busyMs.toFixed(1)}ms main-thread busy in ${cost.seconds.toFixed(2)}s (${cost.busyPercent.toFixed(2)}%), ${fired.length} timers taking ${timerMs.toFixed(1)}ms, ${cost.frames} frames`);
    return { timers: fired.length };
  },
  release: async () => allow(),
  /** How many model requests have arrived, and how many replies went. */
  requests: async () => ({ arrived: requests.length, allowed }),
};

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  'POST /v1/messages': async (req, res) => {
    const index = requests.push(JSON.parse(await bodyOf(req))) - 1;
    const reply = replies[index];
    if (reply === undefined) {
      res.writeHead(500).end(`no reply for request ${index}`);
      return;
    }
    await turnFor(index);
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseBody(reply));
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

describe('the working dino in VS Code', () => {
  it('switches poses with the running turn’s steps, flexes when its check passed, and becomes the still avatar', async () => {
    const { workspace, work, home, suite } = await setUp('working', FILES, {});
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
    if (shots !== undefined && costs.length > 0) await writeFile(path.resolve(shots, 'perf.json'), `${JSON.stringify(costs, null, 2)}\n`);
    expect(requests).toHaveLength(replies.length);
  }, 900_000);
});
