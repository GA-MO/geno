import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, handBack, sseBody, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { setUp } from './launch.js';
import { capturePanel, resizeSideBar } from './media.js';
import { captureWindow } from './screenshot.js';
import { leaseWindow } from './pool/client.js';
import { ANSWERS, FILES, MARKERS, RELEASES, SENT, TASK, waitFor } from './suite/steer-fixture.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

/** `hold` keeps a reply back until the suite releases it by name. */
type Scripted = { readonly reply: Reply; readonly hold?: string };

const bash = (id: string, file: string) => ({ id, name: 'bash', input: { command: waitFor(file), description: 'Wait for the build', timeout_seconds: 600 } });

/** One script per conversation, picked by the marker in its first message. */
const SCRIPTS: Readonly<Record<string, readonly Scripted[]>> = {
  [MARKERS.chat]: [
    { reply: asModel(toolCall('Waiting for the build.', [bash('tu_wait_steer', RELEASES.steer)], usage)) },
    { reply: asModel(answer(ANSWERS.steer, usage)) },
    { reply: asModel(toolCall('Waiting again.', [bash('tu_wait_queue', RELEASES.queue)], usage)) },
    { reply: asModel(answer(ANSWERS.queue, usage)) },
    { reply: asModel(answer(ANSWERS.queued, usage)), hold: 'queued' },
    { reply: asModel(answer(ANSWERS.nextTurn, usage)) },
    { reply: asModel(toolCall('Asking an explorer.', [{ id: 'tu_agent', name: 'agent', input: { agent: 'explore', task: TASK } }], usage)) },
    { reply: asModel(answer(ANSWERS.agent, usage)) },
  ],
  [MARKERS.kid]: [
    { reply: asModel(toolCall('Reading a.ts.', [{ id: 'tu_kid_read', name: 'read', input: { path: 'a.ts' } }], usage)), hold: 'kid' },
    { reply: asModel(handBack(ANSWERS.child, usage)) },
  ],
};

type Block = { type: string; text?: string; tool_use_id?: string; content?: unknown };
type Body = { messages: { role: string; content: string | Block[] }[] };
const requests: Record<string, Body[]> = {};
const shots = process.env['GCODE_SCREENSHOTS'];
let debugPort = 0;
let failure: string | undefined;
let window: Window | undefined;
const releases = new Map<string, () => void>();
const released = (name: string) => new Promise<void>((resolve) => releases.set(name, resolve));
const holds = new Map<string, Promise<void>>(['queued', 'kid'].map((name) => [name, released(name)]));

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
  release: async ({ name }) => releases.get(name)?.(),
  resize: async ({ width }, w) => resizeSideBar(w, width),
  requests: async ({ marker }) => (requests[marker] ?? []).length,
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
    const marker = [MARKERS.kid, MARKERS.chat].find((m) => first.includes(m));
    if (marker === undefined) {
      res.writeHead(500).end(`no script for ${first.slice(0, 200)}`);
      return;
    }
    const seen = (requests[marker] ??= []);
    const step = SCRIPTS[marker]![seen.push(body) - 1];
    if (step === undefined) {
      res.writeHead(500).end(`no reply ${seen.length - 1} for ${marker}`);
      return;
    }
    if (step.hold !== undefined) await holds.get(step.hold);
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseBody(step.reply));
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

/** The request's content blocks in order, a plain string message as one text block. */
const blocksOf = (body: Body): Block[] => body.messages.flatMap((m) => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content));
const indexOf = (blocks: readonly Block[], pick: (block: Block) => boolean) => blocks.findIndex(pick);
const textHas = (text: string) => (block: Block) => block.type === 'text' && block.text?.includes(text) === true;
const resultOf = (id: string) => (block: Block) => block.type === 'tool_result' && block.tool_use_id === id;

describe('steering a running turn in VS Code', () => {
  it('sends now into a running tool round, queues with Enter, runs a missed steer as the next turn, steers a subagent, and replays it in place', async () => {
    const { workspace, work, home, suite } = await setUp('steer', FILES, { 'gcode.approvalMode': 'auto', 'gcode.chat.detail': 'full', 'chat.mcp.enabled': false });
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
    expect(failure).toBeUndefined();
    const chat = requests[MARKERS.chat]!;
    expect(chat).toHaveLength(SCRIPTS[MARKERS.chat]!.length);

    // The steer reached the very next model call, after the tool's result.
    const steered = blocksOf(chat[1]!);
    const result = indexOf(steered, resultOf('tu_wait_steer'));
    const steer = indexOf(steered, textHas(SENT.steer));
    expect(result).toBeGreaterThanOrEqual(0);
    expect(steer).toBeGreaterThan(result);
    expect(blocksOf(chat[0]!).some(textHas(SENT.steer)), 'nothing of it before the tool ran').toBe(false);

    // Enter queued: the follow-up stayed out of the turn it was typed in, and was the next turn's prompt.
    expect(blocksOf(chat[3]!).some(textHas(SENT.queued))).toBe(false);
    expect(blocksOf(chat[4]!).at(-1)).toMatchObject({ type: 'text', text: SENT.queued });

    // A steer the turn ended without ran as the next turn, once.
    const next = blocksOf(chat[5]!);
    expect(next.at(-1)).toMatchObject({ type: 'text', text: SENT.nextTurn });
    expect(next.filter(textHas(SENT.nextTurn))).toHaveLength(1);

    // The subagent's next call carried the message after its read.
    const kid = requests[MARKERS.kid]!;
    expect(kid).toHaveLength(2);
    const kidBlocks = blocksOf(kid[1]!);
    expect(indexOf(kidBlocks, textHas(SENT.child))).toBeGreaterThan(indexOf(kidBlocks, resultOf('tu_kid_read')));
  }, 600_000);
});
