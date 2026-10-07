import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeCheck, fakeGh, FAKE_PR, type FakeGhStage } from '../../engine/test/fake-gh.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { cachePath, root, setUp } from './launch.js';
import { capturePanel, resizeSideBar } from './media.js';
import { captureWindow, freePort } from './screenshot.js';
import { FILES, TITLE, type StageName } from './suite/pr-status-fixture.js';

const EXTENSION = 'g-code.g-code';
const PR = { ...FAKE_PR, title: TITLE };
const STAGED: Readonly<Record<StageName, FakeGhStage>> = {
  pending: { pr: PR, checks: [fakeCheck('lint', 'pass', 455), fakeCheck('test', 'pending', 456)] },
  failing: { pr: PR, checks: [fakeCheck('lint', 'pass', 455), fakeCheck('test', 'fail', 456)] },
  'logged-out': { loggedOut: true, checks: [] },
};
// The line looks again every 1.5s while a check is pending, where the product waits a minute.
const REFRESH = { pendingMs: 1500, minGapMs: 500 };

const shots = process.env['GCODE_SCREENSHOTS'];
let debugPort = 0;
let failure: string | undefined;
let modelCalls = 0;
let window: Window | undefined;
let gh: Awaited<ReturnType<typeof fakeGh>>;

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
  'POST /v1/messages': async (_req, res) => {
    modelCalls++;
    res.writeHead(500).end('the status line calls no model');
  },
  'POST /stage': async (req, res) => {
    await gh.stage(STAGED[(await bodyOf(req)) as StageName]);
    res.writeHead(200).end();
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

describe('the PR status line in VS Code', () => {
  it("shows the branch's PR and its checks, follows a check from pending to failing by itself, fits at 300px, and says how to log in to gh", async () => {
    gh = await fakeGh(STAGED.pending);
    const { home, suite, launchArgs } = await setUp('pr-status', FILES, { 'gcode.approvalMode': 'auto', 'chat.mcp.enabled': false });
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
        GCODE_MODEL: 'qwen3.8-flash',
        DASHSCOPE_API_KEY: 'sk-fake-provider-key-0123456789',
        DASHSCOPE_BASE_URL: url,
        GCODE_FAKE_MODEL: url,
        GCODE_CLASSIFIER_MODEL: 'off',
        GCODE_PR_REFRESH: JSON.stringify(REFRESH),
        PATH: gh.path,
      },
    });
    expect(failure).toBeUndefined();
    expect(code).toBe(0);
    expect(modelCalls).toBe(0);

    const calls = await gh.calls();
    expect(new Set(calls.map((c) => c.args.join(' '))), 'the line runs only the two read-only look-ups').toEqual(
      new Set(['pr view --json number,title,url,state,isDraft,reviewDecision,headRefName', 'pr checks --json name,workflow,bucket,link']),
    );
    expect(calls.every((c) => !c.env.includes('DASHSCOPE_API_KEY')), 'gh never sees the provider key').toBe(true);
    const views = calls.filter((c) => c.args[1] === 'view').map((c) => c.at);
    const gaps = views.slice(1).map((at, i) => at - views[i]!);
    expect(Math.min(...gaps), 'no look comes sooner than the shortest gap').toBeGreaterThanOrEqual(REFRESH.minGapMs - 50);
  }, 600_000);
});
