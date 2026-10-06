import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { BARE_PATH, cachePath, root, setUp } from './launch.js';
import { capturePanel, resizeSideBar } from './media.js';
import { captureWindow, freePort } from './screenshot.js';
import { ENV, FAKE } from './suite/agents-fixture.js';

const EXTENSION = 'g-code.g-code';
const READY = '.transcript';
const shots = process.env['GCODE_SCREENSHOTS'];
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

describe('the Agents section of the settings page', () => {
  it('finds no Cursor CLI, then a fake one: signs in with a link, cancels, updates, and signs out after a confirm', async () => {
    const state = path.join(await mkdtemp(path.join(tmpdir(), 'gcode-agent-')), 'state');
    const { work, home, suite, launchArgs } = await setUp('agents', { 'a.ts': 'export const a = 1;\n' }, {}, {
      // The default shell only records what it is sent, so the installer's command is seen and never run.
      'terminal.integrated.profiles.osx': { record: { path: '/bin/sh', args: ['-c', `cat > '${state}/terminal-input'`] } },
      'terminal.integrated.defaultProfile.osx': 'record',
      'terminal.integrated.shellIntegration.enabled': false,
    });
    const bin = path.join(work, 'bin');
    // An empty home, so the user's own ~/.local/bin/agent is never found.
    const userHome = path.join(work, 'user-home');
    await Promise.all([bin, state, userHome].map((dir) => mkdir(dir, { recursive: true })));
    await writeFile(path.join(state, 'version'), FAKE.version);
    if (shots !== undefined) await mkdir(shots, { recursive: true });
    debugPort = await freePort();
    const url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

    const code = await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: suite,
      cachePath,
      ...(process.env['GCODE_VSCODE_VERSION'] ? { version: process.env['GCODE_VSCODE_VERSION'] } : {}),
      launchArgs: [...launchArgs, '--use-inmemory-secretstorage', `--remote-debugging-port=${debugPort}`],
      extensionTestsEnv: {
        PATH: `${bin}:${BARE_PATH}`,
        HOME: userHome,
        GCODE_HOME: home,
        GCODE_PROVIDER: 'modelstudio',
        GCODE_MODEL: 'qwen3.8-flash',
        DASHSCOPE_API_KEY: 'sk-fake',
        DASHSCOPE_BASE_URL: url,
        GCODE_FAKE_MODEL: url,
        GCODE_CLASSIFIER_MODEL: 'off',
        [ENV.bin]: bin,
        [ENV.state]: state,
      },
    });
    expect(code).toBe(0);
  }, 600_000);
});
