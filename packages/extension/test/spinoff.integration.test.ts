import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, loadTools, sseBody, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { buildSuite, cachePath, root, setUp } from './launch.js';
import { capturePanel, resizeSideBar } from './media.js';
import { captureWindow, freePort } from './screenshot.js';
import { ANSWERS, FILES, MARKERS, SUGGESTIONS } from './suite/spinoff-fixture.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

const spawn = ({ toolUseId, title, tldr, prompt }: (typeof SUGGESTIONS)[keyof typeof SUGGESTIONS]) => ({ id: toolUseId, name: 'spawn_task', input: { title, tldr, prompt } });

/** One script per conversation, picked by the marker in its first message. */
const SCRIPTS: Readonly<Record<string, readonly Reply[]>> = {
  [MARKERS.chat]: [
    asModel(toolCall('Loading.', [loadTools('spawn_task', 'dismiss_task')], usage)),
    asModel(toolCall('Two things I noticed.', [spawn(SUGGESTIONS.helper), spawn(SUGGESTIONS.test)], usage)),
    asModel(answer(ANSWERS.chat, usage)),
  ],
  [MARKERS.task]: [asModel(answer(ANSWERS.task, usage))],
};

type Body = { messages: { role: string; content: string | { type: string; text?: string }[] }[]; tools?: { name: string; description?: string }[] };
const requests: Record<string, Body[]> = {};
const shots = process.env['GCODE_SCREENSHOTS'];
let debugPort = 0;
let failure: string | undefined;
let window: Window | undefined;

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const READY = '.transcript';

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
  'POST /v1/messages': async (req, res) => {
    const body = JSON.parse(await bodyOf(req)) as Body;
    const first = JSON.stringify(body.messages[0]);
    const marker = Object.values(MARKERS).find((m) => first.includes(m));
    if (marker === undefined) {
      res.writeHead(500).end(`no script for ${first.slice(0, 200)}`);
      return;
    }
    const seen = (requests[marker] ??= []);
    const reply = SCRIPTS[marker]![seen.push(body) - 1];
    if (reply === undefined) {
      res.writeHead(500).end(`no reply ${seen.length - 1} for ${marker}`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseBody(reply));
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

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', ...args], { stdio: 'pipe' });

const lastText = (body: Body): string | undefined => {
  const content = body.messages[0]!.content;
  return typeof content === 'string' ? content : content.findLast((block) => block.type === 'text')?.text;
};

describe('suggested tasks in the panel', () => {
  it('draws the cards, starts one as a lane task with its prompt, dismisses one, and keeps both through a reload', async () => {
    const { work, workspace, home, suite, launchArgs } = await setUp('spinoff', FILES, { 'gcode.approvalMode': 'auto', 'gcode.chat.detail': 'full', 'chat.mcp.enabled': false });
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
    expect(failure).toBeUndefined();
    expect(requests[MARKERS.chat]).toHaveLength(3);
    const block = requests[MARKERS.chat]![0]!.tools?.find((tool) => tool.name === 'tool_search')?.description ?? '';
    expect(block, 'the panel advertises the cards, so the chat lists spawn_task').toContain('- spawn_task: ');
    expect(requests[MARKERS.task], 'Start ran the suggestion once').toHaveLength(1);
    expect(lastText(requests[MARKERS.task]![0]!), "the task's first message is the suggestion's prompt").toBe(SUGGESTIONS.helper.prompt);
    expect(git(workspace, 'status', '--porcelain', '--', '.', ':!.vscode').toString(), 'the main checkout is untouched, but for the settings VS Code writes').toBe('');

    // Same workspace, user data and GCODE_HOME: a window reload, as far as the extension can tell.
    window?.browser.close();
    window = undefined;
    expect(await launch(await buildSuite(work, 'spinoff-reload'))).toBe(0);
    expect(failure).toBeUndefined();
    expect(requests[MARKERS.chat], 'the reload sent nothing to the model').toHaveLength(3);
    expect(requests[MARKERS.task]).toHaveLength(1);
  }, 900_000);
});
