import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runTests } from '@vscode/test-electron';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, loadTools, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { cachePath, root, setUp } from './launch.js';
import { freePort } from './screenshot.js';
import { ANSWER, FILES, PAGES, PROMPT, WIDGET, WIDGET_TITLE } from './suite/share-page-fixture.js';

const EXTENSION = 'g-code.g-code';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const shots = process.env['GCODE_SCREENSHOTS'];

const requests: unknown[] = [];
let debugPort = 0;
let window: Window | undefined;
let replies: Reply[] = [];

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const sse = (event: { type: string }) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

const UI: Readonly<Record<string, (action: any, window: Window) => Promise<unknown>>> = {
  eval: async ({ expression }, w) => evaluate(await webview(w, EXTENSION, '.transcript'), expression),
  click: async ({ selector, text }, w) => click(await webview(w, EXTENSION, '.transcript'), selector, text),
  type: async ({ text }, w) => typeText(await webview(w, EXTENSION, '.transcript'), text),
  press: async ({ key, modifiers }, w) => press(await webview(w, EXTENSION, '.transcript'), key, modifiers),
  workbench: async ({ expression }, w) => {
    const { result, exceptionDetails } = await w.page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails !== undefined) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  },
};

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  'POST /v1/messages': async (req, res) => {
    const reply = replies[requests.push(JSON.parse(await bodyOf(req))) - 1];
    if (reply === undefined) return void res.writeHead(500).end(`no reply for request ${requests.length - 1}`);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of reply.events) res.write(sse(event));
    res.end();
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

let browser: Browser | undefined;

beforeAll(() => new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve)));
afterAll(async () => {
  window?.browser.close();
  await browser?.close();
  return new Promise<void>((resolve) => fake.close(() => resolve()));
});

type Opened = {
  readonly blocked: readonly string[];
  readonly title: string;
  readonly widget: readonly string[];
  readonly frameHeight: number;
  readonly images: readonly number[];
  readonly background: string;
  readonly overflow: number;
};

/**
 * Opens a saved page in headless Chromium at phone width, with every request but the page's own file intercepted and
 * refused, and reads what it shows. `blocked` is what tried to reach the network: it must stay empty.
 */
async function open(file: string, scheme: 'light' | 'dark', shot?: string): Promise<Opened> {
  browser ??= await chromium.launch(process.env['GCODE_CHROMIUM'] ? { executablePath: process.env['GCODE_CHROMIUM'] } : {});
  const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const url = pathToFileURL(file).href;
  const blocked: string[] = [];
  await context.route('**/*', (route) => {
    if (route.request().url() === url) return route.continue();
    blocked.push(route.request().url());
    return route.abort();
  });
  const tab = await context.newPage();
  await tab.goto(url);
  const frame = tab.frames().find((f) => f !== tab.mainFrame());
  await frame?.waitForFunction(() => document.querySelectorAll('.bar').length > 0, undefined, { timeout: 10_000 });
  await tab.waitForFunction(() => [...document.images].every((image) => image.complete));
  await tab.waitForTimeout(500);
  const opened: Opened = {
    blocked,
    title: await tab.locator('h1.page-title').innerText(),
    widget: (await frame?.locator('.bar').allInnerTexts()) ?? [],
    frameHeight: await tab.evaluate(() => document.querySelector('iframe')?.getBoundingClientRect().height ?? 0),
    images: await tab.evaluate(() => [...document.images].map((image) => image.naturalWidth)),
    background: await tab.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
    overflow: await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  };
  if (shot !== undefined) await tab.screenshot({ path: shot, fullPage: true });
  await context.close();
  return opened;
}

/** The same interception, on a page with no policy that does load a remote image: it shows the check would see a leak. */
async function control(): Promise<readonly string[]> {
  browser ??= await chromium.launch(process.env['GCODE_CHROMIUM'] ? { executablePath: process.env['GCODE_CHROMIUM'] } : {});
  const context = await browser.newContext();
  const blocked: string[] = [];
  await context.route('**/*', (route) => (blocked.push(route.request().url()), route.abort()));
  const tab = await context.newPage();
  await tab.setContent('<img src="https://beacon.example/control.png">');
  await tab.waitForTimeout(500);
  await context.close();
  return blocked;
}

describe('Save as page', () => {
  it('saves a widget and an answer as pages that open in a browser, show their content and make no request', async () => {
    replies = [
      toolCall('', [loadTools('show_widget')], usage),
      toolCall('Here is where the time goes.', [{ id: 'tu_bars', name: 'show_widget', input: { title: WIDGET_TITLE, html: WIDGET } }], usage),
      answer(ANSWER, usage),
    ];
    const { home, workspace, suite, launchArgs } = await setUp('share-page', FILES, {});
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
        GCODE_TEST_WORKSPACE: workspace,
      },
    });
    expect(code).toBe(0);
    expect(requests).toHaveLength(replies.length);

    expect(await control(), 'the interception sees a page that does reach the network').toEqual(['https://beacon.example/control.png']);
    if (shots !== undefined) await mkdir(shots, { recursive: true });
    for (const scheme of ['light', 'dark'] as const) {
      const shot = (name: string) => (shots === undefined ? undefined : path.resolve(shots, `${name}-${scheme}.png`));
      const widget = await open(path.join(workspace, PAGES.widget), scheme, shot('widget-page'));
      expect(widget.blocked, `the widget page in ${scheme} makes no request`).toEqual([]);
      expect(widget.title).toBe(WIDGET_TITLE);
      expect(widget.widget, "the widget's script ran inside its frame").toEqual(['Type check 64%', 'Bundle 24%', 'Lint 12%']);
      expect(widget.frameHeight, 'the frame took its content’s height').toBeGreaterThan(100);
      expect(widget.overflow, 'nothing scrolls sideways at phone width').toBe(0);

      const page = await open(path.join(workspace, PAGES.answer), scheme, shot('answer-page'));
      expect(page.blocked, `the answer page in ${scheme} makes no request`).toEqual([]);
      expect(page.title).toBe(PROMPT);
      expect(page.images.length, 'the chart and the diagram').toBe(2);
      expect(page.images.every((width) => width > 0), 'both images decode from their data').toBe(true);
      expect(page.widget, 'the answer carries its widget').toEqual(['Type check 64%', 'Bundle 24%', 'Lint 12%']);
      expect(page.overflow, 'nothing scrolls sideways at phone width').toBe(0);
      expect(page.background).toBe(scheme === 'light' ? 'rgb(245, 245, 245)' : 'rgb(30, 30, 32)');
    }
  }, 600_000);
});
