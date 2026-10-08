import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import type { Readable } from 'node:stream';
import zlib from 'node:zlib';
import type { MessageStreamParams } from '@anthropic-ai/sdk/resources/messages/messages';
import { z } from 'zod';
import {
  changesHost,
  classifierInputOf,
  costOf,
  DEFAULT_CLASSIFIER_MODEL,
  decodeEntities,
  fetchAnswerText,
  htmlToMarkdown,
  isProviderName,
  isPublicAddress,
  readerRequest,
  redirectTargetOf,
  searchResultText,
  SEARCH_PROVIDER_SPECS,
  specOf,
  stripHidden,
  hostnameOf,
  webDenialFor,
  webTargetOf,
  WEB_LIMITS,
  type ApprovalRecord,
  type FetchedPage,
  type ProviderName,
  type Reachable,
  type SearchConfig,
  type SearchHit,
  type TokenUsage,
  type WebAction,
  type WebTarget,
  type WebTool,
} from '@g-code/core';
import { CLASSIFIER_ENV } from '../classifier.js';
import { messagesOf, usageOf } from '../gateway.js';
import { wireFor } from '../wire.js';
import { denialText, modeOf, refusalOf, settle, type Approval } from './agent.js';
import { executor, ToolError, type Executor, type ToolContext } from './context.js';

type Env = Readonly<Record<string, string | undefined>>;
type Address = { readonly address: string; readonly family: number };

/** Where a host name points. The default refuses a name of another host that points at a private address. */
export type Resolve = (hostname: string) => Promise<readonly Address[]>;

/** One helper call, for whoever counts what the tool spent. */
export type ReadRun = { readonly model: string; readonly usage: TokenUsage; readonly costUsd: number | null; readonly latencyMs: number };

export type WebDeps = {
  readonly approval: Approval;
  readonly env: Env;
  /** The session's own provider and model, the helper's last resort. */
  readonly session: { readonly provider: ProviderName; readonly model: string };
  /** For model calls, as every gateway gets. */
  readonly modelFetch?: typeof globalThis.fetch | undefined;
  readonly search?: SearchConfig | undefined;
  /** For the search provider's API. */
  readonly searchFetch?: typeof globalThis.fetch | undefined;
  readonly resolve?: Resolve | undefined;
  readonly onRead?: ((run: ReadRun) => void) | undefined;
};

/**
 * DNS for a host that is not this machine. Every address the name has must be public, and the connection then goes
 * to one of those very addresses, so a name cannot pass the check and connect somewhere else (DNS rebinding).
 */
export const guardedResolve =
  (lookup: (hostname: string) => Promise<readonly Address[]> = (hostname) => dnsLookup(hostname, { all: true, verbatim: true })): Resolve =>
  async (hostname) => {
    let addresses: readonly Address[];
    try {
      addresses = await lookup(hostname);
    } catch (error) {
      throw new ToolError(`could not find ${hostname}: ${(error as Error).message}`);
    }
    if (addresses.length === 0) throw new ToolError(`could not find ${hostname}`);
    const special = addresses.find(({ address }) => !isPublicAddress(address));
    if (special !== undefined) throw new ToolError(`${hostname} points at ${special.address}, a private, loopback or link-local address, which web_fetch does not reach`);
    return addresses;
  };

const pinned =
  (addresses: readonly Address[]): LookupFunction =>
  (_hostname, options, callback) => {
    if (options.all === true) callback(null, addresses.map(({ address, family }) => ({ address, family })));
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  };

export type Response = {
  readonly status: number;
  readonly location: string | undefined;
  readonly contentType: string;
  readonly body: Buffer;
  readonly truncated: boolean;
};

// Markdown first: some docs sites, Next.js's among them, serve it on request, which is cleaner than converted HTML.
const ACCEPT = 'text/markdown,text/html;q=0.9,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.1';

function decoded(res: http.IncomingMessage): Readable {
  const encoding = String(res.headers['content-encoding'] ?? '').trim().toLowerCase();
  if (encoding === 'gzip' || encoding === 'x-gzip') return res.pipe(zlib.createGunzip());
  if (encoding === 'deflate') return res.pipe(zlib.createInflate());
  if (encoding === 'br') return res.pipe(zlib.createBrotliDecompress());
  return res;
}

/** What a GET asks for and how much of the body it keeps. */
export type GetOptions = { readonly accept: string; readonly maxBytes: number; readonly agent: string };

const PAGE_GET: GetOptions = { accept: ACCEPT, maxBytes: WEB_LIMITS.maxBytes, agent: 'web_fetch' };

/** One GET, with no redirect followed; the cap counts decompressed bytes, so a small bomb cannot fill memory. */
export async function get(target: Reachable, resolve: Resolve, signal: AbortSignal, options: GetOptions = PAGE_GET): Promise<Response> {
  const url = new URL(target.url);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literal = url.hostname.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  const lookup = target.kind === 'remote' && !literal ? pinned(await resolve(hostname)) : undefined;
  const client = url.protocol === 'https:' ? https : http;
  return new Promise<Response>((done, fail) => {
    const req = client.request(
      {
        protocol: url.protocol,
        hostname,
        port: url.port === '' ? undefined : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { accept: options.accept, 'accept-encoding': 'gzip, deflate, br', 'user-agent': `Mozilla/5.0 (compatible; Geno ${options.agent})` },
        signal,
        ...(lookup === undefined ? {} : { lookup }),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === 'string' ? res.headers.location : undefined;
        const contentType = String(res.headers['content-type'] ?? '');
        if (status >= 300 && status < 400 && location !== undefined) {
          res.resume();
          done({ status, location, contentType, body: Buffer.alloc(0), truncated: false });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const body = decoded(res);
        const finish = () => done({ status, location, contentType, body: Buffer.concat(chunks), truncated });
        body.on('data', (chunk: Buffer) => {
          if (truncated) return;
          const room = options.maxBytes - size;
          chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
          size += Math.min(chunk.length, room);
          if (chunk.length >= room) {
            truncated = true;
            finish();
            res.destroy();
          }
        });
        body.on('end', () => {
          if (!truncated) finish();
        });
        body.on('error', (error) => {
          if (!truncated) fail(error);
        });
      },
    );
    req.on('error', fail);
    req.end();
  });
}

const TEXT_TYPES = /^(?:text\/|application\/(?:json|xml|javascript|ld\+json)|[^;]+\+(?:json|xml))/;

function charsetOf(contentType: string, body: Buffer): string {
  const declared = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  if (declared !== undefined) return declared;
  return /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 2048).toString('latin1'))?.[1] ?? 'utf-8';
}

function textOf(body: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

/** A markdown page's front matter title, else its first heading. */
function markdownTitle(text: string): string | undefined {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const named = front === undefined ? undefined : /^title:\s*(.+?)\s*$/m.exec(front)?.[1]?.replace(/^(["'])(.*)\1$/, '$2');
  return named || /^#\s+(.+?)\s*$/m.exec(text)?.[1];
}

/** The page as markdown. HTML is converted; other text is read as it is; anything else is refused. */
export function pageOf(url: string, response: Response): FetchedPage {
  const type = response.contentType.split(';')[0]!.trim().toLowerCase();
  // A page can hide instructions from the user in characters that do not show; the helper never sees them.
  const text = stripHidden(textOf(response.body, charsetOf(response.contentType, response.body)));
  const html = type === 'text/html' || type === 'application/xhtml+xml' || (type === '' && /^\s*</.test(text));
  if (html) {
    const { title, markdown } = htmlToMarkdown(text, url);
    return { url, title, markdown, truncated: response.truncated || markdown.length > WEB_LIMITS.maxPageChars };
  }
  if ((type !== '' && !TEXT_TYPES.test(type)) || text.includes('\u0000')) throw new ToolError(`web_fetch reads text pages, and ${url} is ${type || 'binary'}`);
  const title = type === 'text/markdown' ? markdownTitle(text) : undefined;
  return { url, title, markdown: text, truncated: response.truncated || text.length > WEB_LIMITS.maxPageChars };
}

type Choice = { readonly provider: ProviderName; readonly model: string; readonly role: 'explore' | 'classifier' | 'session' };

/**
 * The models that may read a page, cheapest first: the explore role's when the user mapped one, then the
 * classifier's, then the session's own.
 */
export function readerChoices(env: Env, session: WebDeps['session']): Choice[] {
  const choices: Choice[] = [];
  const explore = env['GCODE_EXPLORE_PROVIDER'];
  if (explore !== undefined && isProviderName(explore)) {
    const model = env['GCODE_EXPLORE_MODEL'] || specOf(explore).defaultModel;
    if (model !== undefined) choices.push({ provider: explore, model, role: 'explore' });
  }
  const classifierProvider = env[CLASSIFIER_ENV.provider];
  const classifierModel = env[CLASSIFIER_ENV.model];
  if ((classifierProvider || classifierModel) && classifierModel !== 'off') {
    const provider = classifierProvider || 'modelstudio';
    if (isProviderName(provider)) choices.push({ provider, model: classifierModel || DEFAULT_CLASSIFIER_MODEL, role: 'classifier' });
  }
  choices.push({ ...session, role: 'session' });
  return choices;
}

type Read = (request: (model: string) => MessageStreamParams, signal: AbortSignal) => Promise<string>;

function reader(deps: WebDeps): Read {
  return async (request, signal) => {
    let lastProblem = '';
    for (const choice of readerChoices(deps.env, deps.session)) {
      let wire;
      try {
        wire = wireFor(choice.provider, deps.env, deps.modelFetch);
      } catch (error) {
        lastProblem = messagesOf(error).join(': ');
        continue;
      }
      const started = performance.now();
      try {
        const message = await wire.stream(request(choice.model), { signal, onEvent: () => {} });
        const usage = usageOf(message);
        deps.onRead?.({ model: choice.model, usage, costUsd: costOf(choice.provider, choice.model, usage), latencyMs: Math.round(performance.now() - started) });
        return message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
      } catch (error) {
        if (signal.aborted) throw error;
        throw new ToolError(`the helper model ${choice.model} could not read the page: ${wire.redact(messagesOf(error).join(': '))}`);
      }
    }
    throw new ToolError(`no model is set up to read the page: ${lastProblem}`);
  };
}

const fetchInput = z.strictObject({ url: z.string().min(1), question: z.string().trim().min(1) });
const searchInput = z.strictObject({ query: z.string().trim().min(1) });

/** The fetch's own deadline, apart from the turn's signal, so a slow page fails as the model's error, not a stop. */
function deadline(signal: AbortSignal): { readonly signal: AbortSignal; readonly timedOut: () => boolean } {
  const timeout = AbortSignal.timeout(WEB_LIMITS.timeoutMs);
  return { signal: AbortSignal.any([signal, timeout]), timedOut: () => timeout.aborted && !signal.aborted };
}

/**
 * web_fetch, and web_search when a search key is set. Each fetch hop to a new host goes through the web rules and,
 * for a question, the classifier or the user; a refused hop ends the call.
 */
export function webExecutors(deps: WebDeps): Partial<Record<WebTool, Executor>> {
  const resolve = deps.resolve ?? guardedResolve();
  const read = reader(deps);

  const judge = async (action: WebAction, args: Record<string, unknown>, ctx: ToolContext, tool: WebTool): Promise<ApprovalRecord | undefined> => {
    const mode = modeOf(deps.approval);
    const denial = webDenialFor(action, mode, (await ctx.permissions?.list()) ?? []);
    if (denial === undefined) return undefined;
    const record = await settle(
      deps.approval,
      mode,
      denial,
      () => ({ ...classifierInputOf(ctx.events(), denial.command, denial), mcp: { server: 'geno', tool, arguments: JSON.stringify(args) } }),
      ctx,
      async (answer) => {
        if (answer === 'allow-workspace' && action.kind === 'fetch' && action.target.kind === 'remote') {
          await ctx.permissions?.add({ effect: 'allow', tool: 'web_fetch', domain: hostnameOf(action.target.url) });
        }
      },
    );
    if (record.verdict === 'deny') {
      throw refusalOf(record, denial.rule === 'web-refused-url' ? `denied: web_fetch may not ${denial.command}: ${denial.reason}. Do not retry it.` : denialText(record));
    }
    return record;
  };

  const web_fetch = executor({
    input: fetchInput,
    describe: ({ url }) => `web_fetch ${url}`,
    async run({ url, question }, ctx) {
      const records: ApprovalRecord[] = [];
      const keep = (record: ApprovalRecord | undefined) => record !== undefined && records.push(record);
      let target: WebTarget = webTargetOf(url);
      keep(await judge({ kind: 'fetch', target }, { url, question }, ctx, 'web_fetch'));
      const redirects: string[] = [];
      const limit = deadline(ctx.signal);
      let response: Response;
      for (;;) {
        const here = target as Reachable;
        try {
          response = await get(here, resolve, limit.signal);
        } catch (error) {
          if (ctx.signal.aborted || error instanceof ToolError) throw error;
          if (limit.timedOut()) throw new ToolError(`${here.url} did not answer within ${WEB_LIMITS.timeoutMs / 1000} seconds`);
          const why = messagesOf(error).filter((m) => m !== '').join(': ') || ((error as NodeJS.ErrnoException).code ?? 'the connection failed');
          throw new ToolError(`could not fetch ${here.url}: ${why}`);
        }
        if (response.location === undefined) break;
        if (redirects.length >= WEB_LIMITS.maxRedirects) throw new ToolError(`${url} redirected more than ${WEB_LIMITS.maxRedirects} times`);
        const next = redirectTargetOf(here, response.location);
        if (next.kind === 'refused' || changesHost(here, next)) {
          keep(await judge({ kind: 'fetch', target: next, redirectedFrom: here.url }, { url: next.url, redirected_from: here.url, question }, ctx, 'web_fetch'));
        }
        redirects.push(here.url);
        target = next;
      }
      const final = target as Reachable;
      if (response.status >= 400) throw new ToolError(`${final.url} answered HTTP ${response.status}`);
      const page = pageOf(final.url, response);
      const answer = await read((model) => readerRequest(page, question, model), ctx.signal);
      const text = fetchAnswerText({ page, answer, redirects });
      const approval = records.at(-1);
      return approval === undefined ? text : { text, approval };
    },
  });

  const { search } = deps;
  if (search === undefined) return { web_fetch };
  const spec = SEARCH_PROVIDER_SPECS[search.provider];
  const web_search = executor({
    input: searchInput,
    describe: ({ query }) => `web_search ${query}`,
    async run({ query }, ctx) {
      const approval = await judge({ kind: 'search', query, provider: spec.label }, { query }, ctx, 'web_search');
      const hits = await braveSearch(query, search.key, deps.searchFetch ?? globalThis.fetch, ctx.signal);
      const text = searchResultText(query, spec.label, hits);
      return approval === undefined ? text : { text, approval };
    },
  });
  return { web_fetch, web_search };
}

const braveAnswer = z.object({
  web: z.object({ results: z.array(z.looseObject({ title: z.string(), url: z.string(), description: z.string().optional() })).default([]) }).optional(),
});

const plain = (html: string): string => decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

export async function braveSearch(query: string, key: string, fetch: typeof globalThis.fetch, signal: AbortSignal): Promise<SearchHit[]> {
  const url = new URL(SEARCH_PROVIDER_SPECS.brave.endpoint);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(WEB_LIMITS.searchResults));
  const limit = deadline(signal);
  let response: globalThis.Response;
  try {
    response = await fetch(url, { headers: { accept: 'application/json', 'x-subscription-token': key }, signal: limit.signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ToolError(limit.timedOut() ? 'Brave Search did not answer in time' : `could not reach Brave Search: ${messagesOf(error).join(': ')}`);
  }
  if (!response.ok) {
    const why = response.status === 401 || response.status === 403 ? 'the key was refused; check it in Settings under Providers' : `HTTP ${response.status}`;
    throw new ToolError(`Brave Search failed: ${why}`);
  }
  const parsed = braveAnswer.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new ToolError('Brave Search gave an answer web_search cannot read');
  return (parsed.data.web?.results ?? []).slice(0, WEB_LIMITS.searchResults).map((hit) => ({ title: plain(hit.title), url: hit.url, snippet: plain(hit.description ?? '') }));
}
