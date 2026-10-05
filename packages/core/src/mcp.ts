// Portions ported from Pi (https://github.com/earendil-works/pi) at b2b5c42, Copyright (c) 2025 Mario Zechner, MIT License.

import { createHash } from 'node:crypto';
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';

/** Where a server definition came from. The order is precedence: a later source's server replaces an earlier one's of the same name. */
export const MCP_SOURCES = ['global', 'vscode-mcp-json', 'mcp-json', 'acp'] as const;
export type McpSource = (typeof MCP_SOURCES)[number];

/** A workspace file is written by whoever wrote the repository, so its servers wait for the user's approval. */
export const MCP_SOURCE_TRUST: Readonly<Record<McpSource, 'needs-approval' | 'trusted'>> = {
  global: 'trusted',
  'vscode-mcp-json': 'needs-approval',
  'mcp-json': 'needs-approval',
  acp: 'trusted',
};

/** The file each source is read from, relative to the workspace or the app home; ACP has none. */
export const MCP_SOURCE_LABELS: Readonly<Record<McpSource, string>> = {
  global: 'mcp.json in the app home',
  'vscode-mcp-json': '.vscode/mcp.json',
  'mcp-json': '.mcp.json',
  acp: 'the editor',
};

/** `http` is streamable HTTP, falling back to legacy SSE; `sse` is legacy SSE only. */
export type McpTransport =
  | {
      readonly kind: 'stdio';
      readonly command: string;
      readonly args: readonly string[];
      readonly env: Readonly<Record<string, string>>;
      readonly cwd: string | undefined;
    }
  | { readonly kind: 'http' | 'sse'; readonly url: string; readonly headers: Readonly<Record<string, string>> };

export type McpServerConfig = { readonly name: string; readonly source: McpSource; readonly transport: McpTransport };

/** A server's lifecycle. `stopped` is also where a trusted server waits for a session's first need. */
export type McpServerState =
  | { readonly status: 'untrusted' }
  | { readonly status: 'stopped' }
  /** `restarts` counts the crashes this start follows. */
  | { readonly status: 'starting'; readonly restarts: number }
  | { readonly status: 'ready'; readonly restarts: number }
  | { readonly status: 'failed'; readonly reason: string; readonly needsSignIn: boolean };
export type McpServerStatus = McpServerState['status'];

export type McpServerEvent =
  | { readonly type: 'trusted' }
  | { readonly type: 'start' }
  | { readonly type: 'connected' }
  | { readonly type: 'connect-failed'; readonly reason: string; readonly needsSignIn: boolean }
  | { readonly type: 'crashed'; readonly reason: string }
  | { readonly type: 'stop' };

/** A crashed server restarts at most this many times in a session, then stays failed. */
export const MCP_MAX_RESTARTS = 3;
export const restartDelayMs = (restarts: number): number => Math.min(500 * 2 ** (restarts - 1), 8000);

type Transitions = {
  readonly [S in McpServerStatus]: {
    readonly [E in McpServerEvent['type']]?: (
      state: Extract<McpServerState, { status: S }>,
      event: Extract<McpServerEvent, { type: E }>,
    ) => McpServerState;
  };
};

const toStopped = (): McpServerState => ({ status: 'stopped' });

const TRANSITIONS: Transitions = {
  untrusted: { trusted: toStopped },
  stopped: { start: () => ({ status: 'starting', restarts: 0 }) },
  starting: {
    connected: ({ restarts }) => ({ status: 'ready', restarts }),
    'connect-failed': (_state, { reason, needsSignIn }) => ({ status: 'failed', reason, needsSignIn }),
    stop: toStopped,
  },
  ready: {
    crashed: ({ restarts }, { reason }) =>
      restarts < MCP_MAX_RESTARTS
        ? { status: 'starting', restarts: restarts + 1 }
        : { status: 'failed', reason: `crashed ${restarts + 1} times; last: ${reason}`, needsSignIn: false },
    stop: toStopped,
  },
  failed: { stop: toStopped },
};

/** The state after `event`. An event the state does not take, such as `start` on a ready server, leaves it as it is. */
export function nextServerState(state: McpServerState, event: McpServerEvent): McpServerState {
  const step = (TRANSITIONS[state.status] as Record<string, ((s: McpServerState, e: McpServerEvent) => McpServerState) | undefined>)[event.type];
  return step === undefined ? state : step(state, event);
}

export const describeServerState = (state: McpServerState): string =>
  state.status === 'failed' ? (state.needsSignIn ? 'needs sign-in' : `failed: ${state.reason}`) : state.status;

// Key order must not change the hash: a reformatted file is the same definition.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** What a trust approval is keyed on: the server's name and everything that decides what runs. The source is left out. */
export const definitionHash = ({ name, transport }: McpServerConfig): string =>
  `sha256:${createHash('sha256').update(canonical({ name, transport })).digest('hex')}`;

/** One approval in the trust store. */
export type McpTrustEntry = { readonly workspace: string; readonly name: string; readonly hash: string; readonly approvedAt: string };

export const isTrusted = (config: McpServerConfig, workspace: string, entries: readonly McpTrustEntry[]): boolean =>
  MCP_SOURCE_TRUST[config.source] === 'trusted' ||
  entries.some((entry) => entry.workspace === workspace && entry.hash === definitionHash(config));

/** What the model is told of one server tool. `readOnly` is the server's own readOnlyHint. */
export type McpToolInfo = {
  readonly server: string;
  readonly tool: string;
  readonly description: string;
  readonly inputSchema: Tool['input_schema'];
  readonly readOnly: boolean;
};

/** Provider tool names are limited to 64 characters of `[A-Za-z0-9_-]`. */
const MAX_TOOL_NAME_LENGTH = 64;

/**
 * `mcp__<server>__<tool>`, sanitized and shortened with a hash suffix when too long. Everything but `[A-Za-z0-9_]`
 * becomes `_`. `isTaken` reports names used by a different tool, since sanitizing can map two tools to one name.
 */
export function mcpToolName(server: string, tool: string, isTaken: (name: string) => boolean = () => false): string {
  const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, '_');
  if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
  const hash = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 8);
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

/** Past this many MCP tools, the request lists them by name and the model asks for one schema at a time. */
export const MCP_LAZY_THRESHOLD = 40;

export const MCP_DESCRIBE_TOOL = 'mcp_describe';
export const MCP_CALL_TOOL = 'mcp_call';

/** Characters of the catalog in lazy mode; tool names that do not fit are counted in a closing line. */
export const MAX_CATALOG_CHARS = 8192;

/** Every MCP tool by its model-facing name, which is unique and sorted. */
export type McpCatalog = ReadonlyMap<string, McpToolInfo>;

export function mcpCatalog(tools: readonly McpToolInfo[]): McpCatalog {
  const named = new Map<string, McpToolInfo>();
  const sorted = tools.toSorted((a, b) => (a.server === b.server ? (a.tool < b.tool ? -1 : 1) : a.server < b.server ? -1 : 1));
  for (const info of sorted) named.set(mcpToolName(info.server, info.tool, (name) => named.has(name)), info);
  return new Map([...named].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const directDefinition = (name: string, info: McpToolInfo): Tool => ({
  name,
  description: `${info.description || `The ${info.tool} tool`} (MCP server ${info.server}.)`,
  input_schema: info.inputSchema,
});

/**
 * The servers and their tool names, one server per line, within MAX_CATALOG_CHARS. Lines past the budget are left out
 * and counted, so the description never grows without bound.
 */
export function catalogText(catalog: McpCatalog): string {
  const byServer = new Map<string, string[]>();
  for (const [name, info] of catalog) byServer.set(info.server, [...(byServer.get(info.server) ?? []), name]);
  const lines: string[] = [];
  let size = 0;
  let omitted = 0;
  for (const [server, names] of byServer) {
    const line = `- ${server}: ${names.join(', ')}`;
    if (size + line.length + 1 > MAX_CATALOG_CHARS) omitted += names.length;
    else {
      lines.push(line);
      size += line.length + 1;
    }
  }
  if (omitted > 0) lines.push(`- ... ${omitted} more tools not listed`);
  return lines.join('\n');
}

const lazyDefinitions = (catalog: McpCatalog): Tool[] => [
  {
    name: MCP_CALL_TOOL,
    description:
      'Call a tool of a connected MCP server by its full name, with the arguments its schema asks for. Get the schema with mcp_describe first.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The full tool name, such as mcp__server__tool.' },
        arguments: { type: 'object', description: 'The arguments, matching the schema mcp_describe returned.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: MCP_DESCRIBE_TOOL,
    description: `Return the description and input schema of one MCP tool. Call it before the first mcp_call of a tool. The connected MCP servers and their tools:\n${catalogText(catalog)}`,
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The full tool name, such as mcp__server__tool.' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
];

/**
 * The request's MCP tool definitions, sorted, for after the built-in ones. They change only when the set of servers or
 * their tools does, so the cached prefix holds across turns.
 */
export const mcpToolDefinitions = (catalog: McpCatalog): readonly Tool[] =>
  catalog.size > MCP_LAZY_THRESHOLD ? lazyDefinitions(catalog) : [...catalog].map(([name, info]) => directDefinition(name, info));

export const describeMcpTool = (name: string, info: McpToolInfo): string =>
  JSON.stringify({ name, server: info.server, description: info.description, readOnly: info.readOnly, input_schema: info.inputSchema }, null, 2);

/** One block of an MCP tool result, as far as the model's text needs it. */
export type McpContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mimeType: string; readonly data: string }
  | { readonly type: 'audio'; readonly mimeType: string; readonly data: string }
  | { readonly type: 'resource'; readonly uri: string; readonly text: string | undefined; readonly mimeType: string | undefined }
  | { readonly type: 'resource_link'; readonly uri: string; readonly name: string };

const base64Bytes = (data: string): number => Buffer.byteLength(data, 'base64');

const CONTENT_TEXT: { readonly [K in McpContent['type']]: (block: Extract<McpContent, { type: K }>) => string } = {
  text: ({ text }) => text,
  // Images reach the model as text until tool results carry images.
  image: ({ mimeType, data }) => `[image ${mimeType}, ${base64Bytes(data)} bytes, not shown]`,
  audio: ({ mimeType, data }) => `[audio ${mimeType}, ${base64Bytes(data)} bytes, not shown]`,
  resource: ({ uri, text, mimeType }) => (text === undefined ? `[resource ${uri} (${mimeType ?? 'binary'}), not shown]` : `[resource ${uri}]\n${text}`),
  resource_link: ({ uri, name }) => `[resource link ${name}: ${uri}]`,
};

/** The text a tool result shows the model. Without content blocks, the structured content stands in as JSON. */
export function mcpResultText(content: readonly McpContent[], structured: unknown): string {
  if (content.length === 0) return structured === undefined ? '(no output)' : JSON.stringify(structured, null, 2);
  return content.map((block) => (CONTENT_TEXT[block.type] as (b: McpContent) => string)(block)).join('\n');
}

/** A server's prompts and resources, listed as data for the composer and the MCP panel; nothing uses them yet. */
export type McpPromptInfo = { readonly server: string; readonly name: string; readonly description: string; readonly arguments: readonly string[] };
export type McpResourceInfo = { readonly server: string; readonly uri: string; readonly name: string; readonly mimeType: string | undefined };

/** Extension method, sent by the editor: every MCP server of a session with its source and state. */
export const MCP_SERVERS_METHOD = '_gcode/mcpServers';
/** Extension method, sent by the editor: approves one workspace server's current definition, then returns the servers. */
export const MCP_TRUST_METHOD = '_gcode/mcpTrust';

export type McpServerView = {
  readonly name: string;
  readonly source: McpSource;
  readonly hash: string;
  readonly state: McpServerState;
  readonly tools: readonly string[];
};
export type McpServersRequest = { readonly sessionId: string };
export type McpTrustRequest = { readonly sessionId: string; readonly name: string };
export type McpServersResponse = { readonly servers: readonly McpServerView[]; readonly problems: readonly string[] };
