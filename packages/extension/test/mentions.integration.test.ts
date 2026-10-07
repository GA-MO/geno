import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GENO_NOTE } from '@g-code/core';
import { answer, sseBody, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { cachePath, root, setUp } from './launch.js';
import { captureWindow, freePort } from './screenshot.js';
import { FILES, PROMPT, UNSAVED } from './suite/mentions-fixture.js';

const EXTENSION = 'g-code.g-code';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

const replies: readonly Reply[] = [
  toolCall('Searching.', [{ id: 'tu_grep', name: 'grep', input: { pattern: 'draftOnly|three' } }], usage),
  answer('math.ts has an unsaved draftOnly, and the selection declares two and three.', usage),
];

const requests: any[] = [];
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

describe('mentions in VS Code', () => {
  it('completes @file and @selection in the composer, sends them as context, and greps the unsaved buffer', async () => {
    const { home, suite, launchArgs } = await setUp('mentions', FILES, {});
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
        DASHSCOPE_API_KEY: 'sk-fake',
        DASHSCOPE_BASE_URL: url,
        GCODE_FAKE_MODEL: url,
      },
    });
    expect(code).toBe(0);
    expect(requests).toHaveLength(replies.length);

    // The opening also carries Geno's own notes, such as the environment; the user's blocks follow them in order.
    const [prompt, attached] = requests[0].messages[0].content.map((block: { text: string }) => block.text).filter((text: string) => !text.startsWith(GENO_NOTE));
    expect(prompt).toBe(PROMPT);
    expect(attached).toContain(`<context_item kind="file" path="math.ts">\n1\texport function add(a: number, b: number): number {\n2\t  return a + b;\n3\t}\n4\t${UNSAVED.trimEnd()}\n</context_item>`);
    expect(attached).toContain('<context_item kind="selection" path="notes/selected.ts" lines="2-3">\n2\tconst two = 2;\n3\tconst three = 3;\n</context_item>');

    const grep = requests[1].messages.at(-1).content.find((block: { type: string }) => block.type === 'tool_result');
    expect(grep.content).toBe(`math.ts:4:${UNSAVED.trimEnd()}\nnotes/selected.ts:3:const three = 3;`);
  }, 600_000);
});
