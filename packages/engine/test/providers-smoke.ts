// Run from the repository root: pnpm tsx packages/engine/test/providers-smoke.ts
// GCODE_ENV_FILE names the .env holding DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL; it defaults to the repo's.
// Calls Model Studio live through both adapters: its Anthropic endpoint, and its OpenAI-compatible one through
// the openai row with a base URL override. Prints usage and cost, never the key or the endpoint.
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { addUsage, asSessionId, costOf, ZERO_USAGE, type TokenUsage } from '@g-code/core';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand, runCli } from './helpers.js';
import { leaksOf } from './no-leak.js';

const MODEL = 'qwen3.8-flash';
/** Both adapters bill at Model Studio's own price for the model. */
const priced = (usage: TokenUsage) => costOf('modelstudio', MODEL, usage)!;

async function main(): Promise<number> {
  const root = path.resolve(import.meta.dirname, '../../..');
  const dotenv = parseEnv(await readFile(process.env['GCODE_ENV_FILE'] || path.join(root, '.env'), 'utf8'));
  const key = dotenv['DASHSCOPE_API_KEY'];
  const anthropicUrl = dotenv['DASHSCOPE_BASE_URL'];
  if (!key || !anthropicUrl) throw new Error('the .env needs DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL');
  // Alibaba documents the OpenAI-compatible endpoint on the same workspace host, under /compatible-mode/v1.
  const openaiUrl = `${new URL(anthropicUrl).origin}/compatible-mode/v1`;

  const home = await mkdtemp(path.join(tmpdir(), 'gcode-providers-smoke-'));
  const base = { GCODE_HOME: home, GCODE_RG: rgCommand(), PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
  const anthropicEnv = { ...base, DASHSCOPE_API_KEY: key, DASHSCOPE_BASE_URL: anthropicUrl };
  const openaiEnv = { ...base, OPENAI_API_KEY: key, GCODE_OPENAI_BASE_URL: openaiUrl, GCODE_PROVIDER: 'openai', GCODE_MODEL: MODEL };
  const outputs: Record<string, string> = {};
  let spent = 0;
  let ok = true;

  const report = (name: string, result: { code: number; stdout: string; stderr: string }) => {
    outputs[name] = result.stdout + result.stderr;
    const parsed = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as { ok: boolean; usage?: TokenUsage; latencyMs?: number; reply?: string; models?: string[]; error?: string };
    const cost = parsed.usage === undefined ? 0 : priced(parsed.usage);
    spent += cost;
    ok &&= parsed.ok;
    const detail = parsed.models !== undefined ? `${parsed.models.length} models, ${MODEL} ${parsed.models.includes(MODEL) ? 'listed' : 'not listed'}` : parsed.ok ? `${parsed.latencyMs}ms, reply "${parsed.reply}"` : parsed.error;
    console.log(`${name}: ${parsed.ok ? 'ok' : 'FAILED'}: ${detail}${parsed.usage ? `, in=${parsed.usage.input} cache_read=${parsed.usage.cacheRead} out=${parsed.usage.output}, $${cost.toFixed(6)}` : ''}`);
  };

  report('anthropic adapter, providers test modelstudio', await runCli(['providers', 'test', 'modelstudio', '--model', MODEL, '--json'], anthropicEnv));
  report('openai adapter, providers models openai', await runCli(['providers', 'models', 'openai', '--json'], openaiEnv));
  report('openai adapter, providers test openai', await runCli(['providers', 'test', 'openai', '--model', MODEL, '--json'], openaiEnv));

  const workspace = await realpath(makeRepo('smoke', [{ message: 'start', files: { 'a.ts': 'export const answer = 42;\n' } }]));
  const agent = await runCli(
    ['agent', '--workspace', workspace, '--non-interactive', '--max-turns', '4', 'Read a.ts with the read tool, then reply with only the number it exports.'],
    openaiEnv,
  );
  outputs['agent'] = agent.stdout + agent.stderr;
  const id = /^session: (\S+)$/m.exec(agent.stdout)?.[1];
  if (id === undefined) {
    console.log(`openai adapter, agent with a tool call: FAILED: exit ${agent.code}`);
    ok = false;
  } else {
    const log = await readSessionLog(sessionFile(openStore(openaiEnv), asSessionId(id)));
    const turns = log.events.filter((e) => e.kind === 'assistant');
    const tools = log.events.filter((e) => e.kind === 'tool-result').map((e) => `${e.name}:${e.status}`);
    const usage = turns.map((t) => t.usage).reduce(addUsage, ZERO_USAGE);
    const answer = turns.at(-1)?.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').trim();
    const cost = priced(usage);
    spent += cost;
    const passed = agent.code === 0 && tools.includes('read:ok') && answer?.includes('42') === true;
    ok &&= passed;
    console.log(
      `openai adapter, agent with a tool call: ${passed ? 'ok' : 'FAILED'}: exit ${agent.code}, ${turns.length} turns, tools [${tools.join(', ')}], answer "${answer}", in=${usage.input} cache_read=${usage.cacheRead} out=${usage.output}, $${cost.toFixed(6)}`,
    );
  }

  const leaks = leaksOf([key], { dirs: [home, workspace], texts: outputs });
  console.log(`key in any file or output: ${leaks.length === 0 ? 'none' : leaks.join('; ')}`);
  console.log(`total spent: $${spent.toFixed(6)}`);
  return ok && leaks.length === 0 ? 0 : 1;
}

process.exitCode = await main();
