import { fileURLToPath } from 'node:url';

export type Env = Readonly<Record<string, string | undefined>>;

// The engine runs inside other projects, so its .env is found next to the engine, not in cwd.
export const ENGINE_ENV_FILE = fileURLToPath(new URL('../../../.env', import.meta.url));

export const CHILD_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR'] as const;

/** What every child process sees of the engine's environment, so no API key reaches a command the model chose. */
export function childEnv(env: Env, extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const picked = CHILD_ENV_KEYS.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]] as const]));
  return { ...Object.fromEntries(picked), ...extra };
}

export const MCP_SERVER_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'TMPDIR'] as const;

/** What a stdio MCP server sees: a few basics from the engine and the env its config declares, never an API key. */
export function mcpServerEnv(env: Env, declared: Readonly<Record<string, string>>): Record<string, string> {
  const picked = MCP_SERVER_ENV_KEYS.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]] as const]));
  return { ...Object.fromEntries(picked), ...declared };
}
