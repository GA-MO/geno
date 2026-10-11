import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { admit, sessionCookie, type Gate } from './security.js';
import { browserPage, type Theme } from './page.js';
import type { Note, Page, UiAnswer, UiRequest } from './vscode-shim.js';
import { webviews } from './vscode-shim.js';

const TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.html': 'text/plain',
  '.txt': 'text/plain',
};

/** How long a tab's page may be gone before its panel counts as closed. */
const CLOSED_AFTER_MS = 10_000;

/** A pasted screenshot rides in a `send` as base64, so a message may be large; anything past this is refused. */
const MAX_BODY = 64 * 1024 * 1024;

/** The event the page's script listens for, and its data. */
type ServerEvent = { readonly event: 'message'; readonly data: unknown } | { readonly event: 'note'; readonly data: Note } | { readonly event: 'ask'; readonly data: UiRequest & { readonly id: string } } | { readonly event: 'answered'; readonly data: { readonly id: string } };

type Client = { readonly view: string; readonly res: ServerResponse };

const headers = (type: string) => ({ 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });

const send = (res: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}): void => void res.writeHead(status, { ...headers(type), ...extra }).end(body);

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('the message is too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const isAnswer = (value: unknown): value is UiAnswer => {
  const answer = value as { kind?: unknown; index?: unknown; indexes?: unknown; value?: unknown } | null;
  if (typeof answer !== 'object' || answer === null) return false;
  if (answer.kind === 'cancel') return true;
  if (answer.kind === 'item') return Number.isInteger(answer.index);
  if (answer.kind === 'items') return Array.isArray(answer.indexes) && answer.indexes.every(Number.isInteger);
  return answer.kind === 'text' && typeof answer.value === 'string';
};

/**
 * The browser side of the shim: serves each webview's page, streams what the host posts to it over Server-Sent Events,
 * and takes what the page posts back. Only 127.0.0.1 hears it, and only a request carrying the token gets past `admit`.
 */
export class WebServer implements Page {
  private readonly clients = new Set<Client>();
  private readonly asked = new Map<string, { readonly request: UiRequest & { readonly id: string }; readonly resolve: (answer: UiAnswer) => void }>();
  private server: Server | undefined;
  private gate: Gate | undefined;

  constructor(
    private readonly token: string,
    private readonly client: string,
    private readonly theme: Theme,
  ) {}

  get origin(): string {
    if (this.gate === undefined) throw new Error('the web server is not listening yet');
    return `http://127.0.0.1:${this.gate.port}`;
  }

  async listen(port = 0): Promise<number> {
    const server = createServer((req, res) => void this.handle(req, res).catch((error: unknown) => send(res, 500, 'text/plain', error instanceof Error ? error.message : String(error))));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    this.server = server;
    this.gate = { port: (server.address() as AddressInfo).port, token: this.token };
    return this.gate.port;
  }

  close(): Promise<void> {
    for (const { res } of this.clients) res.end();
    this.clients.clear();
    return new Promise((resolve) => (this.server === undefined ? resolve() : this.server.close(() => resolve())));
  }

  post(view: string, message: unknown): void {
    this.emit({ event: 'message', data: message }, (client) => client.view === view);
  }

  /** Notes and questions go to the chat's pages; text to copy goes to every page, since the focused one may be a tab. */
  notify(note: Note): void {
    this.emit({ event: 'note', data: note }, (client) => note.kind === 'clipboard' || client.view === 'chat');
  }

  ask(request: UiRequest): Promise<UiAnswer> {
    const id = randomUUID();
    return new Promise((resolve) => {
      this.asked.set(id, { request: { ...request, id }, resolve });
      this.emit({ event: 'ask', data: { ...request, id } }, (client) => client.view === 'chat');
    });
  }

  private answer(id: string, answer: UiAnswer): void {
    const asked = this.asked.get(id);
    if (asked === undefined) return;
    this.asked.delete(id);
    asked.resolve(answer);
    this.emit({ event: 'answered', data: { id } }, (client) => client.view === 'chat');
  }

  private emit(event: ServerEvent, to: (client: Client) => boolean): void {
    const frame = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
    for (const client of this.clients) if (to(client)) client.res.write(frame);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const gate = this.gate!;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // One origin for the page and everything it loads, so its cookie and CSP hold; localhost is sent to 127.0.0.1.
    if (req.headers.host === `localhost:${gate.port}` && req.method === 'GET') return void res.writeHead(302, { location: `http://127.0.0.1:${gate.port}${req.url ?? '/'}` }).end();
    const verdict = admit(gate, { method: req.method ?? 'GET', url: req.url ?? '/', host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie });
    if (!verdict.ok) return send(res, verdict.status, 'text/plain', verdict.status === 401 ? 'Open the address Geno web printed, with its token.' : 'Refused.');
    if (verdict.fromQuery) {
      url.searchParams.delete('token');
      return void res.writeHead(303, { location: `${url.pathname}${url.search}`, 'set-cookie': sessionCookie(gate), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end();
    }
    const view = url.pathname === '/' ? 'chat' : /^\/view\/([\w.-]+)$/.exec(url.pathname)?.[1];
    if (req.method === 'GET' && view !== undefined) return this.page(res, view, url.searchParams.get('theme'));
    if (req.method === 'GET' && url.pathname === '/web-client.js') return send(res, 200, 'text/javascript', await readFile(this.client));
    if (req.method === 'GET' && url.pathname === '/events') return this.events(req, res, url.searchParams.get('view') ?? 'chat');
    if (req.method === 'POST' && url.pathname === '/message') return this.message(req, res, url.searchParams.get('view') ?? 'chat');
    if (req.method === 'POST' && url.pathname === '/answer') {
      const body = (await bodyOf(req)) as { id?: unknown; answer?: unknown };
      if (typeof body.id !== 'string' || !isAnswer(body.answer)) return send(res, 400, 'text/plain', 'not an answer');
      this.answer(body.id, body.answer);
      return send(res, 204, 'text/plain', '');
    }
    if (req.method === 'GET' && url.pathname.startsWith('/vscode-resource/')) return this.resource(res, decodeURIComponent(url.pathname.slice('/vscode-resource'.length)));
    send(res, 404, 'text/plain', 'Not found.');
  }

  private page(res: ServerResponse, view: string, theme: string | null): void {
    const webview = webviews.get(view);
    if (webview === undefined || webview.html === '') return send(res, 404, 'text/plain', 'That view is closed.');
    const nonce = randomBytes(16).toString('base64');
    send(res, 200, 'text/html', browserPage({ html: webview.html, nonce, origin: this.origin, view, theme: theme === 'light' ? 'light' : this.theme }));
  }

  private events(req: IncomingMessage, res: ServerResponse, view: string): void {
    res.writeHead(200, { ...headers('text/event-stream'), connection: 'keep-alive' });
    res.write(': open\n\n');
    const client = { view, res };
    this.clients.add(client);
    // A page that opens late still gets the questions nobody has answered.
    if (view === 'chat') for (const { request } of this.asked.values()) res.write(`event: ask\ndata: ${JSON.stringify(request)}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      this.clients.delete(client);
      // A tab's page that stays gone was closed, so its panel is disposed; a reload comes back well within this.
      if (view !== 'chat') setTimeout(() => [...this.clients].some((c) => c.view === view) || webviews.get(view)?.close(), CLOSED_AFTER_MS).unref();
    });
  }

  private async message(req: IncomingMessage, res: ServerResponse, view: string): Promise<void> {
    const webview = webviews.get(view);
    if (webview === undefined) return send(res, 404, 'text/plain', 'That view is closed.');
    const message = await bodyOf(req);
    if (typeof message !== 'object' || message === null || typeof (message as { type?: unknown }).type !== 'string') return send(res, 400, 'text/plain', 'not a message');
    send(res, 204, 'text/plain', '');
    webview.receive(message);
  }

  /** A file a webview may load: one inside a localResourceRoot of a webview that is open, as VS Code allows it. */
  private async resource(res: ServerResponse, file: string): Promise<void> {
    const real = await realpath(file).catch(() => undefined);
    const roots = await Promise.all([...webviews.values()].flatMap((webview) => webview.options.localResourceRoots ?? []).map((root) => realpath(root.fsPath).catch(() => root.fsPath)));
    if (real === undefined || !roots.some((root) => inside(root, real))) return send(res, 404, 'text/plain', 'Not found.');
    const body = await readFile(real).catch(() => undefined);
    if (body === undefined) return send(res, 404, 'text/plain', 'Not found.');
    // A workspace file opened as a page of its own runs sandboxed, in no origin, so it cannot post to this server.
    send(res, 200, TYPES[path.extname(real).toLowerCase()] ?? 'application/octet-stream', body, { 'content-security-policy': "sandbox; default-src 'none'" });
  }
}
