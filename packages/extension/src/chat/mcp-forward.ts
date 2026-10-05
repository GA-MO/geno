import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';

/**
 * The MCP servers the extension hands the engine in session/new. The engine trusts what the editor hands it, so
 * these come only from the user's own VS Code `mcp.json`, in the user data folder. A workspace's
 * `.vscode/mcp.json` is never read here: the engine reads it itself and holds its servers for the user's approval.
 */
export type Forwarded = { readonly servers: readonly acp.McpServer[]; readonly problems: readonly string[] };

/** The user's `mcp.json`, beside `settings.json`; the extension's global storage is `<User>/globalStorage/<id>`. */
export const userMcpFile = (globalStorage: string): string => path.join(globalStorage, '..', '..', 'mcp.json');

const stringMap = z.record(z.string(), z.string());

/** One entry of VS Code's `servers`. `inputs` prompts and `envFile` are not supported. */
const entrySchema = z.union([
  z.object({ type: z.literal('stdio').optional(), command: z.string().min(1), args: z.array(z.string()).default([]), env: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).default({}), cwd: z.string().optional() }),
  z.object({ type: z.enum(['http', 'sse']), url: z.string().min(1), headers: stringMap.default({}) }),
]);
const fileSchema = z.looseObject({ servers: z.record(z.string(), z.unknown()).default({}) });

/** What `${...}` may name: `env:NAME`, `userHome` and `workspaceFolder`. Anything else, such as `input:`, leaves the server out. */
export type Variables = { readonly env: Readonly<Record<string, string | undefined>>; readonly userHome: string; readonly workspaceFolder: string | undefined };

class Unresolved extends Error {}

function expand(text: string, vars: Variables): string {
  return text.replace(/\$\{([^}]*)\}/g, (_match, name: string) => {
    if (name.startsWith('env:')) return vars.env[name.slice(4)] ?? '';
    if (name === 'userHome') return vars.userHome;
    if (name === 'workspaceFolder' && vars.workspaceFolder !== undefined) return vars.workspaceFolder;
    throw new Unresolved(`\${${name}} is not supported`);
  });
}

/** VS Code writes mcp.json as JSON with comments and trailing commas. */
export function stripJsonc(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      const end = /^"(?:[^"\\]|\\.)*"/.exec(text.slice(i))?.[0] ?? text.slice(i);
      out += end;
      i += end.length - 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 1;
    } else if (c !== ',' || !/^,\s*[}\]]/.test(text.slice(i))) out += c;
  }
  return out;
}

function serverOf(name: string, entry: z.infer<typeof entrySchema>, vars: Variables, problems: string[]): acp.McpServer {
  if ('url' in entry) {
    return { type: entry.type, name, url: expand(entry.url, vars), headers: Object.entries(entry.headers).map(([key, value]) => ({ name: key, value: expand(value, vars) })) };
  }
  if (entry.cwd !== undefined) problems.push(`${name}: cwd is not passed on; the server runs in the workspace folder`);
  return {
    name,
    command: expand(entry.command, vars),
    args: entry.args.map((arg) => expand(arg, vars)),
    env: Object.entries(entry.env).flatMap(([key, value]) => (value === null ? [] : [{ name: key, value: expand(String(value), vars) }])),
  };
}

/** The servers of the user's `mcp.json` text. A server that does not parse or names an unsupported variable is left out and reported. */
export function forwardedServers(text: string, vars: Variables): Forwarded {
  const problems: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonc(text));
  } catch (error) {
    return { servers: [], problems: [`mcp.json: ${(error as Error).message}`] };
  }
  const file = fileSchema.safeParse(raw);
  if (!file.success) return { servers: [], problems: [`mcp.json: ${z.prettifyError(file.error).replace(/\n/g, '; ')}`] };
  const servers = Object.entries(file.data.servers).flatMap(([name, value]): acp.McpServer[] => {
    const entry = entrySchema.safeParse(value);
    if (!entry.success) {
      problems.push(`${name}: ${z.prettifyError(entry.error).replace(/\n/g, '; ')}`);
      return [];
    }
    try {
      return [serverOf(name, entry.data, vars, problems)];
    } catch (error) {
      if (!(error instanceof Unresolved)) throw error;
      problems.push(`${name}: ${error.message}`);
      return [];
    }
  });
  return { servers, problems };
}

/** Reads the user's `mcp.json`; a missing file forwards nothing. */
export async function readForwarded(file: string, vars: Variables): Promise<Forwarded> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { servers: [], problems: [] };
    throw error;
  }
  return forwardedServers(text, vars);
}
