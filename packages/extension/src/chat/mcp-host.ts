import * as vscode from 'vscode';
import {
  MCP_ENABLE_METHOD,
  MCP_SERVERS_METHOD,
  MCP_TRUST_METHOD,
  type McpEnableRequest,
  type McpServersRequest,
  type McpServersResponse,
  type McpTrustRequest,
} from '@g-code/core';
import type { Connection } from './engine.js';
import { isSettling, type McpFromView, type McpListing, type McpToView } from './mcp-model.js';

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

  constructor(
    private readonly link: () => Promise<Link>,
    private readonly post: (message: McpToView) => void,
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
    'mcp-enable': ({ name, enabled }) =>
      void this.ask((link) => link.connection.agent.request<McpServersResponse, McpEnableRequest>(MCP_ENABLE_METHOD, { sessionId: link.sessionId, name, enabled }), true),
  };

  private async ask(request: (link: Link) => Promise<McpServersResponse>, warnOnFailure = false): Promise<void> {
    const generation = ++this.generation;
    clearTimeout(this.timer);
    let next: McpListing;
    try {
      const { servers, problems } = await request(await this.link());
      next = { kind: 'loaded', servers, problems };
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
