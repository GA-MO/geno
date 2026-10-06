// Measures the cached prefix (tools and system prompt) of each run configuration on Model Studio, with every tool in
// full and with the deferred roster, by the input tokens the API reports. Also prints the characters per token that
// CHARS_PER_TOKEN in packages/core/src/deferred-tools.ts is set from.
// Usage: pnpm tsx scripts/prefix-tokens.ts. Reads DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL from the environment, or
// from the .env named by GCODE_ENV_FILE (default: the repo's), and never prints either.
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  AGENT_MODE_SYSTEM_PROMPTS,
  AGENT_MODE_TOOL_DEFINITIONS,
  agentToolDefinition,
  BROWSER_TOOLS,
  BUILTIN_AGENTS,
  DEFERRED_TOOLS_NOTE,
  MESSAGE_AGENT_TOOL_DEFINITION,
  mcpCatalog,
  mcpToolDefinitions,
  toolRoster,
  userToolDefinitions,
  USER_TOOL_NAMES,
  widgetToolDefinitions,
} from '../packages/core/src/index.js';

const envFile = process.env['GCODE_ENV_FILE'] ?? new URL('../.env', import.meta.url).pathname;
const env = { ...(existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}), ...process.env };
const key = env['DASHSCOPE_API_KEY'];
const base = env['DASHSCOPE_BASE_URL'];
if (!key || !base) throw new Error('set DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL');
const MODEL = 'qwen3.8-flash';

async function inputTokens(tools: readonly Tool[], system: string | undefined): Promise<number> {
  const body = {
    model: MODEL,
    max_tokens: 1,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'Hi.' }],
    ...(tools.length === 0 ? {} : { tools }),
    ...(system === undefined ? {} : { system }),
  };
  const response = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as { usage?: { input_tokens: number; cache_read_input_tokens?: number }; error?: unknown };
  if (!response.ok || json.usage === undefined) throw new Error(`status ${response.status}: ${JSON.stringify(json.error)}`);
  return json.usage.input_tokens + (json.usage.cache_read_input_tokens ?? 0);
}

const bare = await inputTokens([], undefined);
const browser = mcpToolDefinitions(mcpCatalog(BROWSER_TOOLS));
const configs: Record<string, { tools: readonly Tool[]; system: string }> = {
  'eval (non-interactive, no MCP)': { tools: AGENT_MODE_TOOL_DEFINITIONS['non-interactive'], system: AGENT_MODE_SYSTEM_PROMPTS['non-interactive'] },
  'editor, Ask, no MCP': {
    tools: [...AGENT_MODE_TOOL_DEFINITIONS.ask, ...userToolDefinitions('ask', new Set(USER_TOOL_NAMES)), ...widgetToolDefinitions('ask', true)],
    system: AGENT_MODE_SYSTEM_PROMPTS.ask,
  },
  'editor, Ask, browser and agent tool': {
    tools: [
      ...AGENT_MODE_TOOL_DEFINITIONS.ask,
      ...userToolDefinitions('ask', new Set(USER_TOOL_NAMES)),
      ...widgetToolDefinitions('ask', true),
      ...browser,
      agentToolDefinition(BUILTIN_AGENTS),
      MESSAGE_AGENT_TOOL_DEFINITION,
    ],
    system: AGENT_MODE_SYSTEM_PROMPTS.ask,
  },
};

const rows: string[] = ['| Configuration | Tools | Prefix tokens, all in full | Deferred | Prefix tokens, deferred | Saved |', '| --- | --- | --- | --- | --- | --- |'];
let chars = 0;
let tokens = 0;
for (const [name, { tools, system }] of Object.entries(configs)) {
  const roster = toolRoster(tools, -Infinity);
  const full = (await inputTokens(tools, system)) - bare;
  const deferred = (await inputTokens(roster.offered, `${system}\n\n${DEFERRED_TOOLS_NOTE}`)) - bare;
  const toolsOnly = (await inputTokens(tools, undefined)) - bare;
  chars += JSON.stringify(tools).length;
  tokens += toolsOnly;
  rows.push(`| ${name} | ${tools.length} | ${full} | ${roster.deferred.size} | ${deferred} | ${full - deferred} |`);
}
console.log(rows.join('\n'));
console.log(`\ncharacters of tool JSON per token: ${(chars / tokens).toFixed(2)}`);
