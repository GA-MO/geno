import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GENO_NOTE } from '@g-code/core';
import { answer, sseBody, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { twoColorPng } from '../../core/test/png.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { cachePath, root, setUp } from './launch.js';
import { captureWindow, freePort } from './screenshot.js';
import { ANSWER, FILES, IMAGES } from './suite/attachments-fixture.js';

const EXTENSION = 'g-code.g-code';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

const PNGS = {
  [IMAGES.flag]: twoColorPng(320, 160, [220, 40, 40], [40, 80, 220]),
  [IMAGES.big]: twoColorPng(2000, 1000, [240, 200, 40], [40, 160, 90]),
  [IMAGES.shot]: twoColorPng(240, 120, [255, 255, 255], [20, 20, 20]),
};

const MODEL = 'qwen3.8-flash';

const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

const replies: readonly Reply[] = [
  asModel(toolCall('Looking at the shot.', [{ id: 'tu_read_shot', name: 'read', input: { path: IMAGES.shot } }], usage)),
  asModel(answer(ANSWER, usage)),
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
  pointerAway: async (_action, w) => w.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 300 }),
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

const image = (png: Buffer) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } });

describe('attachments in VS Code', () => {
  it('pastes and drops files into the composer, sends the image to the model, and shows images in the transcript', async () => {
    // The read's thumbnail is on a step of the finished turn, which full detail draws as the panel did before U17.
    const { workspace, home, suite, launchArgs } = await setUp('attachments', FILES, { 'gcode.chat.detail': 'full' });
    for (const [name, png] of Object.entries(PNGS)) await writeFile(path.join(workspace, name), png);
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
      },
    });
    expect(code).toBe(0);
    expect(requests).toHaveLength(replies.length);

    // The opening also carries Geno's own notes, such as the environment; the user's blocks follow them in order.
    const [sent, prompt, attached] = requests[0].messages[0].content
      .map(({ cache_control: _, ...block }: { cache_control?: unknown }) => block)
      .filter((block: { text?: string }) => !block.text?.startsWith(GENO_NOTE));
    expect(sent).toEqual(image(PNGS[IMAGES.flag]));
    expect(prompt.text).toBe('What colors are in the flag, and what does shot.png show?');
    expect(attached.text).toContain(`<context_item kind="file" path="notes.md">\n1\t# Colors\n2\t\n3\tThe flag is red on the left and blue on the right.\n</context_item>`);

    const result = requests[1].messages.at(-1).content.find((block: { type: string }) => block.type === 'tool_result');
    expect(result.content).toEqual([{ type: 'text', text: `shot.png is a 240x120 PNG image (${PNGS[IMAGES.shot].length} B), attached below.` }, image(PNGS[IMAGES.shot])]);
  }, 600_000);
});
