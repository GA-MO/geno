import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSessionId, type Session } from '@g-code/core';
import { answer, sseBody } from '../../engine/test/fake-transport.js';
import { appendEvent } from '../../engine/src/sessions.js';
import { click, connectWindow, evaluate, hover, press, typeText, webview, type Window } from './cdp.js';
import { cachePath, root, setUp } from './launch.js';
import { capturePanel, panelClip, panelCost, trace, webviewPid, type PanelCost } from './media.js';
import { captureWindow, freePort } from './screenshot.js';
import { ANSWER, BRANCH, FILES, SESSIONS } from './suite/start-fixture.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

/** GCODE_SCREENSHOTS names a folder for the screenshots, the start page GIF and the CPU profile's numbers. */
const shots = process.env['GCODE_SCREENSHOTS'];
const PROFILE_MS = 10_000;
/** About 8 s of the start page, one still per 70 ms tick, paced to the clock so the GIF plays at the page's speed. */
const GIF_FRAMES = 115;
const GIF_MS = 70;
/** Partway through the GIF, a click on Noodle for a somersault. */
const GIF_CLICK_AT = 50;
let debugPort = 0;
let window: Window | undefined;
const requests: unknown[] = [];
const costs: (PanelCost & { readonly label: string; readonly timers: number })[] = [];
/** The renderer hosting the panel, found in the first trace and kept, since a trace of a resting panel may not name it. */
let panelPid: number | undefined;
/** The one turn's answer waits until the suite has seen the turn running. */
let release: () => void = () => {};
const released = new Promise<void>((resolve) => (release = resolve));

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const READY = '.transcript';

/** The panel as a still each tick, stitched into a looping GIF. */
async function recordPanel(w: Window, file: string): Promise<void> {
  const clip = await panelClip(w);
  const dir = await mkdtemp(path.join(tmpdir(), 'gcode-start-'));
  const stills: string[] = [];
  const started = Date.now();
  for (let i = 0; i < GIF_FRAMES; i++) {
    if (i === GIF_CLICK_AT) await click(await webview(w, EXTENSION, READY), '.start-dino');
    // The real window can lose the focus mid-recording, which rests Noodle; the recording keeps it awake.
    await evaluate(await webview(w, EXTENSION, READY), `(doc.defaultView.postMessage({ type: 'window-focus', focused: true }, '*'), 1)`);
    await new Promise((r) => setTimeout(r, Math.max(0, started + i * GIF_MS - Date.now())));
    const { data } = await w.page.send<{ data: string }>('Page.captureScreenshot', { format: 'png', clip: { ...clip, height: Math.min(clip.height, 420), scale: 1 } });
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
  hover: async ({ selector }, w) => hover(await webview(w, EXTENSION, READY), selector),
  type: async ({ text }, w) => typeText(await webview(w, EXTENSION, READY), text),
  press: async ({ key, modifiers }, w) => press(await webview(w, EXTENSION, READY), key, modifiers),
  motion: async ({ value }, w) =>
    (await webview(w, EXTENSION, READY)).send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] }),
  pointerAway: async (_action, w) => w.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 300 }),
  screenshot: async ({ name }) => {
    if (shots !== undefined) await captureWindow(debugPort, path.resolve(shots, `${name}.png`));
  },
  panelshot: async ({ name }, w) => {
    if (shots !== undefined) await capturePanel(w, path.resolve(shots, `${name}.png`));
  },
  record: async ({ name }, w) => {
    if (shots !== undefined) await recordPanel(w, path.resolve(shots, `${name}.gif`));
  },
  /** A 10 s trace of the panel, with the timer callbacks it ran, so a run in which Noodle rested can be told apart. */
  perf: async ({ label }, w) => {
    const events = await trace(w, PROFILE_MS);
    panelPid ??= webviewPid(events);
    if (panelPid === undefined) throw new Error('the first trace shows no script in the panel, so its renderer is unknown');
    const main = events.find((e) => e.ph === 'M' && e.name === 'thread_name' && e.pid === panelPid && e.args?.name === 'CrRendererMain')?.tid;
    const timers = events.filter((e) => e.pid === panelPid && e.tid === main && e.name === 'TimerFire').length;
    const cost = { label, timers, ...panelCost(events, panelPid) };
    costs.push(cost);
    console.log(`perf ${label}: ${cost.busyMs.toFixed(1)}ms main-thread busy in ${cost.seconds.toFixed(2)}s (${cost.busyPercent.toFixed(2)}%), ${timers} timers, ${cost.frames} frames`);
    return { timers };
  },
  release: async () => release(),
};

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  'POST /v1/messages': async (req, res) => {
    requests.push(JSON.parse(await bodyOf(req)));
    if (requests.length > 1) {
      res.writeHead(500).end(`no reply for request ${requests.length - 1}`);
      return;
    }
    await released;
    const reply = answer(ANSWER, usage);
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(
      sseBody({ ...reply, events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)) }),
    );
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

/** A finished session of the workspace, as the engine logs one: a prompt and its answer. */
async function logSession(home: string, workspace: string, { id, prompt, at }: (typeof SESSIONS)[number]): Promise<void> {
  const file = path.join(home, 'sessions', `${id}.jsonl`);
  const session: Session = { id: asSessionId(id), createdAt: at, workspace, provider: 'modelstudio', model: MODEL, effort: 'medium' };
  const later = new Date(Date.parse(at) + 3000).toISOString();
  await appendEvent(file, { kind: 'session-start', session });
  await appendEvent(file, { kind: 'user', seq: 1, at, content: prompt });
  await appendEvent(file, {
    kind: 'assistant',
    seq: 2,
    at: later,
    content: [{ type: 'text', text: 'Done.' }] as never,
    stopReason: 'end_turn',
    usage: { input: 1200, cacheRead: 0, cacheWrite: 0, output: 40 },
    costUsd: 0.0004,
    latencyMs: 900,
    model: MODEL,
  });
}

describe('the start page and the peek in VS Code', () => {
  it('shows Noodle alone with geno, the branch and recent sessions; loads one; peeks over the composer while the user types', async () => {
    const { home, workspace, suite, launchArgs } = await setUp('start', FILES, {});
    if (shots !== undefined) await mkdir(shots, { recursive: true });
    const git = spawnSync('git', ['init', '-q', '-b', BRANCH, workspace], { encoding: 'utf8' });
    expect(git.status, git.stderr).toBe(0);
    const real = await realpath(workspace);
    for (const session of SESSIONS) await logSession(home, real, session);
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
    if (shots !== undefined && costs.length > 0) await writeFile(path.resolve(shots, 'perf.json'), `${JSON.stringify(costs, null, 2)}\n`);
    expect(code).toBe(0);
    expect(requests).toHaveLength(1);
  }, 600_000);
});
