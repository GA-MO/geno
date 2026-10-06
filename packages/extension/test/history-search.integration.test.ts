import { mkdir, realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSessionId, type Session, type TurnEvent } from '@g-code/core';
import { appendEvent } from '../../engine/src/sessions.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { cachePath, root, setUp } from './launch.js';
import { capturePanel } from './media.js';
import { captureWindow, freePort } from './screenshot.js';
import { FILES, SESSIONS, type FixtureTurn } from './suite/history-search-fixture.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';
const shots = process.env['GCODE_SCREENSHOTS'];
let debugPort = 0;
let window: Window | undefined;
const requests: unknown[] = [];

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
  screenshot: async ({ name }, w) => {
    if (shots === undefined) return;
    await captureWindow(debugPort, path.resolve(shots, `${name}.png`));
    await capturePanel(w, path.resolve(shots, `${name}-panel.png`), 2);
  },
};

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  'POST /v1/messages': async (req, res) => {
    requests.push(JSON.parse(await bodyOf(req)));
    res.writeHead(500).end('this test sends no prompt');
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

/** A session log as the engine writes it, one prompt and one answer per turn, a minute apart. */
async function logSession(home: string, id: string, workspace: string, turns: readonly FixtureTurn[], day: number): Promise<void> {
  const start = Date.UTC(2026, 9, day, 9);
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString();
  const session: Session = { id: asSessionId(id), createdAt: at(0), workspace, provider: 'modelstudio', model: MODEL, effort: 'medium' };
  const file = path.join(home, 'sessions', `${id}.jsonl`);
  await appendEvent(file, { kind: 'session-start', session });
  let seq = 1;
  for (const [i, turn] of turns.entries()) {
    await appendEvent(file, { kind: 'user', seq: seq++, at: at(i * 2), content: turn.prompt });
    const answer: TurnEvent = {
      kind: 'assistant',
      seq: seq++,
      at: at(i * 2 + 1),
      content: [{ type: 'text', text: turn.answer }] as never,
      stopReason: 'end_turn',
      usage: { input: 1200, cacheRead: 0, cacheWrite: 0, output: 40 },
      costUsd: 0.0004,
      latencyMs: 900,
      model: MODEL,
    };
    await appendEvent(file, answer);
  }
}

describe('History search in VS Code', () => {
  it('finds sessions by their text, in English and Thai, marks the match, and opens a hit scrolled to its turn', async () => {
    const { home, workspace, suite, launchArgs } = await setUp('history-search', FILES, { 'chat.mcp.enabled': false });
    if (shots !== undefined) await mkdir(shots, { recursive: true });
    const real = await realpath(workspace);
    for (const [i, session] of SESSIONS.entries()) await logSession(home, session.id, real, session.turns, i + 1);
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
      },
    });
    expect(code).toBe(0);
    expect(requests, 'searching and opening a session call no model').toEqual([]);
  }, 600_000);
});
