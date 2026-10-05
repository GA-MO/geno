import { access, mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLASSIFIER_TOOL } from '@g-code/core';
import { answer, sseBody, toolCall, type FakeToolUse, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { cachePath, root, setUp } from './launch.js';
import { captureWindow, freePort } from './screenshot.js';
import { COMMANDS, FILES, FOLLOW_UP, PLAN, REASONS } from './suite/modes-fixture.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

let nextId = 0;
const bash = (command: string): FakeToolUse => ({ id: `tu_bash_${nextId++}`, name: 'bash', input: { command } });
const verdict = (value: 'allow' | 'ask' | 'deny', reason: string): Reply =>
  toolCall('', [{ id: `tu_verdict_${nextId++}`, name: CLASSIFIER_TOOL.name, input: { verdict: value, reason } }], usage);

/** The classifier answers on the same endpoint as the agent, right after the call it judges. */
const replies: readonly Reply[] = [
  toolCall('Removing the build output.', [bash(COMMANDS.removeBuild)], usage),
  verdict('allow', REASONS.allow),
  toolCall('Trying a script.', [bash(COMMANDS.script)], usage),
  verdict('deny', REASONS.deny),
  toolCall('Clearing dist too.', [bash(COMMANDS.removeDist)], usage),
  verdict('ask', REASONS.ask),
  asModel(answer('Cleaned the build and dist; I left a.ts alone.', usage)),
  toolCall('Removing it again.', [bash(COMMANDS.removeAgain)], usage),
  asModel(answer('Left it as it is.', usage)),
  toolCall('Looking around first.', [bash('ls')], usage),
  asModel(answer(PLAN, usage)),
  asModel(answer('Renamed it.', usage)),
];

const requests: { tool_choice?: unknown; tools: { name: string }[]; messages: { content: { type: string; text?: string }[] }[] }[] = [];
const toolNames = (index: number) => requests[index]!.tools.map((t) => t.name);
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

const exists = (file: string) => access(file).then(() => true, () => false);

describe('Ask and Auto in the chat panel', () => {
  it('starts in the configured mode, badges what Auto settled, asks when the classifier asks, and switches to Ask from the picker', async () => {
    const { home, workspace, suite, launchArgs } = await setUp('modes', FILES, { 'gcode.approvalMode': 'auto' });
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
        GCODE_CLASSIFIER_MODEL: MODEL,
      },
    });
    expect(code).toBe(0);
    expect(requests).toHaveLength(replies.length);
    // Auto asked the classifier three times; Ask and Plan never did.
    expect(requests.map((r) => r.tool_choice !== undefined)).toEqual([false, true, false, true, false, true, false, false, false, false, false, false]);
    expect(toolNames(9)).not.toContain('edit');
    expect(toolNames(10)).not.toContain('edit');
    // Start building left Plan for the configured default, Auto, and sent the follow-up.
    expect(toolNames(11)).toContain('edit');
    expect(requests[11]!.messages.at(-1)!.content.at(-1)).toMatchObject({ type: 'text', text: FOLLOW_UP });
    expect(await exists(path.join(workspace, 'build'))).toBe(false);
    expect(await exists(path.join(workspace, 'dist'))).toBe(false);
    expect(await exists(path.join(workspace, 'a.ts'))).toBe(true);
  }, 600_000);
});
