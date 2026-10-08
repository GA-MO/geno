import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CURSOR_SETUP, type FakeScript, type FakeStep } from '../../engine/test/fake-acp-agent.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { BARE_PATH, root, setUp } from './launch.js';
import { capturePanel, resizeSideBar } from './media.js';
import { captureWindow } from './screenshot.js';
import { leaseWindow } from './pool/client.js';
import { ANSWER, EDITED, FILES, SWITCHED } from './suite/backends-fixture.js';

const EXTENSION = 'g-code.g-code';
const READY = '.transcript';
const FAKE_AGENT = path.join(root, '../engine/test/fake-acp-agent.ts');
/** tsx's loader, by its absolute path: the agent runs in the lane, where no node_modules resolves a bare name. */
const TSX = pathToFileURL(createRequire(path.join(root, '../engine/package.json')).resolve('tsx')).href;
const shots = process.env['GCODE_SCREENSHOTS'];
let debugPort = 0;
let window: Window | undefined;

/** The fake Cursor's one scripted turn: a read, then an edit it asks permission for. */
const TURNS: Record<string, readonly FakeStep[]> = {
  edit: [
    { text: 'Reading first. ' },
    { tool: { id: 'r1', kind: 'read', title: 'Read a.ts', locations: ['a.ts'] } },
    { done: { id: 'r1', status: 'completed', output: FILES['a.ts'] } },
    { tool: { id: 'e1', kind: 'edit', title: 'Edit a.ts', locations: ['a.ts'] } },
    { ask: { id: 'e1', kind: 'edit', title: 'Edit a.ts' } },
    { write: { path: 'a.ts', text: EDITED } },
    { done: { id: 'e1', status: 'completed', output: 'edited a.ts' } },
    { text: ANSWER },
  ],
};

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const UI: Readonly<Record<string, (action: any, window: Window) => Promise<unknown>>> = {
  eval: async ({ expression }, w) => evaluate(await webview(w, EXTENSION, READY), expression),
  workbench: async ({ expression }, w) => (await w.page.send<{ result: { value: unknown } }>('Runtime.evaluate', { expression, returnByValue: true })).result.value,
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
  // Geno's own model is never called: the turn runs on the agent, and the classifier is off.
  'POST /v1/messages': async (_req, res) => void res.writeHead(500).end('no model call expected'),
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

describe('an external agent as a chat backend in the panel', () => {
  it('picks Cursor from the model menu, switches its model, runs a turn with a permission card, and applies its lane for review', async () => {
    const { work, workspace, home, suite } = await setUp('backends', FILES, { 'gcode.approvalMode': 'ask', 'gcode.chat.detail': 'full', 'chat.mcp.enabled': false, 'gcode.review.mode': 'review' });
    git(workspace, 'init', '-q', '-b', 'main');
    git(workspace, 'add', '-A');
    git(workspace, 'commit', '-q', '--no-verify', '-m', 'start');
    // An empty home and a PATH of the fake alone, so the user's own Cursor and Claude Code are never found.
    const bin = path.join(work, 'bin');
    const userHome = path.join(work, 'user-home');
    await Promise.all([bin, userHome].map((dir) => mkdir(dir, { recursive: true })));
    const calls = path.join(work, 'agent-calls.jsonl');
    const script: FakeScript = { log: calls, setup: CURSOR_SETUP, turns: TURNS };
    const scriptFile = path.join(work, 'agent-script.json');
    await writeFile(scriptFile, JSON.stringify(script));
    await writeFile(path.join(bin, 'agent'), `#!/bin/sh\nFAKE_ACP_SCRIPT='${scriptFile}' exec '${process.execPath}' --import '${TSX}' '${FAKE_AGENT}' "$@"\n`);
    await chmod(path.join(bin, 'agent'), 0o755);
    if (shots !== undefined) await mkdir(shots, { recursive: true });
    const vscodeWindow = await leaseWindow();
    debugPort = vscodeWindow.debugPort;
    const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

    await vscodeWindow.run(suite, { workspace, work }, {
      PATH: `${bin}:${BARE_PATH}`,
      HOME: userHome,
      GCODE_HOME: home,
      GCODE_PROVIDER: 'modelstudio',
      GCODE_MODEL: 'qwen3.8-flash',
      DASHSCOPE_API_KEY: 'sk-fake',
      DASHSCOPE_BASE_URL: url,
      GCODE_FAKE_MODEL: url,
      GCODE_CLASSIFIER_MODEL: 'off',
      // The fake agent's sandbox is not what this test is about; backend.e2e.test.ts covers it.
      GCODE_BACKEND_SANDBOX: 'off',
    });

    expect(existsSync(calls)).toBe(true);
    const logged = (await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, any>);
    const outcomes = logged.filter((c) => c['permission']).map((c) => c['permission'].outcome.optionId);
    expect(outcomes).toEqual(['allow-once']);
    expect(outcomes).not.toContain('allow-always');
    expect(logged.filter((c) => c['method'] === 'session/set_config_option').map((c) => c['params'])).toContainEqual(expect.objectContaining({ configId: 'model', value: SWITCHED.value }));
    expect(await readFile(path.join(workspace, 'a.ts'), 'utf8')).toBe(EDITED);
  }, 600_000);
});
