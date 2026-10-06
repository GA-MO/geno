// Run from the repository root: pnpm tsx packages/engine/test/editor-actions-smoke.ts
// GCODE_ENV_FILE names the .env holding DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL; it defaults to the repo's.
// Asks qwen3.8-flash on Model Studio where a function is defined and to open it, under $0.03, and checks it calls
// open_file at the definition's line.
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { asSessionId, EDITOR_ACTION_METHOD, EDITOR_ACTIONS_CAPABILITY, type EditorAction, type EditorActionRequest } from '@g-code/core';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { rgCommand } from './helpers.js';

const MODEL = 'qwen3.8-flash';
const BUDGET_USD = 0.03;
const PROMPT = 'Where is parseConfig defined? Open it for me.';

const filler = (name: string, n: number) => Array.from({ length: n }, (_, i) => `export const ${name}${i} = ${i};`);
const DEFINED_AT = 31;
const FILES: Readonly<Record<string, string>> = {
  'src/config.ts': [...filler('limit', DEFINED_AT - 1), 'export function parseConfig(text: string): Record<string, string> {', '  return Object.fromEntries(text.split("\\n").map((l) => l.split("=")));', '}', ''].join('\n'),
  'src/main.ts': "import { parseConfig } from './config.js';\n\nexport const config = parseConfig('a=1');\n",
  'README.md': '# demo\n\nA small app that reads its config.\n',
};

async function main(): Promise<number> {
  const repo = path.resolve(import.meta.dirname, '../../..');
  const dotenv = parseEnv(await readFile(process.env['GCODE_ENV_FILE'] || path.join(repo, '.env'), 'utf8'));
  const key = dotenv['DASHSCOPE_API_KEY'];
  const baseUrl = dotenv['DASHSCOPE_BASE_URL'];
  if (!key || !baseUrl) throw new Error('the .env needs DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL');

  const work = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-editor-smoke-')));
  const workspace = path.join(work, 'workspace');
  const home = path.join(work, 'home');
  for (const [file, text] of Object.entries(FILES)) {
    await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await writeFile(path.join(workspace, file), text);
  }
  const env = { GCODE_HOME: home, GCODE_PROVIDER: 'modelstudio', GCODE_MODEL: MODEL, DASHSCOPE_API_KEY: key, DASHSCOPE_BASE_URL: baseUrl, GCODE_RG: rgCommand(), PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
  const logs: string[] = [];
  const io: Io = { env, cwd: workspace, out: (line) => logs.push(line), err: (line) => logs.push(line), write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch: globalThis.fetch };

  const actions: EditorAction[] = [];
  const calls: string[] = [];
  const client = acp
    .client({ name: 'editor-smoke' })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      if (params.update.sessionUpdate === 'tool_call') calls.push(params.update.title);
    })
    .onRequest(EDITOR_ACTION_METHOD, (raw) => raw as EditorActionRequest, ({ params }) => {
      actions.push(params.action);
      return {};
    });

  const store = openStore(env);
  let sessionId = '';
  await client.connectWith(gcodeAgent(io, store, { maxTurns: 6, maxCostUsd: BUDGET_USD }), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { _meta: { [EDITOR_ACTIONS_CAPABILITY]: true } } });
    sessionId = (await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] })).sessionId;
    // Plan mode, since the tools must work there and nothing in this task changes a file.
    await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId: 'plan' });
    await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: PROMPT }] });
  });

  const events = (await readFile(sessionFile(store, asSessionId(sessionId)), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const assistants: { usage?: { input: number; cacheRead: number; cacheWrite: number; output: number }; costUsd?: number | null }[] = events.filter((e) => e.kind === 'assistant');
  const cost = assistants.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
  const tokensIn = assistants.reduce((sum, e) => sum + (e.usage?.input ?? 0) + (e.usage?.cacheRead ?? 0) + (e.usage?.cacheWrite ?? 0), 0);
  const tokensOut = assistants.reduce((sum, e) => sum + (e.usage?.output ?? 0), 0);
  // Model Studio does not price qwen3.8-flash in the cost table, so fall back to the probe's per-token estimate.
  const estimate = cost > 0 ? cost : (tokensIn * 0.15 + tokensOut * 0.47) / 1e6;

  const target = path.join(workspace, 'src/config.ts');
  const opened = actions.find((a): a is Extract<EditorAction, { kind: 'open' }> => a.kind === 'open');
  console.log(`calls: ${calls.join(' | ')}`);
  console.log(`editor actions: ${JSON.stringify(actions.map((a) => ({ ...a, path: path.relative(workspace, a.path) })))}`);
  console.log(`tokens: ${tokensIn} in, ${tokensOut} out over ${assistants.length} model calls; estimated cost: $${estimate.toFixed(6)} (budget $${BUDGET_USD})`);
  const leaked = logs.some((line) => line.includes(key));
  const passed = opened?.path === target && opened.line === DEFINED_AT && estimate < BUDGET_USD && !leaked;
  console.log(`smoke: ${passed ? 'passed' : 'failed'}${opened === undefined ? ' (no open_file call)' : ` (open_file ${path.relative(workspace, opened.path)}:${opened.line ?? '-'}, expected src/config.ts:${DEFINED_AT})`}`);
  return passed ? 0 : 1;
}

void main().then((code) => (process.exitCode = code));
