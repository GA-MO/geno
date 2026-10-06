// Run from the repository root: pnpm tsx packages/engine/test/compact-smoke.ts
// GCODE_ENV_FILE names the .env holding DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL; it defaults to the repo's.
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { COMPACT_META, spendOf, type CompactMark, type TurnEvent } from '@g-code/core';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { openStore } from '../src/store.js';
import { rgCommand } from './helpers.js';

const MODEL = 'qwen3.8-flash';
const BUDGET_USD = 0.1;
// The system prompt and tools are about 3,900 tokens and the notes about 7,000, so the second turn passes this, and a
// compaction of the notes' read brings the context back under it.
const COMPACT_AT = '9000';
const DEADLINES = ['2026-11-03', '2026-11-17', '2026-12-01'];

const filler = (topic: string, lines: number): string =>
  Array.from({ length: lines }, (_, i) => `- ${topic} note ${i + 1}: the team reviewed item ${i + 1} and agreed to keep its current wording and owner.`).join('\n');

async function main(): Promise<number> {
  const root = path.resolve(import.meta.dirname, '../../..');
  const dotenv = parseEnv(await readFile(process.env['GCODE_ENV_FILE'] || path.join(root, '.env'), 'utf8'));
  const key = dotenv['DASHSCOPE_API_KEY'];
  const baseUrl = dotenv['DASHSCOPE_BASE_URL'];
  if (!key || !baseUrl) throw new Error('the .env needs DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL');

  const work = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-compact-smoke-')));
  const workspace = path.join(work, 'workspace');
  const home = path.join(work, 'home');
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(workspace, 'notes.md'),
    [
      '# Release notes',
      filler('Planning', 120),
      `The three deadlines: the beta ships on ${DEADLINES[0]}, the docs freeze on ${DEADLINES[1]}, and 1.0 ships on ${DEADLINES[2]}.`,
      filler('Review', 120),
    ].join('\n'),
  );
  await writeFile(path.join(workspace, 'config.md'), '# Config\nThe dev server listens on port 4317.\n');
  const env = {
    GCODE_HOME: home,
    GCODE_PROVIDER: 'modelstudio',
    GCODE_MODEL: MODEL,
    GCODE_COMPACT_AT: COMPACT_AT,
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
  let answer = '';
  const marks: CompactMark[] = [];
  const onUpdate = ({ params }: { params: acp.SessionNotification }) => {
    const { update } = params;
    const mark = update.sessionUpdate === 'agent_message_chunk' ? (update._meta?.[COMPACT_META] as CompactMark | undefined) : undefined;
    if (mark !== undefined) marks.push(mark);
    else if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') answer += update.content.text;
  };
  const connect = <T>(run: (ctx: acp.ClientContext) => Promise<T>): Promise<T> =>
    acp
      .client({ name: 'compact-smoke' })
      .onRequest(acp.methods.client.session.requestPermission, () => ({ outcome: { outcome: 'selected', optionId: 'reject' } }))
      .onNotification(acp.methods.client.session.update, onUpdate)
      .connectWith(gcodeAgent(io, openStore(env), { maxTurns: 8, maxCostUsd: BUDGET_USD }), async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
        return run(ctx);
      });
  const say = async (ctx: acp.ClientContext, sessionId: string, text: string): Promise<string> => {
    answer = '';
    const { stopReason } = await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] });
    console.log(`> ${text}\n  ${stopReason}: ${answer.trim().replace(/\s+/g, ' ').slice(0, 200)}`);
    return answer;
  };

  const sessionId = await connect(async (ctx) => {
    const { sessionId } = await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
    await say(ctx, sessionId, 'Read notes.md and list the three deadlines it gives, with their dates.');
    await say(ctx, sessionId, 'Now read config.md and tell me the dev server port, in one sentence.');
    await say(ctx, sessionId, '/compact keep the deadlines and the port');
    return sessionId;
  });
  const recalled = await connect(async (ctx) => {
    await ctx.request(acp.methods.agent.session.load, { sessionId, cwd: workspace, mcpServers: [] });
    return say(ctx, sessionId, 'Without reading any file again, what were the three deadlines from the notes, and the dev server port? Dates and the port only.');
  });

  const file = path.join(home, 'sessions', (await readdir(path.join(home, 'sessions'))).find((f) => f.startsWith(sessionId))!);
  const events = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as TurnEvent);
  const compactions = events.filter((e): e is Extract<TurnEvent, { kind: 'compact' }> => e.kind === 'compact');
  const cost = events.reduce((sum, e) => sum + (spendOf(e)?.costUsd ?? 0), 0);
  for (const c of compactions) {
    console.log(`compact #${c.seq} (${c.trigger}${c.focus === undefined ? '' : `, focus "${c.focus}"`}): kept from #${c.keptFrom}, ${c.tokensBefore} -> about ${c.tokensAfter} tokens, $${(c.costUsd ?? 0).toFixed(6)}`);
    console.log(c.summary.split('\n').map((line) => `  | ${line}`).join('\n'));
  }
  const calls = events.filter((e): e is Extract<TurnEvent, { kind: 'assistant' }> => e.kind === 'assistant');
  const contexts = calls.map((c) => c.usage.input + c.usage.cacheRead + c.usage.cacheWrite);
  console.log(`context per model call: ${contexts.join(', ')}`);
  const auto = compactions.find((c) => c.trigger === 'auto');
  const manual = compactions.find((c) => c.trigger === 'manual');
  const afterAuto = auto === undefined ? undefined : calls.find((c) => c.seq > auto.seq);
  const shrank = auto !== undefined && afterAuto !== undefined && afterAuto.usage.input + afterAuto.usage.cacheRead + afterAuto.usage.cacheWrite < auto.tokensBefore;
  const remembered = DEADLINES.every((date) => recalled.includes(date)) && recalled.includes('4317');
  const reread = manual !== undefined && events.some((e) => e.kind === 'assistant' && e.seq > manual.seq && e.content.some((b) => b.type === 'tool_use'));
  const shown = marks.map((m) => m.trigger).join(', ');
  for (const e of events) if (e.kind === 'assistant') console.log(`#${e.seq} assistant: ${e.content.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_use' ? `[${b.name} ${JSON.stringify(b.input)}]` : '')).join(' ').replace(/\s+/g, ' ').slice(0, 300)}`);
  console.log(`dividers the editor got: ${shown}`);
  console.log(`auto compacted: ${auto !== undefined}; the next call read less: ${shrank}; /compact logged: ${manual !== undefined}; recalled the deadlines and the port from the summary after a reload: ${remembered}; used a tool to recall: ${reread}`);
  console.log(`estimated cost: $${cost.toFixed(6)} (budget $${BUDGET_USD})`);
  const leaked = logs.some((line) => line.includes(key)) || events.some((e) => JSON.stringify(e).includes(key));
  const passed = auto !== undefined && shrank && manual !== undefined && remembered && !reread && cost < BUDGET_USD && !leaked;
  console.log(`smoke: ${passed ? 'passed' : 'failed'}`);
  return passed ? 0 : 1;
}

void main().then((code) => (process.exitCode = code));
