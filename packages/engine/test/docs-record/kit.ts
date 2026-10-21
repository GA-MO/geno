import { createHash } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';
import { engineShared, gcodeAgent } from '../../src/serve.js';
import { call, scripted, sessionIdOf, type Turn } from '../conformance/scripted.js';
import type { Answer, ModelRequest, Responder, ScriptEntry } from '../fake-model.js';
import { answer as streamAnswer, toolCall as streamToolCall, type CacheUsage, type FakeToolUse, type Reply } from '../fake-transport.js';

export { STEER_META, TASKS_CAPABILITY, WORKFLOWS_CAPABILITY } from '@g-code/core';
export { call, report, say } from '../conformance/scripted.js';
export { acp };
export type { Responder, ScriptEntry };

/** A provider's count for `text`, at about four characters a token. */
const tokensOf = (text: string): number => Math.max(1, Math.ceil(text.length / 4));
/** The input a provider counts for a request: its system prompt, tools and messages. */
export const inputOf = (body: ModelRequest['body']): number => tokensOf(JSON.stringify([body.system, body.tools, body.messages]));
export const usage = (input: number): CacheUsage => ({ input, cacheRead: 0, cacheWrite: 0 });

/** `reply` with the output tokens a provider counts for what it streamed: text, thinking and tool input. */
function counted(reply: Reply): Reply {
  const streamed = reply.events
    .map((e) => {
      const delta = e['delta'] as { text?: string; thinking?: string; partial_json?: string } | undefined;
      return e.type === 'content_block_delta' ? (delta?.text ?? delta?.thinking ?? delta?.partial_json ?? '') : '';
    })
    .join('');
  return { ...reply, events: reply.events.map((e) => (e.type === 'message_delta' ? { ...e, usage: { ...(e['usage'] as object), output_tokens: tokensOf(streamed) } } : e)) };
}

/** A signature shaped like a provider's: base64 of a hash of the thought. */
const signatureOf = (thought: string) => createHash('sha512').update(thought).digest('base64');

/** A text answer; it thinks first only when `thought` is given, as a model asked for no thinking does not. */
export const answer = (text: string, use: CacheUsage, opts: { stopReason?: string; chunk?: number; thought?: string } = {}): Reply =>
  counted(streamAnswer(text, use, { ...opts, thinking: opts.thought === undefined ? null : { thought: opts.thought, signature: signatureOf(opts.thought) } }));
/** A turn that says `text`, if any, then asks for each tool use. */
export const toolCall = (text: string, uses: readonly FakeToolUse[], use: CacheUsage, opts: { cutOff?: true } = {}): Reply => counted(streamToolCall(text, uses, use, opts));

/** A message id shaped like a provider's, the same for the same request of a run on every run. */
const messageId = (index: number) => `msg_01${createHash('sha256').update(`docs-record ${index}`).digest('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 22)}`;

/** A turn as a provider streams it: the input it counts for the request, unless the turn sets one, and no thinking. */
const streamed = (turn: Turn, request: ModelRequest): Reply =>
  turn.kind === 'say'
    ? answer(turn.text, usage(inputOf(request.body)), { stopReason: turn.stop })
    : toolCall(turn.text, turn.uses, usage(turn.input ?? inputOf(request.body)), turn.cutOff ? { cutOff: true } : {});

/**
 * The script with each answer sent as a provider sends it: a turn streams with the input the request holds, and every
 * reply names the model the request asked for and has an id of its own.
 */
function asProvider(script: readonly ScriptEntry[]): ScriptEntry[] {
  const send = async (responder: Responder, request: ModelRequest): Promise<Answer> => {
    const found = typeof responder === 'function' ? await responder(request) : responder;
    if ('openai' in found) return found;
    const reply = 'kind' in found ? streamed(found, request) : found.anthropic;
    const named = (e: Reply['events'][number]) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), id: messageId(request.index), model: request.body.model } } : e);
    return { anthropic: { ...reply, events: reply.events.map(named) } };
  };
  return script.map((entry) => ('answer' in entry ? { ...entry, answer: (request: ModelRequest) => send(entry.answer, request) } : { answer: (request: ModelRequest) => send(entry, request) }));
}

/** The conformance harness's workspace and scripted model, answering as a provider does. */
export const scriptedRun = (script: readonly ScriptEntry[], workspace: Readonly<Record<string, string>>) => scripted('anthropic', asProvider(script), workspace);

/** One model request as the engine sent it, and the reply the fake streamed back. */
/** `aborted` is set when the engine aborted the request before any reply came. */
/** `headers` are kept only for a reply that is not 200, where a provider says when to try again. */
export type Exchange = { readonly url: string; readonly body: unknown; status: number; headers?: Record<string, string>; response: string; aborted?: true };

/** A request the engine sent the editor over ACP, and how many model requests came before it. */
export type EditorRequest = { readonly after: number; readonly method: string; readonly params: unknown };

export type Recording = { readonly exchanges: readonly Exchange[]; readonly editor?: readonly EditorRequest[]; readonly workspace: string; readonly home: string };

export type Flow = { readonly name: string; readonly what: string; readonly run: () => Promise<Recording> };

export const VERSION = `export function parseVersion(text: string): [number, number, number] {
  if (text === '') return [0, 0, 0];
  const [major, minor, patch] = text.split('.').map(Number);
  return [major ?? 0, minor ?? 0, patch ?? 0];
}
`;

export const files = (modes: readonly string[], extra: Readonly<Record<string, string>> = {}) => ({
  'package.json': `${JSON.stringify({ name: 'shop', private: true, type: 'module', scripts: { test: 'vitest run' } }, null, 2)}\n`,
  'src/version.ts': VERSION,
  'src/cli.ts': `import { parseVersion } from './version.js';\n\nconsole.log(parseVersion(process.argv[2] ?? ''));\n`,
  'src/update.ts': `import { parseVersion } from './version.js';\n\nexport const isNewer = (a: string, b: string) => parseVersion(a)[0] > parseVersion(b)[0];\n`,
  '.gcode.json': `${JSON.stringify({ agentTool: modes })}\n`,
  ...extra,
});

/** Keeps every model request and the bytes of the fake's reply, in the order the requests came. */
export function capture(fetch: typeof globalThis.fetch) {
  const exchanges: Exchange[] = [];
  const reading: Promise<void>[] = [];
  const wrapped: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if ((init?.method ?? 'GET') !== 'POST') return fetch(input, init);
    const exchange: Exchange = { url: url.replace(/^https:\/\/ws-1\.example\.com\/apps\/anthropic/, '<DASHSCOPE_BASE_URL>'), body: JSON.parse(String(init?.body)), status: 0, response: '' };
    exchanges.push(exchange);
    if (process.env['DOCS_RECORD_DEBUG']) console.error(exchanges.length, JSON.stringify((exchange.body as Body).messages.at(-1)).slice(0, 300));
    const response = await fetch(input, init).catch((error: unknown) => {
      if (init?.signal?.aborted === true) exchange.aborted = true;
      throw error;
    });
    exchange.status = response.status;
    if (response.status !== 200) exchange.headers = Object.fromEntries(response.headers);
    if (response.body === null) return response;
    const [mine, theirs] = response.body.tee();
    reading.push(
      (async () => {
        const decoder = new TextDecoder();
        try {
          for await (const piece of mine) exchange.response += decoder.decode(piece, { stream: true });
        } catch {
          // A stream the engine aborted keeps what arrived before the abort.
        }
      })(),
    );
    return new Response(theirs, { status: response.status, headers: response.headers });
  };
  return { fetch: wrapped, exchanges, done: () => Promise.all(reading) };
}

export type Body = { readonly messages: readonly { readonly role: string; readonly content: unknown }[] };
export const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : (content as readonly { readonly text?: string; readonly content?: unknown }[]).map((block) => block.text ?? textOf(block.content ?? '')).join('\n');
export const firstText = (body: Body): string => textOf(body.messages[0]?.content);
export const anyText = (body: Body): string => body.messages.map((message) => textOf(message.content)).join('\n');

/** The next request of the conversation whose first message holds `marker`. */
export const to = (marker: string, answer: Responder): ScriptEntry => ({ when: (request) => firstText(request.body).includes(marker), answer });
/** The next request of a session whose later prompt holds `marker`, for a flow that sends a second prompt. */
export const later = (marker: string, answer: Responder): ScriptEntry => ({ when: (request) => anyText(request.body).includes(marker), answer });
/** The next request of a fork, whose first messages are its parent's, by a marker anywhere in its conversation. */
export const inFork = (answer: Responder): ScriptEntry => ({ when: (request) => anyText(request.body).includes('You are now plan'), answer });
export const notFork = (marker: string, answer: Responder): ScriptEntry => ({
  when: (request) => firstText(request.body).includes(marker) && !anyText(request.body).includes('You are now plan'),
  answer,
});

export const childIdIn = (body: Body): string => /subagent session ([0-9a-f-]{36})|session="([0-9a-f-]{36})"/.exec(anyText(body))!.slice(1).find(Boolean)!;

export const agentCall = (id: string, input: Record<string, unknown>, text = '') => call(text, [{ id, name: 'agent', input }]);
export const grep = (id: string, pattern: string) => call('', [{ id, name: 'grep', input: { pattern } }]);
export const read = (id: string, file: string) => call('', [{ id, name: 'read', input: { path: file } }]);
export const loadMessageAgent = call('', [{ id: 'toolu_load_1', name: 'tool_search', input: { select: ['message_agent'] } }]);

export const ASK_WHERE = 'Where is parseVersion called?';
export const EXPLORE_TASK = 'Find every call of parseVersion outside the file that defines it. Answer with path:line for each call.';
export const FOUND = 'src/cli.ts:3 calls parseVersion on the first CLI argument.\nsrc/update.ts:3 calls it twice, in isNewer.';

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A CLI run of `gcode agent` per prompt, in one session after the first. */
export async function cliFlow(modes: readonly string[], script: readonly ScriptEntry[], prompts: readonly (readonly string[])[], extra: Readonly<Record<string, string>> = {}): Promise<Recording> {
  const run = await scriptedRun(script, files(modes, extra));
  const seen = capture(run.io.fetch!);
  let session: string | undefined;
  for (const args of prompts) {
    const where = session === undefined ? ['--workspace', run.workspace] : ['--session', session];
    const result = await run.cli(['agent', ...where, ...args], { fetch: seen.fetch });
    if (result.code !== 0) throw new Error(`gcode agent ${args.join(' ')} exited ${result.code}: ${result.stderr}`);
    session ??= sessionIdOf(result.stdout);
  }
  await seen.done();
  return { exchanges: seen.exchanges, workspace: run.workspace, home: run.env['HOME']! };
}

export type Editor = {
  /** Answers a permission request with the option it picks. */
  readonly permission?: (params: acp.RequestPermissionRequest) => string;
  /** Called on each session update, with the connection. */
  readonly update?: (params: acp.SessionNotification, ctx: acp.ClientContext) => void;
  /** Resolves once the run has done what the flow shows, after the last prompt's turn ends; `workspace` is the run's folder. */
  readonly settled?: (requests: () => number, workspace: string) => Promise<void>;
  /** Files the workspace holds besides the shared ones. */
  readonly files?: Readonly<Record<string, string>>;
  /** Capabilities the editor advertises in `_meta`, as VS Code does for Tasks and workflows. */
  readonly meta?: Readonly<Record<string, unknown>>;
};

/** Prompts from an editor over ACP in one session, as `gcode serve` runs them for VS Code. */
export async function editorFlow(
  modes: readonly string[],
  mode: string,
  script: readonly ScriptEntry[],
  prompts: string | readonly string[],
  editor: Editor = {},
  env: Record<string, string> = {},
): Promise<Recording> {
  const run = await scriptedRun(script, files(modes, editor.files));
  Object.assign(run.env, env);
  const seen = capture(run.io.fetch!);
  const io = { ...run.io, fetch: seen.fetch };
  let connection: acp.ClientContext | undefined;
  const asked: EditorRequest[] = [];
  const client = acp
    .client({ name: 'docs-recorder' })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      asked.push({ after: seen.exchanges.length, method: 'session/request_permission', params });
      return { outcome: { outcome: 'selected', optionId: editor.permission?.(params) ?? params.options[0]!.optionId } };
    })
    .onNotification(acp.methods.client.session.update, ({ params }) => editor.update?.(params, connection!));
  const engine = engineShared(io);
  try {
    await client.connectWith(gcodeAgent(io, run.store, { maxTurns: 10, maxCostUsd: 1 }, undefined, engine), async (ctx) => {
      connection = ctx;
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { subagents: {}, ...(editor.meta === undefined ? {} : { _meta: editor.meta }) } });
      const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: run.workspace, mcpServers: [] });
      await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: mode });
      for (const text of typeof prompts === 'string' ? [prompts] : prompts) await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
      await editor.settled?.(() => seen.exchanges.length, run.workspace);
    });
  } finally {
    await engine.jobs.kill('engine-exit', 'all');
  }
  await seen.done();
  return { exchanges: seen.exchanges, editor: asked, workspace: run.workspace, home: run.env['HOME']! };
}

export async function until(done: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** A promise and the function that settles it. */
export function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

export const WORKER_TASK =
  'Find where parseVersion is defined, then make it throw an Error("empty version") on an empty string. Keep its signature. Report the line you changed.';
export const editVersion = call('', [
  { id: 'toolu_edit_1', name: 'edit', input: { path: 'src/version.ts', old_str: "  if (text === '') return [0, 0, 0];", new_str: "  if (text === '') throw new Error('empty version');" } },
]);
export const CHECK_TASK = 'Add a "check" script to package.json that runs tsc --noEmit. Use npm pkg set, then read package.json back to confirm. Do not run the script.';
export const WORKER_REPORT ="Changed src/version.ts:2: parseVersion now throws Error('empty version') on an empty string. The signature is unchanged. No test covers it yet.";

/** A hand-built reply, which the script sends as a provider does. */
export const raw =
  (reply: Reply) =>
  (_request?: ModelRequest): Answer => ({ anthropic: reply });
/** A reply built with the input the request holds. */
export const sized =
  (build: (use: CacheUsage) => Reply): Responder =>
  (request) => ({ anthropic: build(usage(inputOf(request.body))) });
/** A text answer that ends with `stop`, such as `refusal` or `pause_turn`. */
export const stopsWith =
  (stop: string, text: string, input?: number): Responder =>
  (request) => ({ anthropic: answer(text, usage(input ?? inputOf(request.body)), { stopReason: stop }) });
/** A reply cut at the request's output limit: a provider reports as many output tokens as `max_tokens` allowed. */
export const atCeiling =
  (reply: Reply): Responder =>
  (request) =>
    raw({ ...reply, events: reply.events.map((e) => (e.type === 'message_delta' ? { ...e, usage: { output_tokens: request.body.max_tokens } } : e)) })(request);
/** An answer with only a thinking block: no text, no tool call. */
export const thinkingOnly = (thought: string): Responder => sized((use) => answer('', use, { thought }));

/** A model whose 200,000-token window is small next to its 64,000-token output limit, so a long context lowers `max_tokens`. */
export const SMALL_WINDOW = { GCODE_PROVIDER: 'anthropic', GCODE_MODEL: 'claude-haiku-4-5', ANTHROPIC_API_KEY: 'sk-fake' };
/** Context the fake reports in the max-tokens flow's second turn: past the room left for a full-size answer, short of compaction. */
export const LONG = 150_000;
export const VERSION_DOC = (sections: number) =>
  ['# parseVersion', '', 'parseVersion(text) reads a version such as "1.2.3" and returns [major, minor, patch].', '']
    .concat(Array.from({ length: sections }, (_, i) => [`## Case ${i + 1}`, '', `Input "${i}.${i + 1}" returns [${i}, ${i + 1}, 0]: a missing part counts as 0.`, '']).flat())
    .join('\n');
export const allowOnce = (params: acp.RequestPermissionRequest) => params.options.find((option) => option.kind === 'allow_once')!.optionId;
