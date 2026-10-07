import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { asSessionId, type TurnEvent } from '@g-code/core';
import type { Io } from '../../src/command.js';
import { readSessionLog, sessionFile } from '../../src/sessions.js';
import { openStore, type Store } from '../../src/store.js';
import { chatAnswer, chatToolCall, fakeOpenAiServer, type ChatReply } from '../fake-openai.js';
import { answer, fakeTransport, toolCall, type FakeToolUse, type Reply } from '../fake-transport.js';
import { makeRepo } from '../git-fixture.js';
import { rgCommand, runCli, type CliOptions } from '../helpers.js';

/** The two wires every conformance test of the model's view runs on. */
export const WIRES = ['anthropic', 'openai'] as const;
export type Wire = (typeof WIRES)[number];

/** One scripted model turn, as either wire streams it. */
export type ScriptedTurn =
  | { readonly kind: 'say'; readonly text: string; readonly stop: 'end_turn' | 'model_context_window_exceeded' }
  | { readonly kind: 'call'; readonly text: string; readonly uses: readonly FakeToolUse[]; readonly cutOff: boolean };

export const say = (text: string, stop: 'end_turn' | 'model_context_window_exceeded' = 'end_turn'): ScriptedTurn => ({ kind: 'say', text, stop });
export const call = (text: string, uses: readonly FakeToolUse[], opts: { cutOff?: true } = {}): ScriptedTurn => ({ kind: 'call', text, uses, cutOff: opts.cutOff === true });

/** A tool result as the model reads it on either wire. */
export type SeenResult = { readonly id: string; readonly error: boolean; readonly text: string };

/** What one request carried after the model's last turn: the tool results, then the text of what came with them. */
export type Seen = { readonly results: readonly SeenResult[]; readonly text: string };

export const sessionIdOf = (stdout: string): string => /^session: (\S+)$/m.exec(stdout)![1]!;

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const chatUsage = { prompt: 1000, completion: 30, cached: 0 };

const anthropicReply = (turn: ScriptedTurn): Reply =>
  turn.kind === 'say' ? answer(turn.text, usage, { stopReason: turn.stop }) : toolCall(turn.text, turn.uses, usage, turn.cutOff ? { cutOff: true } : {});

function openAiReply(turn: ScriptedTurn): ChatReply {
  if (turn.kind === 'call') return chatToolCall(turn.text, turn.uses, chatUsage, turn.cutOff ? { cutOff: true } : {});
  if (turn.stop !== 'end_turn') throw new Error(`Chat Completions has no ${turn.stop} stop`);
  return chatAnswer(turn.text, chatUsage);
}

type Block = { readonly type: string; readonly text?: string; readonly tool_use_id?: string; readonly is_error?: boolean; readonly content?: string | readonly Block[] };
type AnthropicMessage = { readonly role: string; readonly content: string | readonly Block[] };
type ChatMessage = { readonly role: string; readonly content: string | readonly Block[]; readonly tool_call_id?: string };

const textOf = (content: string | readonly Block[] | undefined): string =>
  typeof content === 'string' ? content : (content ?? []).flatMap((block) => (block.type === 'text' && block.text !== undefined ? [block.text] : [])).join('\n');

function seenAnthropic(body: { readonly messages: readonly AnthropicMessage[] }): Seen {
  const last = body.messages.at(-1)!;
  const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
  return {
    results: blocks.flatMap((b) => (b.type === 'tool_result' ? [{ id: b.tool_use_id!, error: b.is_error === true, text: textOf(b.content) }] : [])),
    text: textOf(blocks.filter((b) => b.type === 'text')),
  };
}

const CHAT_ERROR = '[error] ';

function seenOpenAi(body: { readonly messages: readonly ChatMessage[] }): Seen {
  const after = body.messages.slice(body.messages.findLastIndex((m) => m.role === 'assistant') + 1);
  return {
    results: after.flatMap((m) => {
      if (m.role !== 'tool') return [];
      const text = textOf(m.content);
      return [{ id: m.tool_call_id!, error: text.startsWith(CHAT_ERROR), text: text.startsWith(CHAT_ERROR) ? text.slice(CHAT_ERROR.length) : text }];
    }),
    text: after.flatMap((m) => (m.role === 'user' ? [textOf(m.content)] : [])).join('\n'),
  };
}

const servers: { close(): Promise<void> }[] = [];

/** Stops the fake OpenAI-compatible servers the tests started; call it from afterEach. */
export async function closeServers(): Promise<void> {
  await Promise.all(servers.splice(0).map((server) => server.close()));
}

/**
 * A git workspace holding `files`, and a fake provider on `wire` that answers the model calls with `script` in order.
 * `cli` runs the `gcode` command line against it and `io` serves it to an editor; `seen` reads each model request as
 * the model saw it.
 */
export async function scripted(wire: Wire, script: readonly ScriptedTurn[], files: Readonly<Record<string, string>> = { 'a.ts': 'export const a = 1;\n' }) {
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files }]));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const base = { GCODE_HOME: home, HOME: home, GCODE_RG: rgCommand(), PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
  let env: Record<string, string>;
  let seen: () => Seen[];
  let fetch: typeof globalThis.fetch | undefined;
  if (wire === 'anthropic') {
    const transport = fakeTransport(script.map(anthropicReply));
    env = { ...base, GCODE_PROVIDER: 'modelstudio', DASHSCOPE_API_KEY: 'sk-fake', DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic' };
    seen = () => transport.requests.map((request) => seenAnthropic(request.body));
    fetch = transport.fetch;
  } else {
    const server = await fakeOpenAiServer(script.map(openAiReply));
    servers.push(server);
    env = { ...base, GCODE_PROVIDER: 'openai', GCODE_MODEL: 'gpt-fake', OPENAI_API_KEY: 'sk-fake', GCODE_OPENAI_BASE_URL: server.url };
    seen = () => server.chats().map((request) => seenOpenAi(request.body));
  }
  const store: Store = openStore(env);
  const cli = (argv: readonly string[], options: CliOptions = {}) => runCli([...argv], env, { ...(fetch === undefined ? {} : { fetch }), ...options });
  const events = async (sessionId: string): Promise<readonly TurnEvent[]> => (await readSessionLog(sessionFile(store, asSessionId(sessionId)))).events;
  const log = (stdout: string) => events(sessionIdOf(stdout));
  // For an engine served to an editor over ACP, as `gcode serve` runs.
  const io: Io = { env, cwd: workspace, out: () => {}, err: () => {}, write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, ...(fetch === undefined ? {} : { fetch }) };
  return { workspace, env, store, io, cli, seen, log, events };
}
