import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SseError, SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpContent, McpPromptInfo, McpResourceInfo, McpServerConfig, McpToolInfo } from '@g-code/core';
import { mcpServerEnv, type Env } from '../child-env.js';

/** A server that answered `initialize`, with the tools it listed then. */
export type McpConnection = {
  readonly tools: readonly McpToolInfo[];
  call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpCallResult>;
  prompts(): Promise<McpPromptInfo[]>;
  resources(): Promise<McpResourceInfo[]>;
  close(): Promise<void>;
};

export type McpCallResult = { readonly content: readonly McpContent[]; readonly structured: unknown; readonly isError: boolean };

/** Why a connection could not be made; `needsSignIn` for a server that wants OAuth, which Geno does not do. */
export class McpConnectError extends Error {
  constructor(
    message: string,
    readonly needsSignIn: boolean,
  ) {
    super(message);
  }
}

/** The first start may download the server, as `npx -y` does. */
export const CONNECT_TIMEOUT_MS = 120_000;
export const CALL_TIMEOUT_MS = 120_000;
const STDERR_TAIL = 2000;

export type ConnectOptions = {
  readonly env: Env;
  readonly workspace: string;
  /** Called once when an open connection ends without close(): the process exited or the stream broke. */
  readonly onLost: (reason: string) => void;
};

const isUnauthorized = (error: unknown): boolean =>
  error instanceof UnauthorizedError || ((error instanceof StreamableHTTPError || error instanceof SseError) && error.code === 401);

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function contentOf(block: CallToolResult['content'][number]): McpContent {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'image':
    case 'audio':
      return { type: block.type, mimeType: block.mimeType, data: block.data };
    case 'resource':
      return { type: 'resource', uri: block.resource.uri, text: 'text' in block.resource ? String(block.resource.text) : undefined, mimeType: block.resource.mimeType };
    case 'resource_link':
      return { type: 'resource_link', uri: block.uri, name: block.name };
  }
}

async function listAll<T>(page: (cursor: string | undefined) => Promise<{ readonly items: readonly T[]; readonly nextCursor?: string | undefined }>): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  do {
    const { items, nextCursor } = await page(cursor);
    all.push(...items);
    cursor = nextCursor;
  } while (cursor !== undefined);
  return all;
}

const newClient = () => new Client({ name: 'geno', version: '0.0.0' });

async function connectStdio(config: McpServerConfig & { transport: { kind: 'stdio' } }, options: ConnectOptions): Promise<{ client: Client; stderr: () => string }> {
  const { command, args, env, cwd } = config.transport;
  const transport = new StdioClientTransport({
    command,
    args: [...args],
    // The SDK adds its own short list of non-secret basics, such as USER and SHELL, under these.
    env: mcpServerEnv(options.env, env),
    cwd: cwd ?? options.workspace,
    stderr: 'pipe',
  });
  let tail = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString('utf8')).slice(-STDERR_TAIL);
  });
  const client = newClient();
  await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  return { client, stderr: () => tail.trim() };
}

async function connectHttp(config: McpServerConfig & { transport: { kind: 'http' | 'sse' } }): Promise<Client> {
  const { kind, url, headers } = config.transport;
  const requestInit = { headers: { ...headers } };
  const attempt = async (transport: Transport) => {
    const client = newClient();
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    return client;
  };
  if (kind === 'sse') return attempt(new SSEClientTransport(new URL(url), { requestInit }));
  try {
    // The SDK's transports predate exactOptionalPropertyTypes.
    return await attempt(new StreamableHTTPClientTransport(new URL(url), { requestInit }) as Transport);
  } catch (error) {
    if (isUnauthorized(error)) throw error;
    // A server from before streamable HTTP refuses the POST; the legacy transport opens with a GET.
    return attempt(new SSEClientTransport(new URL(url), { requestInit }));
  }
}

export async function connectMcp(config: McpServerConfig, options: ConnectOptions): Promise<McpConnection> {
  let client: Client;
  let stderr = () => '';
  try {
    if (config.transport.kind === 'stdio') ({ client, stderr } = await connectStdio(config as McpServerConfig & { transport: { kind: 'stdio' } }, options));
    else client = await connectHttp(config as McpServerConfig & { transport: { kind: 'http' | 'sse' } });
  } catch (error) {
    if (isUnauthorized(error)) throw new McpConnectError('the server needs sign-in, which Geno does not support yet', true);
    const detail = stderr();
    throw new McpConnectError(detail === '' ? messageOf(error) : `${messageOf(error)}: ${detail}`, false);
  }

  let closing = false;
  client.onclose = () => {
    if (closing) return;
    closing = true;
    const detail = stderr();
    options.onLost(detail === '' ? 'the connection closed' : `the connection closed: ${detail}`);
  };

  let tools: McpToolInfo[];
  try {
    tools = await listAll(async (cursor) => {
      const page = await client.listTools(cursor === undefined ? {} : { cursor });
      return { items: page.tools, nextCursor: page.nextCursor };
    }).then((listed) =>
      listed.map((tool) => ({
        server: config.name,
        tool: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema as Tool['input_schema'],
        readOnly: tool.annotations?.readOnlyHint === true,
      })),
    );
  } catch (error) {
    closing = true;
    await client.close();
    throw new McpConnectError(`listing its tools failed: ${messageOf(error)}`, false);
  }

  const capabilities = client.getServerCapabilities() ?? {};
  return {
    tools,
    async call(tool, args, signal) {
      const result = (await client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: CALL_TIMEOUT_MS })) as CallToolResult;
      return { content: (result.content ?? []).map(contentOf), structured: result.structuredContent, isError: result.isError === true };
    },
    async prompts() {
      if (capabilities.prompts === undefined) return [];
      return listAll(async (cursor) => {
        const page = await client.listPrompts(cursor === undefined ? {} : { cursor });
        return { items: page.prompts, nextCursor: page.nextCursor };
      }).then((prompts) =>
        prompts.map((prompt) => ({ server: config.name, name: prompt.name, description: prompt.description ?? '', arguments: (prompt.arguments ?? []).map((arg) => arg.name) })),
      );
    },
    async resources() {
      if (capabilities.resources === undefined) return [];
      return listAll(async (cursor) => {
        const page = await client.listResources(cursor === undefined ? {} : { cursor });
        return { items: page.resources, nextCursor: page.nextCursor };
      }).then((resources) => resources.map((resource) => ({ server: config.name, uri: resource.uri, name: resource.name, mimeType: resource.mimeType })));
    },
    async close() {
      closing = true;
      await client.close();
    },
  };
}
