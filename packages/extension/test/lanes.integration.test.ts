import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, sseBody, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { buildSuite, cachePath, root, setUp } from './launch.js';
import { capturePanel, resizeSideBar } from './media.js';
import { captureWindow, freePort } from './screenshot.js';
import { ANSWERS, EDIT, FILES, MARKERS } from './suite/lanes-fixture.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

/** `hold` keeps a reply back until a suite releases it by name. */
type Scripted = { readonly reply: Reply; readonly hold?: string };

/** One script per conversation, picked by the marker in its first message. */
const SCRIPTS: Readonly<Record<string, readonly Scripted[]>> = {
  [MARKERS.lane]: [
    { reply: asModel(toolCall('Reading a.ts.', [{ id: 'tu_lane_read', name: 'read', input: { path: 'a.ts' } }], usage)), hold: 'lane' },
    { reply: asModel(toolCall('Making two loud.', [{ id: 'tu_lane_edit', name: 'edit', input: EDIT }], usage)) },
    { reply: asModel(answer(ANSWERS.lane, usage)) },
  ],
  [MARKERS.slow]: [
    { reply: asModel(toolCall('Reading a.ts.', [{ id: 'tu_slow_read', name: 'read', input: { path: 'a.ts' } }], usage)) },
    { reply: asModel(answer(ANSWERS.slow, usage)), hold: 'slow' },
  ],
};

const requests: Record<string, unknown[]> = {};
const shots = process.env['GCODE_SCREENSHOTS'];
let debugPort = 0;
let window: Window | undefined;
const releases = new Map<string, () => void>();
const holds = new Map(['lane', 'slow'].map((name) => [name, new Promise<void>((resolve) => releases.set(name, resolve))]));

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const READY = '.transcript';

const UI: Readonly<Record<string, (action: any, window: Window) => Promise<unknown>>> = {
  eval: async ({ expression }, w) => evaluate(await webview(w, EXTENSION, READY), expression),
  workbench: async ({ expression }, w) =>
    (await w.page.send<{ result: { value: unknown } }>('Runtime.evaluate', { expression, returnByValue: true })).result.value,
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
    const marker = Object.values(MARKERS).find((m) => first.includes(m));
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

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' });

describe('lanes and background sessions in the panel', () => {
  it('runs a draft in a new lane, applies it for review, discards with a confirm, and keeps a chat turn running through a window reload', async () => {
    const { work, workspace, home, suite, launchArgs } = await setUp('lanes', FILES, { 'gcode.approvalMode': 'ask', 'gcode.chat.detail': 'full', 'chat.mcp.enabled': false, 'gcode.review.mode': 'review' });
    git(workspace, 'init', '-q', '-b', 'main');
    git(workspace, 'add', '-A');
    git(workspace, 'commit', '-q', '--no-verify', '-m', 'start');
    if (shots !== undefined) await mkdir(shots, { recursive: true });
    debugPort = await freePort();
    const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    const launch = (extensionTestsPath: string) =>
      runTests({
        extensionDevelopmentPath: root,
        extensionTestsPath,
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

    expect(await launch(suite)).toBe(0);
    expect(requests[MARKERS.lane]).toHaveLength(3);
    expect(requests[MARKERS.slow]).toHaveLength(2);
    const applied = await readFile(path.join(workspace, 'a.ts'), 'utf8');
    expect(applied).toBe(FILES['a.ts'].replace(EDIT.old_str, EDIT.new_str));
    expect(git(workspace, 'worktree', 'list').toString().trim().split('\n')).toHaveLength(1);

    // Same workspace, user data and GCODE_HOME: a window reload, as far as the extension can tell.
    window?.browser.close();
    window = undefined;
    expect(await launch(await buildSuite(work, 'lanes-reload'))).toBe(0);
    expect(requests[MARKERS.slow], 'the turn was not sent again after the reload').toHaveLength(2);
  }, 900_000);
});
