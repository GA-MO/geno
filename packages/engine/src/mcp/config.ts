import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import { MCP_SOURCE_LABELS, MCP_SOURCES, PROVIDER_ENV, type McpServerConfig, type McpSource, type McpTransport } from '@g-code/core';
import type { Env } from '../child-env.js';
import { isMissing, type Store } from '../store.js';

/** Every server the session can use, one per name, and what was wrong with the files they came from. */
export type McpConfig = { readonly servers: readonly McpServerConfig[]; readonly problems: readonly string[] };

const stringMap = z.record(z.string(), z.string());

/**
 * One server entry, as Claude Code's `.mcp.json` and VS Code's `.vscode/mcp.json` both write it: stdio unless `type`
 * says http or sse. VS Code's `inputs` prompts and `envFile` are not supported.
 */
const serverEntry = z.union([
  z.object({
    type: z.literal('stdio').optional(),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).default({}),
    cwd: z.string().optional(),
  }),
  z.object({ type: z.enum(['http', 'sse']), url: z.string().min(1), headers: stringMap.default({}) }),
]);

/** The key each file keeps its servers under. */
const FILE_KEYS = { global: 'mcpServers', 'mcp-json': 'mcpServers', 'vscode-mcp-json': 'servers' } as const;
type FileSource = keyof typeof FILE_KEYS;

/** A server's name is part of its tools' names, so it keeps to the characters a tool name allows. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Variables that hold Geno's own credentials, which a workspace file must not be able to pass to a server it names. */
const ENGINE_SECRETS = new Set<string>([...Object.values(PROVIDER_ENV).map(({ key }) => key), 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
const isEngineSecret = (name: string): boolean => ENGINE_SECRETS.has(name) || name.startsWith('GCODE_');

type Expander = (text: string) => string;

/** `${VAR}` and `${VAR:-default}` from the engine's environment, as Claude Code expands them; `${workspaceFolder}` as VS Code does. */
function expander(env: Env, workspace: string, problems: string[], where: string): Expander {
  return (text) =>
    text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback: string | undefined) => {
      if (name === 'workspaceFolder') return workspace;
      if (isEngineSecret(name)) {
        problems.push(`${where}: \${${name}} is Geno's own credential and is never passed to an MCP server`);
        return '';
      }
      return env[name] ?? fallback ?? '';
    });
}

const mapValues = (record: Readonly<Record<string, string | number | null>>, expand: Expander): Record<string, string> =>
  Object.fromEntries(Object.entries(record).flatMap(([key, value]) => (value === null ? [] : [[key, expand(String(value))]])));

function transportOf(entry: z.infer<typeof serverEntry>, expand: Expander, workspace: string): McpTransport {
  if ('url' in entry) return { kind: entry.type, url: expand(entry.url), headers: mapValues(entry.headers, expand) };
  return {
    kind: 'stdio',
    command: expand(entry.command),
    args: entry.args.map(expand),
    env: mapValues(entry.env, expand),
    cwd: entry.cwd === undefined ? undefined : path.resolve(workspace, expand(entry.cwd)),
  };
}

const errorText = (error: z.ZodError): string => z.prettifyError(error).replace(/\n/g, '; ');

async function readSource(file: string, source: FileSource, env: Env, workspace: string, problems: string[]): Promise<McpServerConfig[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const label = MCP_SOURCE_LABELS[source];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    problems.push(`${label}: ${(error as Error).message}`);
    return [];
  }
  const key = FILE_KEYS[source];
  const parsed = z.looseObject({ [key]: z.record(z.string(), z.unknown()).default({}) }).safeParse(raw);
  if (!parsed.success) {
    problems.push(`${label}: ${errorText(parsed.error)}`);
    return [];
  }
  const entries = parsed.data[key] as Record<string, unknown>;
  return Object.entries(entries).flatMap(([name, rawEntry]) => {
    const where = `${label}: ${name}`;
    if (!SERVER_NAME.test(name)) {
      problems.push(`${where}: a server name may use only letters, digits, - and _`);
      return [];
    }
    const entry = serverEntry.safeParse(rawEntry);
    if (!entry.success) {
      problems.push(`${where}: ${errorText(entry.error)}`);
      return [];
    }
    return [{ name, source, transport: transportOf(entry.data, expander(env, workspace, problems, where), workspace) }];
  });
}

/** The servers the editor passed in session/new. ACP's own `acp` transport is not supported. */
function fromAcp(servers: readonly acp.McpServer[], problems: string[]): McpServerConfig[] {
  return servers.flatMap((server): McpServerConfig[] => {
    if (!SERVER_NAME.test(server.name)) {
      problems.push(`the editor: ${server.name}: a server name may use only letters, digits, - and _`);
      return [];
    }
    if (!('type' in server) || server.type === undefined) {
      const env = Object.fromEntries(server.env.map(({ name, value }) => [name, value]));
      return [{ name: server.name, source: 'acp', transport: { kind: 'stdio', command: server.command, args: server.args, env, cwd: undefined } }];
    }
    if (server.type === 'http' || server.type === 'sse') {
      const headers = Object.fromEntries(server.headers.map(({ name, value }) => [name, value]));
      return [{ name: server.name, source: 'acp', transport: { kind: server.type, url: server.url, headers } }];
    }
    problems.push(`the editor: ${server.name}: the ${server.type} transport is not supported`);
    return [];
  });
}

/**
 * Every source merged by name. A later source in MCP_SOURCES replaces an earlier one's server of the same name, and
 * the replaced one is reported, so a workspace file can shadow a global server but never hide that it did.
 */
export async function loadMcpConfig(store: Store, env: Env, workspace: string, editor: readonly acp.McpServer[]): Promise<McpConfig> {
  const problems: string[] = [];
  const bySource: Readonly<Record<McpSource, McpServerConfig[]>> = {
    global: await readSource(store.mcpConfigFile, 'global', env, workspace, problems),
    'vscode-mcp-json': await readSource(path.join(workspace, '.vscode', 'mcp.json'), 'vscode-mcp-json', env, workspace, problems),
    'mcp-json': await readSource(path.join(workspace, '.mcp.json'), 'mcp-json', env, workspace, problems),
    acp: fromAcp(editor, problems),
    // The built-in browser is added by the hub, from the editor's settings, never from a file.
    builtin: [],
  };
  const merged = new Map<string, McpServerConfig>();
  for (const source of MCP_SOURCES) {
    for (const server of bySource[source]) {
      const shadowed = merged.get(server.name);
      if (shadowed !== undefined) problems.push(`${server.name} from ${MCP_SOURCE_LABELS[server.source]} replaces the one from ${MCP_SOURCE_LABELS[shadowed.source]}`);
      merged.set(server.name, server);
    }
  }
  return { servers: [...merged.values()].sort((a, b) => (a.name < b.name ? -1 : 1)), problems };
}
