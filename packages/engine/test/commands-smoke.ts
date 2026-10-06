// Run from the repository root: pnpm tsx packages/engine/test/commands-smoke.ts
// GCODE_ENV_FILE names the .env holding DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL; it defaults to the repo's.
// One prompt on Model Studio that needs a few shell commands, to see the model describe each bash call, under $0.03.
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { asSessionId } from '@g-code/core';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { rgCommand } from './helpers.js';

const MODEL = 'qwen3.8-flash';
const BUDGET_USD = 0.03;
const PROMPT = 'Using shell commands, find out which folder here takes the most disk space, and how many lines each TypeScript file has.';

const FILES: Readonly<Record<string, string>> = {
  'src/a.ts': 'export const a = 1;\nexport const b = 2;\n',
  'src/b.ts': 'export const c = 3;\n',
  'docs/notes.md': `${'note\n'.repeat(200)}`,
  'assets/blob.txt': 'x'.repeat(50_000),
};

async function main(): Promise<number> {
  const repo = path.resolve(import.meta.dirname, '../../..');
  const dotenv = parseEnv(await readFile(process.env['GCODE_ENV_FILE'] || path.join(repo, '.env'), 'utf8'));
  const key = dotenv['DASHSCOPE_API_KEY'];
  const baseUrl = dotenv['DASHSCOPE_BASE_URL'];
  if (!key || !baseUrl) throw new Error('the .env needs DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL');

  const work = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-commands-smoke-')));
  const workspace = path.join(work, 'workspace');
  const home = path.join(work, 'home');
  for (const [file, text] of Object.entries(FILES)) {
    await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await writeFile(path.join(workspace, file), text);
  }
  const env = {
    GCODE_HOME: home,
    GCODE_PROVIDER: 'modelstudio',
    GCODE_MODEL: MODEL,
    DASHSCOPE_API_KEY: key,
    DASHSCOPE_BASE_URL: baseUrl,
    GCODE_RG: rgCommand(),
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  };
  const logs: string[] = [];
  const io: Io = {
    env,
    cwd: workspace,
    out: (line) => logs.push(line),
    err: (line) => logs.push(line),
    write: () => {},
    interrupts: () => new AbortController().signal,
    confirm: async () => false,
    fetch: globalThis.fetch,
  };

  const calls: { readonly command: string; readonly description: string | undefined }[] = [];
  const client = acp
    .client({ name: 'commands-smoke' })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      const { update } = params;
      if (update.sessionUpdate !== 'tool_call' || !update.title.startsWith('bash ')) return;
      const input = update.rawInput as { command: string; description?: string };
      calls.push({ command: input.command, description: input.description });
    })
    .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: 'selected', optionId: 'reject' } }));

  const store = openStore(env);
  let sessionId = '';
  await client.connectWith(gcodeAgent(io, store, { maxTurns: 8, maxCostUsd: BUDGET_USD }), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    sessionId = (await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] })).sessionId;
    await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: PROMPT }] });
  });

  const events = (await readFile(sessionFile(store, asSessionId(sessionId)), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const assistants = events.filter((e) => e.kind === 'assistant') as { usage?: { input: number; cacheRead: number; cacheWrite: number; output: number }; costUsd?: number | null }[];
  const cost = assistants.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
  const tokensIn = assistants.reduce((sum, e) => sum + (e.usage?.input ?? 0) + (e.usage?.cacheRead ?? 0) + (e.usage?.cacheWrite ?? 0), 0);
  const tokensOut = assistants.reduce((sum, e) => sum + (e.usage?.output ?? 0), 0);
  // Model Studio does not price qwen3.8-flash in the cost table, so fall back to the U37 probe's per-token estimate.
  const estimate = cost > 0 ? cost : (tokensIn * 0.15 + tokensOut * 0.47) / 1e6;

  for (const call of calls) console.log(`bash: ${JSON.stringify(call.description ?? null)}  <-  ${call.command}`);
  const described = calls.filter((c) => c.description !== undefined && c.description.trim() !== '').length;
  console.log(`described ${described} of ${calls.length} commands`);
  console.log(`tokens: ${tokensIn} in, ${tokensOut} out; estimated cost: $${estimate.toFixed(6)} (budget $${BUDGET_USD})`);
  const leaked = logs.some((line) => line.includes(key));
  const passed = calls.length >= 2 && described >= 2 && estimate < BUDGET_USD && !leaked;
  console.log(`smoke: ${passed ? 'passed' : 'failed'}`);
  return passed ? 0 : 1;
}

void main().then((code) => (process.exitCode = code));
