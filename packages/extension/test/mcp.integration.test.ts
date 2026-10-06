import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, loadTools, offeredTools, sseBody, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { cachePath, root, setUp } from './launch.js';
import { captureWindow, freePort } from './screenshot.js';
import { ENV, USER_SERVER, WORKSPACE_SERVER } from './suite/mcp-fixture.js';

const EXTENSION = 'g-code.g-code';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
// Vitest runs from the repository root.
const FIXTURE = path.resolve('packages/engine/test/fake-mcp-server.ts');
const TSX = pathToFileURL(createRequire(path.resolve('package.json')).resolve('tsx')).href;

/** How both config files start the fake MCP server: this node, with tsx, so the server needs no build. */
const fakeServer = (marker: string) => ({ type: 'stdio', command: process.execPath, args: ['--import', TSX, FIXTURE], env: { MARKER: marker } });

const MODEL = 'qwen3.8-flash';
const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

const replies: readonly Reply[] = [
  asModel(answer('I can reach the user server.', usage)),
  asModel(toolCall('', [loadTools(`mcp__${USER_SERVER}__echo`)], usage)),
  asModel(toolCall('Echoing.', [{ id: 'tu_echo', name: `mcp__${USER_SERVER}__echo`, input: { text: 'hi' } }], usage)),
  asModel(answer('It said hi back.', usage)),
];

const requests: { tools: { name: string }[]; messages: unknown[] }[] = [];
const toolNames = (index: number) => offeredTools(requests[index]!);
const shots = process.env['GCODE_SCREENSHOTS'];
let debugPort = 0;
let window: Window | undefined;

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
  screenshot: async ({ name }) => {
    if (shots !== undefined) await captureWindow(debugPort, path.resolve(shots, `${name}.png`));
  },
};

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  'POST /v1/messages': async (req, res) => {
    const reply = replies[requests.push(JSON.parse(await bodyOf(req))) - 1];
    if (reply === undefined) res.writeHead(500).end(`no reply for request ${requests.length - 1}`);
    else res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseBody(reply));
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

describe('MCP servers in the chat panel', () => {
  it('forwards only the user mcp.json, holds the workspace server behind a trust card with its exact command, and runs it once allowed', async () => {
    const markers = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-mcp-markers-')));
    const workspaceMarker = path.join(markers, 'workspace-server-ran');
    const workspaceServer = fakeServer(workspaceMarker);
    const { work, home, suite, launchArgs } = await setUp(
      'mcp',
      { '.vscode/mcp.json': JSON.stringify({ servers: { [WORKSPACE_SERVER]: workspaceServer } }), 'a.ts': 'export const a = 1;\n' },
      // VS Code's own MCP support stays off, so only Geno could start these servers.
      // Full detail draws the steps of finished turns, which these assertions name, as the panel did before U17.
      { 'gcode.approvalMode': 'auto', 'gcode.chat.detail': 'full', 'chat.mcp.enabled': false, 'chat.mcp.access': 'none', 'chat.mcp.autostart': 'never' },
    );
    // The user's VS Code mcp.json, beside settings.json in the user data folder the window runs with.
    await mkdir(path.join(work, 'ud', 'User'), { recursive: true });
    await writeFile(path.join(work, 'ud', 'User', 'mcp.json'), `// mine\n${JSON.stringify({ servers: { [USER_SERVER]: fakeServer(path.join(markers, 'user-server-ran')) } }, null, 2)}\n`);
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
        [ENV.workspaceMarker]: workspaceMarker,
        [ENV.workspaceCommand]: [process.execPath, '--import', TSX, FIXTURE].join(' '),
      },
    });
    expect(code).toBe(0);
    expect(requests).toHaveLength(replies.length);
    expect(toolNames(0)).toContain(`mcp__${USER_SERVER}__echo`);
    expect(toolNames(0).filter((name) => name.startsWith(`mcp__${WORKSPACE_SERVER}__`)), 'the model never saw the workspace server before Allow').toEqual([]);
    expect(toolNames(1), 'once allowed, its tools join the next turn').toContain(`mcp__${WORKSPACE_SERVER}__echo`);
    expect(JSON.stringify(requests[3]!.messages)).toContain('echo: hi');
  }, 600_000);
});
