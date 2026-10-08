import { readdir, readFile, mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, fakeModel, say, type FakeToolUse } from '../../engine/test/fake-model.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { cachePath, root, setUp } from './launch.js';
import { capturePanel, resizeSideBar } from './media.js';
import { captureWindow, freePort } from './screenshot.js';
import { COMMAND, FILES } from './suite/permissions-fixture.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';
const READY = '.transcript';
const shots = process.env['GCODE_SCREENSHOTS'];

let nextId = 0;
const bash = (command: string): FakeToolUse => ({ id: `tu_bash_${nextId++}`, name: 'bash', input: { command } });

const model = fakeModel({
  script: [call('Listing the folder above.', [bash(COMMAND)]), say('Listed it.'), call('Listing it again.', [bash(COMMAND)]), say('Listed it again.')],
});

let debugPort = 0;
let window: Window | undefined;

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const UI: Readonly<Record<string, (action: any, window: Window) => Promise<unknown>>> = {
  eval: async ({ expression }, w) => evaluate(await webview(w, EXTENSION, READY), expression),
  click: async ({ selector }, w) => click(await webview(w, EXTENSION, READY), selector),
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
  void model.handle(req, res).then((handled) => {
    if (handled) return;
    const route = ROUTES[`${req.method} ${req.url?.split('?')[0]}`];
    if (route === undefined) res.writeHead(404).end();
    else void route(req, res);
  });
});

beforeAll(() => new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve)));
afterAll(() => {
  window?.browser.close();
  fake.closeAllConnections();
  return new Promise<void>((resolve) => fake.close(() => resolve()));
});

describe('remembered permission rules in the panel', () => {
  it('saves a rule from the card so the command runs unasked next time, and lists, adds, refuses and removes rules in Settings', async () => {
    // Full detail keeps a finished turn's card in view, so the suite can read how it settled.
    const { workspace, home, suite, launchArgs } = await setUp('permissions', FILES, { 'gcode.chat.detail': 'full' });
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
    expect(model.misses).toEqual([]);
    expect(model.requests).toHaveLength(4);

    const dir = path.join(home, 'permissions');
    const [file, ...others] = await readdir(dir);
    expect(others).toEqual([]);
    const saved = JSON.parse(await readFile(path.join(dir, file!), 'utf8'));
    expect(saved).toMatchObject({ version: 1, rules: [{ effect: 'deny', pattern: ['pnpm', 'publish'] }] });
    const inRepo = (await readdir(workspace, { withFileTypes: true, recursive: true })).filter((e) => e.isFile() && !e.parentPath.includes(`${path.sep}.git`)).map((e) => path.join(e.parentPath, e.name));
    const texts = await Promise.all(inRepo.map((f) => readFile(f, 'utf8')));
    expect(texts.filter((text) => text.includes('publish')), 'no rule is written into the repository').toEqual([]);
  }, 600_000);
});
