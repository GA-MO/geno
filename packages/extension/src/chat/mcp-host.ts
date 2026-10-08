import * as vscode from 'vscode';
import {
  BROWSER_SERVER,
  MCP_ENABLE_METHOD,
  MCP_RECONNECT_METHOD,
  MCP_SERVERS_METHOD,
  MCP_TRUST_METHOD,
  type McpEnableRequest,
  type McpReconnectRequest,
  type McpServersRequest,
  type McpServersResponse,
  type McpServerView,
  type McpTrustRequest,
} from '@g-code/core';
import { setBrowserEnabled } from './browser.js';
import type { Connection } from './engine.js';
import { isSettling, offersSignIn, type McpFromView, type McpListing, type McpSignIn, type McpToView } from './mcp-model.js';
import { loopbackBrowser } from './mcp-sign-in.js';
import type { McpServerKey, McpTokenStore } from './mcp-tokens.js';

/** How often the panel asks again while a server is still starting. */
const SETTLE_POLL_MS = 1000;

type Link = { readonly connection: Connection; readonly sessionId: string };

/**
 * The shown session's MCP servers, as the engine reports them, kept current for the webview: asked for whenever
 * the session changes or a turn ends, and again each second while a server is starting.
 */
export class McpServers implements vscode.Disposable {
  private listing: McpListing = { kind: 'loading' };
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped by every refresh, so a slow answer never replaces a newer one. */
  private generation = 0;
  /** The servers whose sign-in runs now, by name. */
  private readonly signingIn = new Set<string>();

  constructor(
    private readonly link: () => Promise<Link>,
    private readonly post: (message: McpToView) => void,
    private readonly tokens: McpTokenStore,
  ) {}

  /** The latest listing, for a webview created after it arrived. */
  current(): McpListing {
    return this.listing;
  }

  refresh(): void {
    void this.ask((link) => link.connection.agent.request<McpServersResponse, McpServersRequest>(MCP_SERVERS_METHOD, { sessionId: link.sessionId }));
  }

  /** Each request answers with the servers, which become the listing. */
  readonly handlers: { readonly [K in McpFromView['type']]: (message: Extract<McpFromView, { type: K }>) => void } = {
    'mcp-list': () => this.refresh(),
    'mcp-trust': ({ name, hash }) =>
      void this.ask((link) => link.connection.agent.request<McpServersResponse, McpTrustRequest>(MCP_TRUST_METHOD, { sessionId: link.sessionId, name, hash }), true),
    // The browser's switch is the gcode.browser.enabled setting, whose change comes back through setEnabled.
    'mcp-enable': ({ name, enabled }) => (name === BROWSER_SERVER ? void setBrowserEnabled(enabled) : this.setEnabled(name, enabled)),
    'mcp-sign-in': ({ name }) => void this.signIn(name),
    'mcp-sign-out': ({ name }) => void this.signOut(name),
  };

  /** The listed HTTP server of that name, as the sign-in is keyed. */
  private keyOf(name: string, offered: (server: McpServerView) => boolean): McpServerKey | undefined {
    const server = this.listing.kind === 'loaded' ? this.listing.servers.find((each) => each.name === name) : undefined;
    return server === undefined || server.definition.kind === 'stdio' || !offered(server) ? undefined : { name, url: server.definition.url };
  }

  private async signIn(name: string): Promise<void> {
    const key = this.keyOf(name, offersSignIn);
    if (key === undefined || this.signingIn.has(name)) return;
    this.signingIn.add(name);
    this.refresh();
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Signing in to ${name}: finish in your browser`, cancellable: true },
        async (_progress, cancel) => {
          const browser = await loopbackBrowser(cancel);
          try {
            await this.tokens.signIn(key, browser);
          } finally {
            browser.close();
          }
        },
      );
    } catch (error) {
      if (!(error instanceof vscode.CancellationError)) void vscode.window.showWarningMessage(`Could not sign in to ${name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.signingIn.delete(name);
    }
    this.reconnect(name);
  }

  private async signOut(name: string): Promise<void> {
    const key = this.keyOf(name, () => true);
    if (key === undefined) return;
    await this.tokens.signOut(key);
    this.reconnect(name);
  }

  private reconnect(name: string): void {
    void this.ask((link) => link.connection.agent.request<McpServersResponse, McpReconnectRequest>(MCP_RECONNECT_METHOD, { sessionId: link.sessionId, name }), true);
  }

  private async signInsOf(servers: readonly McpServerView[]): Promise<Record<string, McpSignIn>> {
    const signIns: Record<string, McpSignIn> = {};
    for (const server of servers) {
      if (this.signingIn.has(server.name)) signIns[server.name] = 'signing-in';
      else if (server.definition.kind !== 'stdio' && (await this.tokens.isSignedIn({ name: server.name, url: server.definition.url }))) signIns[server.name] = 'signed-in';
    }
    return signIns;
  }

  setEnabled(name: string, enabled: boolean): void {
    void this.ask((link) => link.connection.agent.request<McpServersResponse, McpEnableRequest>(MCP_ENABLE_METHOD, { sessionId: link.sessionId, name, enabled }), true);
  }

  private async ask(request: (link: Link) => Promise<McpServersResponse>, warnOnFailure = false): Promise<void> {
    const generation = ++this.generation;
    clearTimeout(this.timer);
    let next: McpListing;
    try {
      const { servers, problems } = await request(await this.link());
      next = { kind: 'loaded', servers, problems, signIns: await this.signInsOf(servers) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (warnOnFailure) void vscode.window.showWarningMessage(message);
      if (generation !== this.generation) return;
      // A refused change leaves the servers as they were; the listing is asked for again.
      if (warnOnFailure) return this.refresh();
      next = { kind: 'failed', message };
    }
    if (generation !== this.generation) return;
    this.listing = next;
    this.post({ type: 'mcp', listing: next });
    if (isSettling(next)) this.timer = setTimeout(() => this.refresh(), SETTLE_POLL_MS);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.generation++;
  }
}
