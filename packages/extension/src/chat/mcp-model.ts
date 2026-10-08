import type { McpServerState, McpServerView, McpSource } from '@g-code/core';

/** What the MCP panel shows: the shown session's servers as the engine reports them, and the problems in their files. */
export type McpListing =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly servers: readonly McpServerView[]; readonly problems: readonly string[] }
  | { readonly kind: 'failed'; readonly message: string };

/** What the extension tells the webview about MCP. */
export type McpToView = { readonly type: 'mcp'; readonly listing: McpListing } | { readonly type: 'show-mcp' };

/** What the webview asks of the extension about MCP; each is answered by an `mcp` message. */
export type McpFromView =
  | { readonly type: 'mcp-list' }
  /** `hash` is the definition the trust card showed; the engine refuses another. */
  | { readonly type: 'mcp-trust'; readonly name: string; readonly hash: string }
  | { readonly type: 'mcp-enable'; readonly name: string; readonly enabled: boolean };

/** Where each source's servers are defined, as the panel says it. `acp` servers are the ones the extension forwards. */
export const SOURCE_LABELS: Readonly<Record<McpSource, string>> = {
  global: '~/.g-code/mcp.json',
  plugin: 'Claude Code plugin',
  'vscode-mcp-json': '.vscode/mcp.json',
  'mcp-json': '.mcp.json',
  acp: 'VS Code user settings',
  builtin: 'Built in',
};

/** How a server's state reads in the panel, and the status color it wears. */
export type StateBadge = { readonly label: string; readonly tone: 'ok' | 'wait' | 'busy' | 'failed' | 'quiet'; readonly detail?: string | undefined };

const BADGES: { readonly [S in McpServerState['status']]: (state: Extract<McpServerState, { status: S }>, tools: number, server: McpServerView) => StateBadge } = {
  untrusted: () => ({ label: 'Needs your approval', tone: 'wait' }),
  disabled: () => ({ label: 'Off', tone: 'quiet' }),
  // The engine starts every trusted server of an open session, so a stopped one is about to start.
  stopped: (_state, _tools, { startsOn }) => (startsOn === 'first-use' ? { label: 'Starts on first use', tone: 'quiet' } : { label: 'Starting', tone: 'busy' }),
  starting: ({ restarts }) => ({ label: restarts === 0 ? 'Starting' : 'Restarting', tone: 'busy' }),
  ready: (_state, tools) => ({ label: tools === 1 ? 'Ready, 1 tool' : `Ready, ${tools} tools`, tone: 'ok' }),
  failed: ({ needsSignIn, reason }) => (needsSignIn ? { label: 'Needs sign-in', tone: 'wait', detail: 'Geno does not support MCP sign-in yet.' } : { label: 'Failed', tone: 'failed', detail: reason }),
};

export const badgeOf = (server: McpServerView): StateBadge =>
  (BADGES[server.state.status] as (state: McpServerState, tools: number, server: McpServerView) => StateBadge)(server.state, server.tools.length, server);

/** A server waits on the user when it is untrusted and not turned off. */
export const awaitsApproval = (server: McpServerView): boolean => server.state.status === 'untrusted';

/**
 * A server still on its way: starting, or trusted and about to start, since the engine starts every trusted server of
 * an open session in the background. The panel asks again until none is.
 */
export const isSettling = (listing: McpListing): boolean =>
  listing.kind === 'loaded' &&
  listing.servers.some((server) => server.state.status === 'starting' || (server.state.status === 'stopped' && server.startsOn === 'session'));

/** Names as the engine sanitizes them into tool names: everything but `[A-Za-z0-9_]` becomes `_`. */
const sanitized = (server: string): string => server.replace(/[^A-Za-z0-9_]/g, '_');

/**
 * The server and tool of an MCP tool call, from its model-facing name `mcp__<server>__<tool>`. A known server name
 * is matched first, longest first, so `chrome-devtools` shows as itself rather than as `chrome_devtools`.
 */
export function mcpCallOf(name: string, servers: readonly string[]): { readonly server: string; readonly tool: string } | undefined {
  if (!name.startsWith('mcp__')) return undefined;
  const known = servers.filter((server) => name.startsWith(`mcp__${sanitized(server)}__`)).sort((a, b) => b.length - a.length)[0];
  if (known !== undefined) return { server: known, tool: name.slice(`mcp__${sanitized(known)}__`.length) };
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match === null ? undefined : { server: match[1]!, tool: match[2]! };
}

let serverNames: readonly string[] = [];

/** The servers the panel knows, for naming MCP calls on the rail. */
export const setServerNames = (names: readonly string[]): void => {
  serverNames = names;
};

export const mcpCall = (name: string) => mcpCallOf(name, serverNames);
