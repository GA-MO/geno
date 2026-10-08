import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { fakeMcpServer } from './fake-mcp-server.js';

/**
 * A fake OAuth authorization server and an HTTP MCP server that wants its bearer tokens, each on its own 127.0.0.1
 * port, as the MCP authorization spec has them: a 401 naming the protected resource metadata, authorization server
 * metadata, dynamic client registration, PKCE with S256, and refresh tokens. `/authorize` approves at once and
 * redirects back, as a browser would after the user said yes.
 */
export type FakeOAuth = {
  readonly mcpUrl: string;
  readonly issuer: string;
  /** Every access and refresh token it issued, to look for where none may be. */
  readonly issued: readonly string[];
  /** What happened, in order: `register`, `authorize`, `token:<grant>`, `mcp:401` and `mcp:ok`. */
  readonly log: readonly string[];
  /** A token pair as a sign-in would end with, without the browser. */
  mint(): { readonly accessToken: string; readonly refreshToken: string };
  /** Every access token issued so far stops working, as when they expire; refresh tokens still do. */
  expireAccess(): void;
  /** Every token issued so far stops working, as when the user revokes the app. */
  revokeAll(): void;
  close(): Promise<void>;
};

const token = (kind: string): string => `fake-${kind}-${randomBytes(12).toString('hex')}`;
const challengeOf = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url');

async function bodyOf(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const json = (res: ServerResponse, status: number, value: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => void handler(req, res).catch((error: unknown) => res.writeHead(500).end(String(error))));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

export async function fakeOAuth(options: { readonly expiresIn?: number } = {}): Promise<FakeOAuth> {
  const expiresIn = options.expiresIn ?? 3600;
  const issued: string[] = [];
  const log: string[] = [];
  const clients = new Map<string, readonly string[]>();
  const codes = new Map<string, { readonly clientId: string; readonly redirectUri: string; readonly challenge: string }>();
  const resource = { mcpUrl: '' };
  const access = new Set<string>();
  const refresh = new Set<string>();
  const pair = () => {
    const accessToken = token('access');
    const refreshToken = token('refresh');
    access.add(accessToken);
    refresh.add(refreshToken);
    issued.push(accessToken, refreshToken);
    return { accessToken, refreshToken };
  };
  const answerTokens = (res: ServerResponse) => {
    const { accessToken, refreshToken } = pair();
    json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: expiresIn, refresh_token: refreshToken });
  };

  const auth = await listen(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /.well-known/oauth-authorization-server') {
      return json(res, 200, {
        issuer: auth.url,
        authorization_endpoint: `${auth.url}/authorize`,
        token_endpoint: `${auth.url}/token`,
        registration_endpoint: `${auth.url}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (route === 'POST /register') {
      const metadata = JSON.parse(await bodyOf(req)) as { redirect_uris: string[] };
      const clientId = token('client');
      clients.set(clientId, metadata.redirect_uris);
      log.push('register');
      return json(res, 201, { ...metadata, client_id: clientId, token_endpoint_auth_method: 'none' });
    }
    if (route === 'GET /authorize') {
      const query = url.searchParams;
      const clientId = query.get('client_id') ?? '';
      const redirectUri = query.get('redirect_uri') ?? '';
      if (!clients.get(clientId)?.includes(redirectUri)) return json(res, 400, { error: 'invalid_request', error_description: 'unknown client or redirect' });
      if (query.get('code_challenge_method') !== 'S256' || query.get('resource') !== resource.mcpUrl) return json(res, 400, { error: 'invalid_request' });
      const code = token('code');
      codes.set(code, { clientId, redirectUri, challenge: query.get('code_challenge') ?? '' });
      log.push('authorize');
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', query.get('state') ?? '');
      return void res.writeHead(302, { location: back.href }).end();
    }
    if (route === 'POST /token') {
      const form = new URLSearchParams(await bodyOf(req));
      const grant = form.get('grant_type') ?? '';
      log.push(`token:${grant}`);
      if (grant === 'authorization_code') {
        const code = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verified = code !== undefined && code.clientId === form.get('client_id') && code.redirectUri === form.get('redirect_uri') && code.challenge === challengeOf(form.get('code_verifier') ?? '');
        return verified ? answerTokens(res) : json(res, 400, { error: 'invalid_grant' });
      }
      if (grant === 'refresh_token' && refresh.delete(form.get('refresh_token') ?? '')) return answerTokens(res);
      return json(res, 400, { error: 'invalid_grant' });
    }
    res.writeHead(404).end();
  });

  const metadataPath = '/.well-known/oauth-protected-resource/mcp';
  const mcp = await listen(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === metadataPath) {
      return json(res, 200, { resource: resource.mcpUrl, authorization_servers: [auth.url], bearer_methods_supported: ['header'] });
    }
    if (url.pathname !== '/mcp') return void res.writeHead(404).end();
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (bearer === undefined || !access.has(bearer)) {
      log.push('mcp:401');
      return void res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${mcp.url}${metadataPath}"` }).end();
    }
    log.push('mcp:ok');
    const transport = new StreamableHTTPServerTransport({});
    await fakeMcpServer().connect(transport as Transport);
    await transport.handleRequest(req, res);
  });
  resource.mcpUrl = `${mcp.url}/mcp`;

  return {
    mcpUrl: resource.mcpUrl,
    issuer: auth.url,
    issued,
    log,
    mint: pair,
    expireAccess: () => access.clear(),
    revokeAll: () => (access.clear(), refresh.clear()),
    close: async () => {
      await Promise.all([auth.server, mcp.server].map((server) => new Promise((resolve) => (server.closeAllConnections(), server.close(resolve)))));
    },
  };
}
