import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { chatAnswer, chatToolCall, type ChatReply } from './fake-openai.js';
import { answer, replyResponse, toolCall, type FakeToolUse, type Reply } from './fake-transport.js';
import { requestKey, type Wire } from './request-normal.js';

export type { FakeToolUse } from './fake-transport.js';
export type { Wire } from './request-normal.js';

/** One model turn, which the fake streams on whichever wire the request came in on. */
export type Turn =
  | { readonly kind: 'say'; readonly text: string; readonly stop: 'end_turn' | 'model_context_window_exceeded' }
  | { readonly kind: 'call'; readonly text: string; readonly uses: readonly FakeToolUse[]; readonly cutOff: boolean; readonly input: number | undefined };

export const say = (text: string, stop: 'end_turn' | 'model_context_window_exceeded' = 'end_turn'): Turn => ({ kind: 'say', text, stop });
/** `input` is the input size the Anthropic wire reports for the turn, as a provider does for a long context. */
export const call = (text: string, uses: readonly FakeToolUse[], opts: { cutOff?: true; input?: number } = {}): Turn => ({
  kind: 'call',
  text,
  uses,
  cutOff: opts.cutOff === true,
  input: opts.input,
});
/** A subagent's last turn: its report call, which ends its run. */
export const report = (message: string, id = 'tu_report'): Turn => call('', [{ id, name: 'report', input: { message } }]);

/** What the fake answers one request with: a turn, or a wire's exact reply, for stalls, failures and hand-built events. */
export type Answer = Turn | { readonly anthropic: Reply } | { readonly openai: ChatReply };

/** A request as the fake received it; `index` counts the model requests this fake has had. */
export type ModelRequest = { readonly wire: Wire; readonly index: number; readonly url: string; readonly headers: Headers; readonly body: any };

/** An answer, or one computed from the request, which may wait, as a test that holds a turn open does. */
export type Responder = Answer | ((request: ModelRequest) => Answer | Promise<Answer>);

/** An answer for the next request, or for the next request `when` accepts. */
export type ScriptEntry = Answer | { readonly when?: (request: ModelRequest) => boolean; readonly answer: Responder };

/**
 * Where answers come from. A script answers in order. A recording answers by the request's key
 * (`request-normal.ts`) from `<dir>/<recording>.json`; `record` says what fills a missing entry: nothing (`off`, a
 * miss fails), the `fallback` script (`script`), or Model Studio (`live`). It defaults from GCODE_RECORD: unset is
 * `off`, `1` is `script`, `live` is `live`.
 */
export type Source =
  | { readonly script: readonly ScriptEntry[] }
  | { readonly recording: string; readonly dir?: string; readonly record?: RecordMode; readonly fallback?: readonly ScriptEntry[] };

export type RecordMode = 'off' | 'script' | 'live';

/** One answered request in a recording. `asks` is the end of its last user message, for a reader of the file. */
type Entry = { readonly key: string; readonly wire: Wire; readonly asks: string; readonly answer: Answer };
type Cassette = { readonly entries: Entry[] };

export const RECORDINGS = fileURLToPath(new URL('./recordings/', import.meta.url));
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const chatUsage = { prompt: 1000, completion: 30, cached: 0 };

type Block = { readonly type?: string; readonly text?: string };

/** The last text a user message of either wire's body carries: the prompt, or a notice after the tool results. */
export function lastUserText(body: { readonly messages?: readonly { readonly role: string; readonly content: unknown }[] }): string {
  const content = (body.messages ?? []).findLast((m) => m.role === 'user')?.content;
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? (content as Block[]) : []).findLast((b) => b.type === 'text')?.text ?? '';
}

const isTurn = (answer: Answer): answer is Turn => 'kind' in answer;
const isEntry = (entry: ScriptEntry): entry is Exclude<ScriptEntry, Answer> => 'answer' in entry;

function anthropicReply(turn: Turn, model: string): Reply {
  const reply =
    turn.kind === 'say'
      ? answer(turn.text, usage, { stopReason: turn.stop })
      : toolCall(turn.text, turn.uses, { ...usage, input: turn.input ?? usage.input }, turn.cutOff ? { cutOff: true } : {});
  // The reply names the model the request asked for, as a provider does.
  return { ...reply, events: reply.events.map((e) => (e.type === 'message_start' ? { ...e, message: { ...(e['message'] as object), model } } : e)) };
}

function chatReply(turn: Turn): ChatReply {
  if (turn.kind === 'call') return chatToolCall(turn.text, turn.uses, chatUsage, turn.cutOff ? { cutOff: true } : {});
  if (turn.stop !== 'end_turn') throw new Error(`Chat Completions has no ${turn.stop} stop`);
  return chatAnswer(turn.text, chatUsage);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function untilAborted(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(new DOMException('This operation was aborted', 'AbortError'));
    if (signal?.aborted) fail();
    else signal?.addEventListener('abort', fail, { once: true });
  });
}

/** A Chat Completions reply as the response an OpenAI-compatible server streams. */
async function chatResponse(reply: ChatReply, signal: AbortSignal | null | undefined): Promise<Response> {
  if (reply.hang) await untilAborted(signal);
  if (reply.failure !== undefined) {
    return new Response(JSON.stringify(reply.failure.body), { status: reply.failure.status, headers: { 'content-type': 'application/json', ...reply.failure.headers } });
  }
  const lines = [...reply.chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'].slice(0, reply.stallAfter);
  const encoder = new TextEncoder();
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const line = lines[next++];
      if (line === undefined) {
        if (reply.stallAfter === undefined) return controller.close();
        return untilAborted(signal).catch((error) => controller.error(error));
      }
      if (reply.everyMs !== undefined) {
        const until = Date.now() + reply.everyMs;
        while (reply.keepAliveMs !== undefined && Date.now() + reply.keepAliveMs < until) {
          await sleep(reply.keepAliveMs);
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
        }
        await sleep(Math.max(0, until - Date.now()));
      }
      controller.enqueue(encoder.encode(line));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function render(request: ModelRequest, answer: Answer, signal: AbortSignal | null | undefined): Promise<Response> {
  if (request.wire === 'anthropic') {
    if ('openai' in answer) throw new Error(`request ${request.index} came on the Anthropic wire, but its answer is a Chat Completions reply`);
    return replyResponse(isTurn(answer) ? anthropicReply(answer, String(request.body.model)) : answer.anthropic, signal);
  }
  if ('anthropic' in answer) throw new Error(`request ${request.index} came on the Chat Completions wire, but its answer is an Anthropic reply`);
  return chatResponse(isTurn(answer) ? chatReply(answer) : answer.openai, signal);
}

/** Answers in order; an entry with `when` waits for a request it accepts. Entries pushed later are served too. */
function scriptOf(entries: ScriptEntry[]) {
  const used = new Set<number>();
  return {
    entries,
    next(request: ModelRequest): Responder | undefined {
      const at = entries.findIndex((entry, i) => !used.has(i) && (!isEntry(entry) || entry.when === undefined || entry.when(request)));
      if (at < 0) return undefined;
      used.add(at);
      const entry = entries[at]!;
      return isEntry(entry) ? entry.answer : entry;
    },
  };
}

const respond = async (responder: Responder, request: ModelRequest): Promise<Answer> => (typeof responder === 'function' ? responder(request) : responder);

const readCassette = (file: string): Cassette => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Cassette) : { entries: [] });

/** The main checkout's .env, which holds the Model Studio key for live recording. Its values are never printed. */
function mainEnv(): Record<string, string> {
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', cwd: path.dirname(RECORDINGS) }).stdout.trim();
  const file = path.join(path.dirname(common), '.env');
  if (!existsSync(file)) throw new Error(`live recording reads DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL from ${file}, which does not exist`);
  const pairs = readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line) => {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      return match === null ? [] : [[match[1]!, match[2]!.replace(/^["']|["']$/g, '')] as const];
    });
  return Object.fromEntries(pairs);
}

/** Sends the request to Model Studio's Anthropic endpoint and keeps its whole stream as the answer. */
async function liveAnswer(request: ModelRequest): Promise<Answer> {
  if (request.wire !== 'anthropic') throw new Error('live recording speaks the Anthropic wire only; record a Chat Completions request with GCODE_RECORD=1 and a fallback script');
  const env = mainEnv();
  const base = env['DASHSCOPE_BASE_URL'];
  const key = env['DASHSCOPE_API_KEY'];
  if (base === undefined || key === undefined) throw new Error('live recording needs DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL in the main checkout’s .env');
  const headers = new Headers({ 'content-type': 'application/json', authorization: `Bearer ${key}` });
  for (const name of ['anthropic-version', 'anthropic-beta']) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const response = await globalThis.fetch(`${base.replace(/\/$/, '')}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(request.body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`live recording got HTTP ${response.status} from Model Studio: ${text.slice(0, 300)}`);
  const events = text.split('\n').flatMap((line) => (line.startsWith('data:') ? [JSON.parse(line.slice(5)) as Reply['events'][number]] : []));
  return { anthropic: { events } };
}

function recorder(source: Extract<Source, { recording: string }>) {
  const file = path.join(source.dir ?? RECORDINGS, `${source.recording}.json`);
  const env = process.env['GCODE_RECORD'];
  const mode: RecordMode = source.record ?? (env === 'live' ? 'live' : env === undefined || env === '' || env === '0' ? 'off' : 'script');
  const fallback = scriptOf([...(source.fallback ?? [])]);
  return async (request: ModelRequest): Promise<Answer> => {
    const key = requestKey(request.wire, request.body);
    const found = readCassette(file).entries.find((entry) => entry.key === key);
    if (found !== undefined) return found.answer;
    const asks = lastUserText(request.body).slice(-200);
    if (mode === 'off') {
      const test = path.relative(process.cwd(), expect.getState().testPath ?? '<the test file>');
      throw new MissError(
        `fake model: no recording for ${request.wire} request ${request.index} (key ${key}) in ${file}. It asks: ${JSON.stringify(asks)}. ` +
          `The request changed shape (pnpm test:golden shows how) or the test is new. Record it with GCODE_RECORD=1 pnpm vitest run --project unit ${test} ` +
          '(answers from the fallback script), or GCODE_RECORD=live (answers from Model Studio).',
      );
    }
    const responder = mode === 'live' ? liveAnswer : fallback.next(request);
    if (responder === undefined) throw new MissError(`fake model: recording ${file} needs an answer for ${request.wire} request ${request.index}, and the fallback script has none left. It asks: ${JSON.stringify(asks)}`);
    const recorded = await respond(responder, request);
    const cassette = readCassette(file);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ entries: [...cassette.entries, { key, wire: request.wire, asks, answer: recorded }] }, null, 2)}\n`);
    return recorded;
  };
}

class MissError extends Error {}

/** A 400 the engine shows and does not retry, as a provider refuses a request it cannot read. */
function refusal(wire: Wire, message: string): Response {
  const error = { type: 'invalid_request_error', message };
  return new Response(JSON.stringify(wire === 'anthropic' ? { type: 'error', error } : { error }), { status: 400, headers: { 'content-type': 'application/json' } });
}

const wireOf = (method: string, pathname: string): Wire | undefined =>
  method !== 'POST' ? undefined : pathname.endsWith('/v1/messages') ? 'anthropic' : pathname.endsWith('/chat/completions') ? 'openai' : undefined;

const isModelRoute = (method: string, pathname: string): boolean => method === 'HEAD' || (method === 'GET' && pathname.endsWith('/models')) || wireOf(method, pathname) !== undefined;

export type FakeModel = ReturnType<typeof fakeModel>;

/**
 * A fake provider that speaks both wires: the Anthropic Messages API (`/v1/messages`) and Chat Completions
 * (`/chat/completions`), told apart by the request's path. `fetch` serves an engine in this process; `handle` serves
 * one over HTTP from a server of the test's own, and `listen` starts one. Every model request is kept in `requests`;
 * a request with no answer fails, and its reason is kept in `misses`.
 */
export function fakeModel(source: Source, opts: { readonly models?: readonly string[] } = {}) {
  const requests: ModelRequest[] = [];
  const misses: string[] = [];
  const waiting = new Map<number, (request: ModelRequest) => void>();
  const script = 'script' in source ? scriptOf([...source.script]) : undefined;
  const recorded = 'recording' in source ? recorder(source) : undefined;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    if (method === 'HEAD') return new Response(null, { status: 404 });
    if (method === 'GET' && url.pathname.endsWith('/models')) {
      const data = (opts.models ?? ['gpt-fake', 'gpt-fake-mini']).map((id) => ({ id, object: 'model' }));
      return new Response(JSON.stringify({ object: 'list', data }), { headers: { 'content-type': 'application/json' } });
    }
    const wire = wireOf(method, url.pathname);
    if (wire === undefined) return new Response(`the fake model has no ${method} ${url.pathname}`, { status: 404 });
    const request: ModelRequest = { wire, index: requests.length, url: url.href, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
    requests.push(request);
    waiting.get(request.index)?.(request);
    try {
      const responder = script !== undefined ? script.next(request) : recorded!;
      if (responder === undefined) throw new MissError(`fake model: the script has no answer for ${wire} request ${request.index}, which asks: ${JSON.stringify(lastUserText(request.body).slice(-200))}`);
      return await render(request, await respond(responder, request), init?.signal);
    } catch (error) {
      if (!(error instanceof MissError)) throw error;
      misses.push(error.message);
      return refusal(wire, error.message);
    }
  };

  /** Serves a model route of `req`; false leaves the request to the caller's own routes. */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = (req.url ?? '/').split('?')[0]!;
    if (!isModelRoute(req.method ?? 'GET', pathname)) return false;
    let text = '';
    for await (const piece of req) text += piece;
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      const response = await fetch(`http://fake-model${req.url}`, { method: req.method!, headers: req.headers as Record<string, string>, ...(text === '' ? {} : { body: text }), signal: abort.signal });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body !== null) for await (const piece of response.body) res.write(piece);
      res.end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' }).end(String(error instanceof Error ? error.message : error));
      else res.destroy();
    }
    return true;
  }

  async function listen(): Promise<{ readonly url: string; close(): Promise<void> }> {
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => void handle(req, res).then((handled) => handled || void res.writeHead(404).end()));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    return {
      url: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    };
  }

  return {
    fetch,
    handle,
    listen,
    requests,
    misses,
    /** Each model request's body as sent. */
    bodies: (): any[] => requests.map((request) => request.body),
    /** Resolves when the `n`th model request (from 0) arrives. */
    arrived: (n: number): Promise<ModelRequest> =>
      requests[n] !== undefined ? Promise.resolve(requests[n]) : new Promise((resolve) => waiting.set(n, resolve)),
    /** Adds entries to a script, for answers that need a value the run made. */
    more(...entries: readonly ScriptEntry[]): void {
      if (script === undefined) throw new Error('more() adds to a script; a recording answers by key');
      script.entries.push(...entries);
    },
  };
}
