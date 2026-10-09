import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import { claudeDirOf, MCP_SOURCE_LABELS, MCP_SOURCES, SECRET_ENV_NAMES, type McpServerConfig, type McpSource, type McpTransport } from '@g-code/core';
import type { Env } from '../child-env.js';
import { loadPlugins, type InstalledPlugin } from '../plugins.js';
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
const ENGINE_SECRETS = new Set<string>([...SECRET_ENV_NAMES, 'ANTHROPIC_AUTH_TOKEN']);
const isEngineSecret = (name: string): boolean => ENGINE_SECRETS.has(name) || name.startsWith('GCODE_');

type Expander = (text: string) => string;

/**
 * `${VAR}` and `${VAR:-default}` from the engine's environment, as Claude Code expands them; `${workspaceFolder}` as
 * VS Code does. `own` holds the variables the file's source defines, such as a plugin's `${CLAUDE_PLUGIN_ROOT}`.
 */
function expander(env: Env, workspace: string, own: Readonly<Record<string, string>>, problems: string[], where: string): Expander {
  return (text) =>
    text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback: string | undefined) => {
      if (name === 'workspaceFolder') return workspace;
      const defined = own[name];
      if (defined !== undefined) return defined;
      if (isEngineSecret(name)) {
        problems.push(`${where}: \${${name}} is Geno's own credential and is never passed to an MCP server`);
        return '';
      }
      return env[name] ?? fallback ?? '';
    });
}

const mapValues = (record: Readonly<Record<string, string | number | null>>, expand: Expander): Record<string, string> =>
  Object.fromEntries(Object.entries(record).flatMap(([key, value]) => (value === null ? [] : [[key, expand(String(value))]])));

/**
 * Where a group of entries came from. `label` names it in problems, a relative `cwd` starts at `base`, `nameOf` gives
 * a server its session name, and `own` holds the variables the source defines, which a stdio server is also given.
 */
type Origin = {
  readonly source: McpSource;
  readonly label: string;
  readonly base: string;
  readonly nameOf: (name: string) => string;
  readonly own: Readonly<Record<string, string>>;
};

function transportOf(entry: z.infer<typeof serverEntry>, expand: Expander, origin: Origin): McpTransport {
  if ('url' in entry) return { kind: entry.type, url: expand(entry.url), headers: mapValues(entry.headers, expand) };
  return {
    kind: 'stdio',
    command: expand(entry.command),
    args: entry.args.map(expand),
    env: { ...origin.own, ...mapValues(entry.env, expand) },
    cwd: entry.cwd === undefined ? undefined : path.resolve(origin.base, expand(entry.cwd)),
  };
}

const errorText = (error: z.ZodError): string => z.prettifyError(error).replace(/\n/g, '; ');

function serversOf(entries: Readonly<Record<string, unknown>>, origin: Origin, env: Env, workspace: string, problems: string[]): McpServerConfig[] {
  return Object.entries(entries).flatMap(([raw, rawEntry]) => {
    const name = origin.nameOf(raw);
    const where = `${origin.label}: ${raw}`;
    if (!SERVER_NAME.test(name)) {
      problems.push(`${where}: a server name may use only letters, digits, - and _`);
      return [];
    }
    const entry = serverEntry.safeParse(rawEntry);
    if (!entry.success) {
      problems.push(`${where}: ${errorText(entry.error)}`);
      return [];
    }
    return [{ name, source: origin.source, transport: transportOf(entry.data, expander(env, workspace, origin.own, problems, where), origin) }];
  });
}

/** The file's JSON, or undefined when there is none or it is broken, which is a problem. */
async function readConfigFile(file: string, label: string, problems: string[]): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    problems.push(`${label}: ${(error as Error).message}`);
    return undefined;
  }
}

/** The entries under `key`, or with no key the whole object. */
function entriesOf(raw: unknown, key: string | undefined, label: string, problems: string[]): Readonly<Record<string, unknown>> {
  const record = z.record(z.string(), z.unknown());
  if (key === undefined) {
    const parsed = record.safeParse(raw);
    if (parsed.success) return parsed.data;
    problems.push(`${label}: ${errorText(parsed.error)}`);
    return {};
  }
  const parsed = z.looseObject({ [key]: record.default({}) }).safeParse(raw);
  if (parsed.success) return parsed.data[key] as Record<string, unknown>;
  problems.push(`${label}: ${errorText(parsed.error)}`);
  return {};
}

async function readSource(file: string, source: FileSource, env: Env, workspace: string, problems: string[]): Promise<McpServerConfig[]> {
  const origin: Origin = { source, label: MCP_SOURCE_LABELS[source], base: workspace, nameOf: (name) => name, own: {} };
  const raw = await readConfigFile(file, origin.label, problems);
  return raw === undefined ? [] : serversOf(entriesOf(raw, FILE_KEYS[source], origin.label, problems), origin, env, workspace, problems);
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A plugin's servers, as Claude Code reads them: its `.mcp.json`, whose servers sit under `mcpServers` or at the top,
 * and its manifest's `mcpServers`, which holds servers or names a file of them. Each is named
 * `plugin_<plugin>_<server>`, so its tools have the names Claude Code gives them and a rule written there applies.
 */
async function readPlugin(plugin: InstalledPlugin, env: Env, workspace: string, problems: string[]): Promise<McpServerConfig[]> {
  const origin: Origin = {
    source: 'plugin',
    label: `plugin ${plugin.name}`,
    base: plugin.root,
    nameOf: (name) => `plugin_${plugin.name}_${name}`.replace(/[^A-Za-z0-9_-]/g, '_'),
    own: { CLAUDE_PLUGIN_ROOT: plugin.root },
  };
  const groups: Readonly<Record<string, unknown>>[] = [];
  const fromFile = async (relative: string) => {
    const label = `${origin.label}: ${relative}`;
    const raw = await readConfigFile(path.resolve(plugin.root, relative), label, problems);
    if (raw !== undefined) groups.push(entriesOf(raw, isObject(raw) && 'mcpServers' in raw ? 'mcpServers' : undefined, label, problems));
  };
  await fromFile('.mcp.json');
  const manifest = await readConfigFile(path.join(plugin.root, '.claude-plugin', 'plugin.json'), `${origin.label}: plugin.json`, problems);
  const declared = isObject(manifest) ? manifest['mcpServers'] : undefined;
  for (const item of declared === undefined ? [] : Array.isArray(declared) ? declared : [declared]) {
    if (typeof item === 'string') await fromFile(item);
    else groups.push(entriesOf(item, undefined, `${origin.label}: plugin.json mcpServers`, problems));
  }
  return groups.flatMap((entries) => serversOf(entries, origin, env, workspace, problems));
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
  const global = await readSource(store.mcpConfigFile, 'global', env, workspace, problems);
  const plugin: McpServerConfig[] = [];
  for (const installed of (await loadPlugins(claudeDirOf(env), workspace)).plugins) plugin.push(...(await readPlugin(installed, env, workspace, problems)));
  const bySource: Readonly<Record<McpSource, McpServerConfig[]>> = {
    global,
    plugin,
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
