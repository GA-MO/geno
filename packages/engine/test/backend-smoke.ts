// The live smoke of U33: three short prompts to the user's real Cursor `agent acp`, through Geno's engine, in a lane of
// a throwaway git workspace. It spends the user's Cursor plan, so it runs only with GCODE_LIVE_CURSOR=1.
//   GCODE_LIVE_CURSOR=1 pnpm tsx packages/engine/test/backend-smoke.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { BACKEND_META, LANE_APPLY_META, TURN_USAGE_META } from '@g-code/core';
import type { Io } from '../src/command.js';
import { mcpSessions } from '../src/mcp/sessions.js';
import { engineShared, gcodeAgent } from '../src/serve.js';
import { openStore } from '../src/store.js';

if (process.env['GCODE_LIVE_CURSOR'] !== '1') {
  console.log('Set GCODE_LIVE_CURSOR=1 to spend three short prompts of your Cursor plan.');
  process.exit(0);
}

const PROMPTS = [
  'List the files in this folder. Do not change anything.',
  'Add the line `export const four = 4;` at the end of a.ts. Change nothing else.',
  'Run `ls -la` in a terminal and tell me only the first line of its output. Do not change anything.',
] as const;
// GCODE_LIVE_ONLY=2 sends prompt 2 alone, to confirm one behavior without spending the other two.
const only = Number(process.env['GCODE_LIVE_ONLY'] ?? 0);
const chosen = only >= 1 && only <= PROMPTS.length ? [PROMPTS[only - 1]!] : PROMPTS;

const redact = (text: string) => text.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>');
const say = (line: string) => console.log(redact(line));

// Real, so a path the engine resolved under /private/var reads relative to it, not across /var.
const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'u33-smoke-')));
const repo = path.join(root, 'work');
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
writeFileSync(path.join(repo, 'a.ts'), 'export const one = 1;\nexport const two = 2;\nexport const three = 3;\n');
writeFileSync(path.join(repo, 'README.md'), '# Smoke\n');
const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=smoke', '-c', 'user.email=smoke@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
git('add', '-A');
git('commit', '-qm', 'start');
say(`workspace: ${repo}`);

const home = process.env['HOME']!;
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
  GCODE_HOME: path.join(root, 'gcode-home'),
  HOME: home,
  PATH: `${process.env['PATH'] ?? '/usr/bin:/bin'}:${path.join(home, '.local/bin')}`,
  // No Geno model is called: the classifier is not needed in Ask mode, and nothing here runs Geno's loop.
  GCODE_CLASSIFIER_MODEL: 'off',
};
const errs: string[] = [];
const io: Io = { env, cwd: repo, out: () => {}, err: (line) => errs.push(line), write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false };
const store = openStore(env);
const shared = engineShared(io);
const updates: acp.SessionUpdate[] = [];
const permissions: string[] = [];
const writes: string[] = [];
const window = acp
  .client({ name: 'u33-smoke' })
  .onRequest(acp.methods.client.fs.readTextFile, ({ params }) => ({ content: readFileSync(params.path, 'utf8') }))
  .onRequest(acp.methods.client.fs.writeTextFile, ({ params }) => {
    writes.push(params.path);
    writeFileSync(params.path, params.content);
    return {};
  })
  .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
    const once = params.options.find((o) => o.kind === 'allow_once');
    permissions.push(`${params.toolCall.title} [${params.options.map((o) => o.kind).join(', ')}] -> ${once?.optionId ?? 'reject'}`);
    return { outcome: { outcome: 'selected', optionId: once?.optionId ?? 'reject' } };
  })
  .onNotification(acp.methods.client.session.update, ({ params }) => void updates.push(params.update));
const connection = window.connect(gcodeAgent(io, store, { maxTurns: 10, maxCostUsd: 0.01 }, mcpSessions(store, env), shared));
const agent = connection.agent;
await agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
const started = await agent.request(acp.methods.agent.session.new, { cwd: repo, mcpServers: [], _meta: { [BACKEND_META]: { id: 'cursor' } } });
const models = started.configOptions?.[0];
say(`session ${started.sessionId}, backend ${JSON.stringify(started._meta?.[BACKEND_META])}`);
say(`models: ${models?.type === 'select' ? `${models.options.length} offered, current ${String(models.currentValue)}` : 'none'}`);

let spent = 0;
for (const text of chosen) {
  if (++spent > 3) throw new Error('the smoke sends at most three prompts');
  const from = updates.length;
  const t0 = Date.now();
  const response = await agent.request(acp.methods.agent.session.prompt, { sessionId: started.sessionId, prompt: [{ type: 'text', text }] });
  say(`\n## prompt ${spent}: ${text}`);
  say(`stop: ${response.stopReason} in ${((Date.now() - t0) / 1000).toFixed(1)}s, usage meta ${JSON.stringify(response._meta?.[TURN_USAGE_META])}`);
  for (const update of updates.slice(from)) {
    if (update.sessionUpdate === 'tool_call') say(`  step: ${update.title} (${update.kind})`);
    if (update.sessionUpdate === 'tool_call_update' && update.status != null) say(`  end: ${update.toolCallId} ${update.status}`);
  }
  const answer = updates
    .slice(from)
    .flatMap((u) => (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' ? [u.content.text] : []))
    .join('');
  say(`  answer: ${answer.trim().slice(0, 600)}`);
}

const lane = (await import('../src/sessions.js')).readSessionLog;
const log = await lane(path.join(store.sessionsDir, `${started.sessionId}.jsonl`));
const laneName = log.events.findLast((e) => e.kind === 'backend-start')?.lane;
say(`\nlane: ${laneName}, backend-start: ${JSON.stringify(log.events.filter((e) => e.kind === 'backend-start'))}`);
if (laneName != null) {
  const applied = await agent.request(acp.methods.agent.session.prompt, { sessionId: started.sessionId, prompt: [{ type: 'text', text: `Apply lane ${laneName}` }], _meta: { [LANE_APPLY_META]: laneName } });
  say(`apply: ${applied.stopReason}, wrote ${writes.map((w) => path.relative(repo, w)).join(', ') || 'nothing'}`);
  say(`main a.ts now:\n${readFileSync(path.join(repo, 'a.ts'), 'utf8')}`);
}
say(`\npermissions asked: ${permissions.length === 0 ? 'none' : `\n  ${permissions.join('\n  ')}`}`);
say(`engine lines about the backend:\n  ${errs.filter((l) => l.startsWith('backend') || l.startsWith('lane')).join('\n  ')}`);
shared.externals.closeAll();
connection.close();
process.exit(0);
