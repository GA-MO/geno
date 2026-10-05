// Run from the repository root: pnpm tsx packages/engine/test/widget-smoke.ts
// GCODE_ENV_FILE names the .env holding DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL; it defaults to the repo's.
// Two of U37's probe prompts go through the real show_widget tool on Model Studio, under $0.03.
import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { parseShowWidget, WIDGET_CAPABILITY, WIDGET_META, WIDGET_PALETTE, type WidgetRef } from '@g-code/core';
import type { Io } from '../src/command.js';
import { gcodeAgent } from '../src/serve.js';
import { attachmentsDir } from '../src/attachments.js';
import { sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { rgCommand } from './helpers.js';

const MODEL = 'qwen3.8-flash';
const BUDGET_USD = 0.03;

/** Two of the probe's five tasks (docs/plan-u19-on.md, U37 probe). */
const TASKS: readonly { readonly id: string; readonly prompt: string }[] = [
  {
    id: 'speed-chart',
    prompt:
      'Draw a widget: a horizontal stacked bar and a small table showing where an AI agent spends its time per run: first token 72.9s, thinking 206.5s, decode 143.2s, tools 135.1s, overhead 6.8s. Hovering a segment shows its seconds and percent.',
  },
  {
    id: 'debounce',
    prompt:
      'Draw a widget: an interactive explainer of debounce versus throttle. A box the user moves the mouse over, with three live timelines (raw events, debounced at 300ms, throttled at 300ms) drawing ticks as events fire.',
  },
];

type Shown = { readonly ref: WidgetRef; readonly html: string };

async function main(): Promise<number> {
  const repo = path.resolve(import.meta.dirname, '../../..');
  const dotenv = parseEnv(await readFile(process.env['GCODE_ENV_FILE'] || path.join(repo, '.env'), 'utf8'));
  const key = dotenv['DASHSCOPE_API_KEY'];
  const baseUrl = dotenv['DASHSCOPE_BASE_URL'];
  if (!key || !baseUrl) throw new Error('the .env needs DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL');

  const work = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-widget-smoke-')));
  const workspace = path.join(work, 'workspace');
  const home = path.join(work, 'home');
  await mkdir(workspace, { recursive: true });
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

  const refs = new Map<string, WidgetRef>();
  const sessions: string[] = [];
  const client = acp.client({ name: 'widget-smoke' }).onNotification(acp.methods.client.session.update, ({ params }) => {
    const { update } = params;
    if (update.sessionUpdate === 'tool_call_update' && update._meta?.[WIDGET_META] !== undefined) refs.set(update.toolCallId, update._meta[WIDGET_META] as WidgetRef);
  });

  const store = openStore(env);
  // A fresh session per prompt keeps each widget's context small, so the model draws it once, as the probe measured.
  await client.connectWith(gcodeAgent(io, store, { maxTurns: 2, maxCostUsd: BUDGET_USD / TASKS.length }), async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { _meta: { [WIDGET_CAPABILITY]: true } } });
    for (const task of TASKS) {
      const sessionId = (await ctx.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] })).sessionId;
      sessions.push(sessionId);
      await ctx.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text: task.prompt }] });
    }
  });

  const shown: Shown[] = [];
  const assistants: { usage?: { input: number; cacheRead: number; cacheWrite: number; output: number }; costUsd?: number | null }[] = [];
  for (const sessionId of sessions) {
    const dir = attachmentsDir(store, sessionId as acp.SessionId);
    for (const ref of refs.values()) {
      const file = path.join(dir, `${ref.sha256}.html`);
      const html = await readFile(file, 'utf8').catch(() => undefined);
      if (html !== undefined && !shown.some((w) => w.ref.sha256 === ref.sha256)) shown.push({ ref, html });
    }
    const events = (await readFile(sessionFile(store, sessionId as acp.SessionId), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assistants.push(...events.filter((e) => e.kind === 'assistant'));
  }
  const cost = assistants.reduce((sum, e) => sum + (e.costUsd ?? 0), 0);
  const tokensIn = assistants.reduce((sum, e) => sum + (e.usage?.input ?? 0) + (e.usage?.cacheRead ?? 0) + (e.usage?.cacheWrite ?? 0), 0);
  const tokensOut = assistants.reduce((sum, e) => sum + (e.usage?.output ?? 0), 0);

  // What the probe weak spots were: a fixed width and off-palette colors. Check each widget fills its width and
  // draws with the given variables only, and parses as a valid show_widget input.
  const checks = shown.map(({ ref, html }) => {
    const parsed = parseShowWidget({ title: ref.title, html });
    // The probe's weak spot was a fixed 680px container. Flag only a container-scale fixed width, not a 10px swatch.
    const wide = [...html.replace(/max-width\s*:\s*\d+px/gi, '').matchAll(/[^-]width\s*:\s*(\d+)px/gi)].some((m) => Number(m[1]) >= 300);
    const usesVars = /var\(--/.test(html);
    const hexLiteral = /(?:color|background|fill|stroke)[^;{]*:[^;{]*#[0-9a-f]{3,6}\b/i.test(html);
    return { id: ref.title, ok: parsed.ok, bytes: ref.bytes, fillsWidth: !wide, usesVars, hexLiteral };
  });

  // Model Studio does not price qwen3.8-flash in the cost table, so fall back to the probe's per-token estimate.
  const estimate = cost > 0 ? cost : (tokensIn * 0.15 + tokensOut * 0.47) / 1e6;

  for (const c of checks) console.log(`widget "${c.id}": ${c.bytes} bytes, valid=${c.ok}, fills width=${c.fillsWidth}, uses theme vars=${c.usesVars}, color literals=${c.hexLiteral}`);
  console.log(`widgets drawn: ${shown.length} for ${TASKS.length} prompts`);
  console.log(`tokens: ${tokensIn} in, ${tokensOut} out; estimated cost: $${estimate.toFixed(6)} (budget $${BUDGET_USD})`);
  const leaked = logs.some((line) => line.includes(key)) || shown.some((s) => s.html.includes(key));
  const passed = shown.length >= TASKS.length && checks.every((c) => c.ok && c.fillsWidth && c.usesVars) && estimate < BUDGET_USD && !leaked;
  console.log(`smoke: ${passed ? 'passed' : 'failed'}`);
  if (process.env['WIDGET_SMOKE_OUT'] !== undefined) {
    const { writeFile: write } = await import('node:fs/promises');
    for (const { ref, html } of shown) await write(path.join(process.env['WIDGET_SMOKE_OUT'], `${ref.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.html`), html);
  }
  return passed ? 0 : 1;
}

void main().then((code) => (process.exitCode = code));
