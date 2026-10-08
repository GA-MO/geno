import { readdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeOAuth, type FakeOAuth } from '../../engine/test/fake-oauth.js';
import { answer, loadTools, offeredTools, sseBody, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { setUp } from './launch.js';
import { leaseWindow } from './pool/client.js';
import { EXPIRE_ROUTE, SERVER } from './suite/mcp-sign-in-fixture.js';

const EXTENSION = 'g-code.g-code';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const MODEL = 'qwen3.8-flash';
const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});
const ECHO = `mcp__${SERVER}__echo`;

const replies: readonly Reply[] = [
  asModel(answer('docs needs you to sign in first.', usage)),
  asModel(toolCall('', [loadTools(ECHO)], usage)),
  asModel(toolCall('Echoing.', [{ id: 'tu_echo_hi', name: ECHO, input: { text: 'hi' } }], usage)),
  asModel(answer('It said hi back.', usage)),
  asModel(toolCall('', [loadTools(ECHO)], usage)),
  asModel(toolCall('Echoing again.', [{ id: 'tu_echo_again', name: ECHO, input: { text: 'again' } }], usage)),
  asModel(answer('It said again back.', usage)),
  asModel(answer('docs needs you to sign in again.', usage)),
];

const NEEDS_SIGN_IN = `- ${SERVER}: needs sign-in; ask the user to sign in to it in the editor's MCP servers view.`;

/** Every request body the fake model saw, as sent. */
const bodies: string[] = [];
const requests: { tools: { name: string }[]; messages: unknown[] }[] = [];
let debugPort = 0;
let window: Window | undefined;
let oauth: FakeOAuth;

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
};

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  'POST /v1/messages': async (req, res) => {
    const body = await bodyOf(req);
    bodies.push(body);
    const reply = replies[requests.push(JSON.parse(body)) - 1];
    if (reply === undefined) res.writeHead(500).end(`no reply for request ${requests.length - 1}`);
    else res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseBody(reply));
  },
  [`POST ${EXPIRE_ROUTE}`]: async (_req, res) => {
    oauth.expireAccess();
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

beforeAll(async () => {
  oauth = await fakeOAuth();
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
});
afterAll(async () => {
  window?.browser.close();
  await oauth.close();
  await new Promise<void>((resolve) => fake.close(() => resolve()));
});

/** Every file under `dir`, with its text. */
async function filesUnder(dir: string): Promise<{ file: string; text: string }[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  return Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => ({ file: path.join(entry.parentPath, entry.name), text: await readFile(path.join(entry.parentPath, entry.name), 'latin1') })));
}

const textOfRequest = (index: number): string => JSON.stringify(requests[index]!.messages);

describe('MCP sign-in through VS Code', () => {
  it('approves, signs in from the panel, refreshes an expired token, and signs out, while the model never sees a credential', async () => {
    const { workspace, work, home, suite } = await setUp(
      'mcp-sign-in',
      { '.vscode/mcp.json': JSON.stringify({ servers: { [SERVER]: { type: 'http', url: oauth.mcpUrl } } }), 'a.ts': 'export const a = 1;\n' },
      { 'gcode.approvalMode': 'auto', 'gcode.chat.detail': 'full', 'chat.mcp.enabled': false, 'chat.mcp.access': 'none', 'chat.mcp.autostart': 'never' },
    );
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
      GCODE_OPEN_EXTERNAL: 'fetch',
    });

    expect(requests).toHaveLength(replies.length);
    expect(textOfRequest(0), 'T-MCP-02: the model is told to ask the user').toContain(NEEDS_SIGN_IN);
    expect(offeredTools(requests[0]!).filter((name) => name.startsWith(`mcp__${SERVER}__`)), 'and gets no tool of it').toEqual([]);
    expect(JSON.stringify(requests[3]!.messages), 'after sign-in the tool works').toContain('echo: hi');
    expect(JSON.stringify(requests[6]!.messages), 'an expired token is refreshed and the call works').toContain('echo: again');
    expect(oauth.log.filter((entry) => !entry.startsWith('mcp:'))).toEqual(['register', 'authorize', 'token:authorization_code', 'token:refresh_token']);
    expect(textOfRequest(7), 'after sign-out the model is told again').toContain(NEEDS_SIGN_IN);
    expect(textOfRequest(7).split(NEEDS_SIGN_IN).length - 1, 'once at the start and once after sign-out').toBe(2);

    expect(oauth.issued.length).toBe(4);
    for (const [index, body] of bodies.entries()) {
      for (const token of oauth.issued) expect(body.includes(token), `request ${index} carries no token`).toBe(false);
    }
    for (const { file, text } of [...(await filesUnder(home)), ...(await filesUnder(workspace))]) {
      for (const token of oauth.issued) expect(text.includes(token), `${file} holds no token`).toBe(false);
    }
  }, 600_000);
});
