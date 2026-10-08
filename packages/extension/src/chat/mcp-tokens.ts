import { randomBytes } from 'node:crypto';
import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  extractWWWAuthenticateParams,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { checkResourceAllowed, resourceUrlFromServerUrl } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import type { AuthorizationServerMetadata, OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type * as vscode from 'vscode';
import { z } from 'zod';

/** The part of VS Code's SecretStorage the store uses, so a test can hand it a fake. */
export type Secrets = Pick<vscode.SecretStorage, 'get' | 'store' | 'delete'>;

/** The server a sign-in belongs to, as the engine names it when it asks for a token. */
export type McpServerKey = { readonly name: string; readonly url: string };

/**
 * How a sign-in reaches the user: the address the authorization server sends them back to, and opening its page,
 * which resolves with the query it sent them back with.
 */
export type SignInBrowser = { readonly redirectUrl: string; authorize(url: URL): Promise<URLSearchParams> };

/** An access token this close to its expiry is refreshed before it is handed out. */
const EXPIRY_MARGIN_MS = 60_000;

/** What SecretStorage holds for one server, as JSON. The metadata and client are kept so a refresh needs no discovery. */
const savedSchema = z.object({
  authorizationServer: z.string(),
  resource: z.string().optional(),
  metadata: z.looseObject({ token_endpoint: z.string() }).optional(),
  client: z.looseObject({ client_id: z.string(), redirect_uris: z.array(z.string()) }),
  tokens: z.looseObject({ access_token: z.string(), token_type: z.string(), refresh_token: z.string().optional() }),
  expiresAt: z.number().optional(),
});
type Saved = {
  readonly authorizationServer: string;
  readonly resource?: string | undefined;
  readonly metadata?: AuthorizationServerMetadata | undefined;
  readonly client: OAuthClientInformationFull;
  readonly tokens: OAuthTokens;
  readonly expiresAt?: number | undefined;
};

/** The SDK's options predate exactOptionalPropertyTypes, so an option without a value is left out rather than undefined. */
const present = <K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } => (value === undefined ? {} : ({ [key]: value } as { [P in K]?: V }));

const keyOf = ({ name, url }: McpServerKey): string => `gcode.mcp.oauth:${JSON.stringify([name, url])}`;

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'geno', version: '0.0.0' } },
});

/**
 * The user's OAuth sign-ins to HTTP MCP servers, kept in VS Code's SecretStorage and nowhere else. It signs in as
 * the MCP authorization spec has it (protected resource metadata, authorization server metadata, dynamic client
 * registration, PKCE) and hands out access tokens, refreshing one that expired or that a server refused. The engine
 * only ever gets an access token; the refresh token never leaves here.
 */
export class McpTokenStore {
  readonly #refreshing = new Map<string, Promise<string | undefined>>();

  constructor(
    private readonly secrets: Secrets,
    private readonly now: () => number = Date.now,
  ) {}

  async isSignedIn(server: McpServerKey): Promise<boolean> {
    return (await this.#read(server)) !== undefined;
  }

  /** The access token for `server`, refreshed when it expired or `rejected` says the server refused it; undefined when signed out. */
  async accessToken(server: McpServerKey, rejected: boolean): Promise<string | undefined> {
    const saved = await this.#read(server);
    if (saved === undefined) return undefined;
    if (!rejected && (saved.expiresAt === undefined || saved.expiresAt - EXPIRY_MARGIN_MS > this.now())) return saved.tokens.access_token;
    const key = keyOf(server);
    const running = this.#refreshing.get(key);
    if (running !== undefined) return running;
    const refresh = this.#refresh(server, saved).finally(() => this.#refreshing.delete(key));
    this.#refreshing.set(key, refresh);
    return refresh;
  }

  async signIn(server: McpServerKey, browser: SignInBrowser): Promise<void> {
    const serverUrl = new URL(server.url);
    const challenge = await this.#challenge(serverUrl);
    const info = await discoverOAuthServerInfo(serverUrl, present('resourceMetadataUrl', challenge.resourceMetadataUrl));
    const declared = info.resourceMetadata?.resource;
    if (declared !== undefined && !checkResourceAllowed({ requestedResource: serverUrl, configuredResource: declared })) {
      throw new Error(`${server.name} says it is ${declared}, not ${server.url}, so Geno does not sign in to it`);
    }
    const resource = declared === undefined ? resourceUrlFromServerUrl(serverUrl) : new URL(declared);
    const metadata = info.authorizationServerMetadata;
    const scope = challenge.scope ?? info.resourceMetadata?.scopes_supported?.join(' ');
    const known = await this.#read(server);
    const client =
      known !== undefined && known.authorizationServer === info.authorizationServerUrl && known.client.redirect_uris.includes(browser.redirectUrl)
        ? known.client
        : await this.#register(server, info.authorizationServerUrl, metadata, browser.redirectUrl, scope);
    const state = randomBytes(16).toString('base64url');
    const { authorizationUrl, codeVerifier } = await startAuthorization(info.authorizationServerUrl, {
      ...present('metadata', metadata),
      clientInformation: client,
      redirectUrl: browser.redirectUrl,
      state,
      resource,
      ...present('scope', scope),
    });
    const back = await browser.authorize(authorizationUrl);
    if (back.get('state') !== state) throw new Error('the sign-in came back for another request; try again');
    const refused = back.get('error');
    if (refused !== null) throw new Error(`${server.name} refused the sign-in: ${back.get('error_description') ?? refused}`);
    const code = back.get('code');
    if (code === null) throw new Error(`${server.name} sent no authorization code back`);
    const tokens = await exchangeAuthorization(info.authorizationServerUrl, {
      ...present('metadata', metadata),
      clientInformation: client,
      authorizationCode: code,
      codeVerifier,
      redirectUri: browser.redirectUrl,
      resource,
    });
    await this.#write(server, { authorizationServer: info.authorizationServerUrl, resource: resource.href, metadata, client, ...this.#stamped(tokens) });
  }

  async signOut(server: McpServerKey): Promise<void> {
    await this.secrets.delete(keyOf(server));
  }

  /** The 401's WWW-Authenticate names the protected resource metadata and the scope; a server that answers otherwise is found by its well-known address. */
  async #challenge(serverUrl: URL): Promise<{ readonly resourceMetadataUrl?: URL | undefined; readonly scope?: string | undefined }> {
    const response = await fetch(serverUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: INITIALIZE });
    await response.body?.cancel();
    return response.status === 401 ? extractWWWAuthenticateParams(response) : {};
  }

  async #register(server: McpServerKey, authorizationServer: string, metadata: AuthorizationServerMetadata | undefined, redirectUrl: string, scope: string | undefined) {
    if (metadata !== undefined && metadata.registration_endpoint === undefined) {
      throw new Error(`${server.name} offers no client registration, so Geno cannot sign in to it`);
    }
    return registerClient(authorizationServer, {
      ...present('metadata', metadata),
      clientMetadata: {
        client_name: 'Geno',
        redirect_uris: [redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      ...present('scope', scope),
    });
  }

  /** A refresh the server refuses ends the sign-in; one that cannot reach it keeps the sign-in for the next try. */
  async #refresh(server: McpServerKey, saved: Saved): Promise<string | undefined> {
    const refreshToken = saved.tokens.refresh_token;
    if (refreshToken === undefined) {
      await this.signOut(server);
      return undefined;
    }
    let tokens: OAuthTokens;
    try {
      tokens = await refreshAuthorization(saved.authorizationServer, {
        ...present('metadata', saved.metadata),
        clientInformation: saved.client,
        refreshToken,
        ...present('resource', saved.resource),
      });
    } catch (error) {
      if (error instanceof OAuthError) await this.signOut(server);
      return undefined;
    }
    await this.#write(server, { ...saved, ...this.#stamped(tokens) });
    return tokens.access_token;
  }

  #stamped(tokens: OAuthTokens): Pick<Saved, 'tokens' | 'expiresAt'> {
    return { tokens, expiresAt: tokens.expires_in === undefined ? undefined : this.now() + tokens.expires_in * 1000 };
  }

  async #read(server: McpServerKey): Promise<Saved | undefined> {
    const text = await this.secrets.get(keyOf(server));
    if (text === undefined) return undefined;
    try {
      const parsed = savedSchema.safeParse(JSON.parse(text));
      return parsed.success ? (parsed.data as Saved) : undefined;
    } catch {
      return undefined;
    }
  }

  async #write(server: McpServerKey, saved: Saved): Promise<void> {
    await this.secrets.store(keyOf(server), JSON.stringify(saved));
  }
}
