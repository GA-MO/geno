import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answer, loadTools, offeredTools, sseBody, toolCall, type Reply } from '../../engine/test/fake-transport.js';
import { connectWindow, evaluate, webview, type Window } from './cdp.js';
import { setUp } from './launch.js';
import { leaseWindow } from './pool/client.js';

import { ANSWER, COMMAND, EXIT_CODE, FAILURE, FAKE_SECRET, TERMINAL_NAME } from './suite/read-terminal-fixture.js';

const EXTENSION = 'g-code.g-code';
const MODEL = 'qwen3.8-flash';
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

const asModel = (reply: Reply): Reply => ({
  ...reply,
  events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model: MODEL } } : e)),
});

const replies: readonly Reply[] = [
  toolCall('Loading it.', [loadTools('read_terminal')], usage),
  toolCall('Reading your terminal.', [{ id: 'tu_term', name: 'read_terminal', input: {} }], usage),
  answer(ANSWER, usage),
].map(asModel);

type Body = { tools: { name: string }[]; messages: { role: string; content: unknown }[] };
const requests: Body[] = [];
let debugPort = 0;
let window: Window | undefined;

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  'POST /v1/messages': async (req, res) => {
    const reply = replies[requests.push(JSON.parse(await bodyOf(req))) - 1];
    if (reply === undefined) res.writeHead(500).end(`no reply for request ${requests.length - 1}`);
    else res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseBody(reply));
  },
  'POST /ui': async (req, res) => {
    const action = JSON.parse(await bodyOf(req)) as { do: string; expression: string };
    try {
      if (action.do !== 'eval') throw new Error(`the read_terminal suite does not use ${action.do}`);
      window ??= await connectWindow(debugPort);
      const result = await evaluate(await webview(window, EXTENSION, '.transcript'), action.expression);
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

/** The text of the tool result the model got for `id`, from the request that followed the call. */
function toolResultText(id: string): string {
  for (const body of requests) {
    for (const message of body.messages) {
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content as { type: string; tool_use_id?: string; content?: unknown }[]) {
        if (block.type !== 'tool_result' || block.tool_use_id !== id) continue;
        return typeof block.content === 'string' ? block.content : (block.content as { text?: string }[]).map((part) => part.text ?? '').join('');
      }
    }
  }
  throw new Error(`no tool result for ${id}`);
}

describe('read_terminal in VS Code', () => {
  it('reads a failing command the user typed in a shell-integrated terminal, with its exit code and output, and the secret redacted', async () => {
    const { workspace, work, home, suite } = await setUp('read-terminal', { 'README.md': '# app\n' }, { 'chat.mcp.enabled': false });
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
    expect(requests).toHaveLength(replies.length);
    expect(offeredTools(requests[0]!), 'the panel advertises the capability').toContain('read_terminal');

    const result = toolResultText('tu_term');
    expect(result).toContain(`Terminal 1 ${JSON.stringify(TERMINAL_NAME)}`);
    expect(result).toContain('<terminal_output>');
    expect(result, 'the command line, redacted').toContain(`$ ${COMMAND.replace(FAKE_SECRET, '[redacted]')}`);
    expect(result).toContain(`exit code ${EXIT_CODE}`);
    expect(result, 'stdout, redacted').toContain('deploy key [redacted]');
    expect(result, 'stderr').toContain(FAILURE);
    expect(JSON.stringify(requests), 'the secret never reaches the model').not.toContain(FAKE_SECRET);
  }, 600_000);
});
