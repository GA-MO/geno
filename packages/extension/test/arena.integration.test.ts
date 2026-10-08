import { execFileSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEEDS } from '@g-code/core';
import { answer, handBack, sseBody, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { setUp } from './launch.js';
import { capturePanel } from './media.js';
import { captureWindow } from './screenshot.js';
import { leaseWindow } from './pool/client.js';
import { FILES, GRAFTED, REASONS, REVIEW_MARKER, SUMMARY, TASK } from './suite/arena-fixture.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

/** `hold` keeps a reply back until the suite releases it by name. */
type Scripted = { readonly reply: Reply; readonly hold?: string };

const read = (id: string, file: string) => ({ id, name: 'read', input: { path: file } });
const edit = (id: string, file: string, from: string, to: string) => ({ id, name: 'edit', input: { path: file, old_str: from, new_str: to } });

/**
 * Each lane's turns by step. A and B both make line two "Two"; A also adds a line, B also changes b.ts, and C writes
 * BAD, which fails the check. Every lane's first reply waits for the suite, so the race can be seen running.
 */
const SCRIPTS: Readonly<Record<'A' | 'B' | 'C' | 'review', readonly Scripted[]>> = {
  A: [
    { reply: asModel(toolCall('Reading.', [read('tu_a0', 'a.ts')], usage)), hold: 'race' },
    { reply: asModel(toolCall('Editing.', [edit('tu_a1', 'a.ts', 'two', 'Two')], usage)) },
    { reply: asModel(toolCall('And a line.', [edit('tu_a2', 'a.ts', 'three', 'three\nfour')], usage)) },
    { reply: asModel(answer('Done in A.', usage)) },
  ],
  B: [
    { reply: asModel(toolCall('Reading.', [read('tu_b0', 'a.ts'), read('tu_b00', 'b.ts')], usage)), hold: 'race' },
    { reply: asModel(toolCall('Editing.', [edit('tu_b1', 'a.ts', 'two', 'Two'), edit('tu_b2', 'b.ts', 'x', 'y')], usage)) },
    { reply: asModel(answer('Done in B.', usage)) },
  ],
  C: [
    { reply: asModel(toolCall('Reading.', [read('tu_c0', 'a.ts')], usage)), hold: 'race' },
    { reply: asModel(toolCall('Editing.', [edit('tu_c1', 'a.ts', 'two', 'BAD')], usage)) },
    { reply: asModel(answer('Done in C.', usage)) },
  ],
  review: [
    {
      reply: asModel(
        handBack(['B wins.', '```json', JSON.stringify({ ranking: [{ lane: 'B', reason: REASONS.B }, { lane: 'A', reason: REASONS.A }], summary: SUMMARY }), '```'].join('\n'), usage),
      ),
      hold: 'review',
    },
  ],
};

/** Which conversation a request belongs to, by its first message: the review's task, else the lane's seed. */
function scriptOf(first: string): keyof typeof SCRIPTS | undefined {
  if (first.includes(REVIEW_MARKER)) return 'review';
  if (!first.includes(TASK)) return undefined;
  if (first.includes(SEEDS.minimal.text)) return 'B';
  if (first.includes(SEEDS.idiomatic.text)) return 'C';
  return 'A';
}

const requests: Record<string, unknown[]> = {};
const shots = process.env['GCODE_SCREENSHOTS'];
let debugPort = 0;
let window: Window | undefined;
const releases = new Map<string, () => void>();
const holds = new Map(['race', 'review'].map((name) => [name, new Promise<void>((resolve) => releases.set(name, resolve))]));

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const READY = '.transcript';

const UI: Readonly<Record<string, (action: any, window: Window) => Promise<unknown>>> = {
  eval: async ({ expression }, w) => evaluate(await webview(w, EXTENSION, READY), expression),
  workbench: async ({ expression }, w) =>
    (await w.page.send<{ result: { value: unknown } }>('Runtime.evaluate', { expression, returnByValue: true })).result.value,
  click: async ({ selector, text }, w) => click(await webview(w, EXTENSION, READY), selector, text),
  type: async ({ text }, w) => typeText(await webview(w, EXTENSION, READY), text),
  press: async ({ key, modifiers }, w) => press(await webview(w, EXTENSION, READY), key, modifiers),
  pointerAway: async (_action, w) => w.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1000, y: 300 }),
  release: async ({ name }) => releases.get(name)?.(),
  calls: async () => Object.fromEntries(Object.entries(requests).map(([script, seen]) => [script, seen.length])),
  resize: async ({ width }, w) => resizeSideBar(w, width),
  screenshot: async ({ name }, w) => {
    if (shots === undefined) return;
    await captureWindow(debugPort, path.resolve(shots, `${name}.png`));
    await capturePanel(w, path.resolve(shots, `${name}-panel.png`), 2);
  },
};

/** Drags the side bar's edge until the Geno webview is `width` CSS px wide, as a user narrows the panel; its width after. */
async function resizeSideBar(w: Window, width: number): Promise<number> {
  const measure = async () =>
    (
      await w.page.send<{ result: { value: { right: number; mid: number; panel: number } } }>('Runtime.evaluate', {
        expression: `(() => {
          const bar = document.querySelector('.part.sidebar').getBoundingClientRect();
          const frame = [...document.querySelectorAll('iframe')].find((f) => f.src.includes('extensionId=g-code.g-code') && f.getBoundingClientRect().width > 0);
          return { right: bar.right, mid: bar.top + bar.height / 2, panel: frame.getBoundingClientRect().width };
        })()`,
        returnByValue: true,
      })
    ).result.value;
  for (let i = 0; i < 4; i++) {
    const { right, mid, panel } = await measure();
    if (Math.abs(panel - width) < 2) return panel;
    const to = right + (width - panel);
    await w.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: right, y: mid });
    await w.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: right, y: mid, button: 'left', clickCount: 1 });
    for (let step = 1; step <= 8; step++) await w.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: right + ((to - right) * step) / 8, y: mid, button: 'left', buttons: 1 });
    await w.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to, y: mid, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 300));
  }
  return (await measure()).panel;
}

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  'POST /v1/messages': async (req, res) => {
    const body = JSON.parse(await bodyOf(req)) as { messages: { role?: string; content: unknown }[] };
    const first = JSON.stringify(body.messages[0]);
    const script = scriptOf(first);
    if (script === undefined) {
      res.writeHead(500).end(`no script for ${first.slice(0, 200)}`);
      return;
    }
    (requests[script] ??= []).push(body);
    const step = SCRIPTS[script][body.messages.filter((m) => m.role === 'assistant').length];
    if (step === undefined) {
      res.writeHead(500).end(`no reply ${body.messages.length} for ${script}`);
      return;
    }
    if (step.hold !== undefined) await holds.get(step.hold);
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseBody(step.reply));
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

describe('best-of-n in the panel', () => {
  it('previews the cost, races three lanes, ranks and compares them, applies the winner for review and grafts a hunk from another lane', async () => {
    const { work, workspace, home, suite } = await setUp('arena', FILES, { 'gcode.approvalMode': 'ask', 'gcode.chat.detail': 'full', 'chat.mcp.enabled': false, 'gcode.review.mode': 'review' });
    git(workspace, 'init', '-q', '-b', 'main');
    git(workspace, 'add', '-A');
    git(workspace, 'commit', '-q', '--no-verify', '-m', 'start');
    if (shots !== undefined) await mkdir(shots, { recursive: true });
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
    });
    expect(Object.fromEntries(Object.entries(requests).map(([script, seen]) => [script, seen.length]))).toEqual({ A: 4, B: 3, C: 3, review: 1 });
    // The review saw the two passing lanes, not the one whose check failed.
    const review = JSON.stringify(requests['review']![0]);
    expect(review).toContain('Minimal change');
    expect(review).not.toContain('## Lane C');
    expect(await readFile(path.join(workspace, 'a.ts'), 'utf8')).toBe(GRAFTED);
  }, 900_000);
});
