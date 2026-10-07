import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chatAnswer, chatToolCall, fakeOpenAiServer } from '../fake-openai.js';
import { answer, fakeTransport, toolCall } from '../fake-transport.js';
import { makeRepo } from '../git-fixture.js';
import { rgCommand, runCli } from '../helpers.js';

type Wire = 'anthropic' | 'openai';

/** What the model was sent back for a call: the result's text and whether it was marked an error. */
type SeenResult = { readonly isError: boolean; readonly text: string };

const COMMANDS = { failing: 'cat missing.txt', passing: 'cat a.ts' } as const;

let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

/** Runs one non-interactive turn in which the model calls bash with `command`, and returns the result it got back. */
async function bashResult(wire: Wire, command: string): Promise<SeenResult> {
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'export const a = 1;\n' } }]));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-conformance-'));
  const base = { GCODE_HOME: home, GCODE_RG: rgCommand(), PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
  const argv = ['agent', '--workspace', workspace, '--non-interactive', 'Run it.'];
  if (wire === 'anthropic') {
    const usage = { input: 100, cacheRead: 0, cacheWrite: 0 };
    const transport = fakeTransport([toolCall('', [{ id: 'tu_bash', name: 'bash', input: { command } }], usage), answer('Done.', usage)]);
    const env = { ...base, GCODE_PROVIDER: 'modelstudio', DASHSCOPE_API_KEY: 'sk-fake', DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic' };
    expect((await runCli(argv, env, { fetch: transport.fetch })).code).toBe(0);
    const block = transport.requests[1]!.body.messages.flatMap((m: { content: unknown }) => (Array.isArray(m.content) ? m.content : [])).find((b: { type: string }) => b.type === 'tool_result');
    return { isError: block.is_error === true, text: typeof block.content === 'string' ? block.content : block.content[0].text };
  }
  const usage = { prompt: 100, completion: 10, cached: 0 };
  const server = await fakeOpenAiServer([chatToolCall('', [{ id: 'call_bash', name: 'bash', input: { command } }], usage), chatAnswer('Done.', usage)]);
  closers.push(server.close);
  const env = { ...base, GCODE_PROVIDER: 'openai', GCODE_MODEL: 'gpt-fake', OPENAI_API_KEY: 'sk-openai-fake-0123456789', GCODE_OPENAI_BASE_URL: server.url };
  expect((await runCli(argv, env)).code).toBe(0);
  const message = server.chats()[1]!.body.messages.find((m: { role: string }) => m.role === 'tool');
  // Chat Completions has no error flag on a tool message; Geno marks an error result with a leading [error].
  const isError = message.content.startsWith('[error] ');
  return { isError, text: isError ? message.content.slice('[error] '.length) : message.content };
}

describe.each<Wire>(['anthropic', 'openai'])('tools on the %s wire', (wire) => {
  it('T-TOOL-12 a non-zero exit is an error result that says the exit code first', async () => {
    const failed = await bashResult(wire, COMMANDS.failing);
    expect(failed.isError).toBe(true);
    expect(failed.text).toMatch(/^Exit code 1\n.*missing\.txt.*No such file or directory\n\[exit code 1\]$/s);

    const passed = await bashResult(wire, COMMANDS.passing);
    expect(passed).toEqual({ isError: false, text: 'export const a = 1;\n[exit code 0]' });
  });
});
