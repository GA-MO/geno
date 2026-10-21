import { access, mkdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLASSIFIER_TOOL, MODE_NOTICES, PROMPT_ACTIONS, USER_PROMPT_FOLLOWS, userActionText } from '@g-code/core';
import { answer, sseBody, toolCall, type FakeToolUse, type Reply } from '../../engine/test/fake-transport.js';
import { click, connectWindow, evaluate, press, typeText, webview, type Window } from './cdp.js';
import { setUp } from './launch.js';
import { captureWindow } from './screenshot.js';
import { leaseWindow } from './pool/client.js';
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
  toolCall('Clearing coverage.', [bash(COMMANDS.removeCoverage)], usage),
  verdict('deny', REASONS.deny),
  toolCall('Clearing what dist holds.', [bash(COMMANDS.removeDistFile)], usage),
  verdict('ask', REASONS.ask),
  asModel(answer('Cleaned build and dist, and I left a.ts alone.', usage)),
  // Denied in Ask, which ends the turn with no answer after it.
  toolCall('Removing it again.', [bash(COMMANDS.removeAgain)], usage),
  // A model that tries to edit in Plan: every mode offers edit, and Plan refuses the call.
  toolCall('Looking around first.', [bash('ls -t'), { id: 'tu_edit_plan', name: 'edit', input: { path: 'a.ts', old_str: 'export const a', new_str: 'export const answer' } }], usage),
  asModel(answer(PLAN, usage)),
  asModel(answer('Renamed it.', usage)),
];

type Block = { type: string; text?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };
const requests: { tool_choice?: unknown; system: unknown; tools: { name: string }[]; messages: { content: Block[] }[] }[] = [];
const lastBlocks = (index: number) => requests[index]!.messages.at(-1)!.content;
const lastTexts = (index: number) => lastBlocks(index).flatMap((b) => (b.type === 'text' && b.text !== undefined ? [b.text] : []));
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
  it('starts in the configured mode, badges what Auto settled, sends its refusals back to the model, asks the user after three in a row, and switches to Ask from the picker', async () => {
    // These assertions open the steps of finished turns, which full detail draws as the panel did before U17.
    const { work, home, workspace, suite } = await setUp('modes', FILES, { 'gcode.approvalMode': 'auto', 'gcode.chat.detail': 'full' });
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
      GCODE_CLASSIFIER_MODEL: MODEL,
    });
    expect(requests).toHaveLength(replies.length);
    // Auto asked the classifier five times; Ask and Plan never did.
    expect(requests.map((r) => r.tool_choice !== undefined)).toEqual([false, true, false, true, false, true, false, true, false, true, false, false, false, false, false]);
    // Every mode offers the same tools and system prompt, so a switch keeps the cached prefix; the notice tells the mode.
    for (const i of [12, 13, 14]) expect(toolNames(i), `request ${i} offers the tools of request 0`).toEqual(toolNames(0));
    for (const i of [12, 13, 14]) expect(requests[i]!.system, `request ${i} keeps the system prompt`).toEqual(requests[0]!.system);
    expect(lastTexts(12), 'the Plan turn tells the model it is in Plan').toContain(MODE_NOTICES.plan);
    const refused = lastBlocks(13).find((b) => b.type === 'tool_result' && b.tool_use_id === 'tu_edit_plan');
    expect(refused, 'Plan refuses the edit when it is called').toMatchObject({ is_error: true });
    expect(JSON.stringify(refused?.content)).toContain('edit is not available: Plan mode is read-only');
    expect(await readFile(path.join(workspace, 'a.ts'), 'utf8'), 'and a.ts is unchanged').toBe(FILES['a.ts']);
    // Start building left Plan for the configured default, Auto, told the model so, and sent the follow-up.
    expect(FOLLOW_UP, 'the fixture shows what Start building sends').toBe(PROMPT_ACTIONS['start-building']);
    expect(lastTexts(14)).toEqual([MODE_NOTICES.auto, USER_PROMPT_FOLLOWS, userActionText(FOLLOW_UP)]);
    expect(await exists(path.join(workspace, 'build'))).toBe(false);
    expect(await exists(path.join(workspace, 'dist/out.js')), 'the user allowed removing it on the card after three refusals').toBe(false);
  }, 600_000);
});
