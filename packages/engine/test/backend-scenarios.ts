// Ten live scenarios of the Cursor backend, each in a throwaway git repo, through Geno's engine, in a lane, inside
// Geno's sandbox. Live, it spends the user's Cursor plan (at most 14 prompts) and a few cents of Model Studio
// qwen3.8-flash for scenarios 5, 9 and 10, whose key comes from GCODE_ENV_FILE or the repository's .env.
//   GCODE_LIVE_CURSOR=1 pnpm tsx packages/engine/test/backend-scenarios.ts
//   GCODE_LIVE_CURSOR=1 GCODE_SCENARIOS=1,3,5 pnpm tsx packages/engine/test/backend-scenarios.ts
//   GCODE_LIVE_CURSOR=1 GCODE_FAKE_CURSOR=1 pnpm tsx packages/engine/test/backend-scenarios.ts   (fake agent, free)
import childProcess, { execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import {
  APPROVAL_META,
  ARENA_NEW_METHOD,
  ARENA_PICK_METHOD,
  ARENA_UPDATE_METHOD,
  BACKEND_META,
  CLASSIFIER_TOOL,
  LANE_APPLY_META,
  TASKS_CAPABILITY,
  TURN_USAGE_META,
  type ApprovalRecord,
  type ArenaNewResponse,
  type ArenaRun,
  type ArenaUpdate,
  type TurnEvent,
} from '@g-code/core';
import type { Io } from '../src/command.js';
import { mcpSessions } from '../src/mcp/sessions.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { engineShared, gcodeAgent } from '../src/serve.js';
import { openStore } from '../src/store.js';
import { CURSOR_SETUP, type FakeScript, type FakeStep } from './fake-acp-agent.js';
import { answer, fakeTransport, toolCall, type Reply } from './fake-transport.js';

if (process.env['GCODE_LIVE_CURSOR'] !== '1') {
  console.log('Set GCODE_LIVE_CURSOR=1 to run the Cursor scenarios (add GCODE_FAKE_CURSOR=1 to run them on the fake agent for free).');
  process.exit(0);
}
const FAKE = process.env['GCODE_FAKE_CURSOR'] === '1';
const HARD_CAP = 14;
// A lower cap only, to see the gate refuse without spending the whole run.
const CAP = Math.min(HARD_CAP, Number(process.env['GCODE_CURSOR_PROMPT_CAP'] ?? HARD_CAP) || HARD_CAP);

const A_TS = 'export const one = 1;\nexport const two = 2;\nexport const three = 3;\n';
const BASE_FILES = { 'a.ts': A_TS, 'README.md': '# Scenarios\n', 'notes.txt': 'keep me\n' };
const SLEEP = '173';

const PROMPTS = {
  edit: 'Add the line `export const four = 4;` at the end of a.ts. Change nothing else.',
  ls: 'Run `ls` in a terminal and tell me the file names it prints. Do not change anything.',
  rm: 'Run `rm notes.txt` in a terminal. Do nothing else.',
  plan: 'Add the line `export const five = 5;` at the end of a.ts. Change nothing else.',
  auto: 'Run `git status` in a terminal, then run `cp README.md README.copy.md` in a terminal. Tell me the branch name.',
  cancel: `Run \`sleep ${SLEEP} && echo slept\` in a terminal, then read every file in this folder and summarise each one in a paragraph.`,
  oneWord: 'Reply with one word only: ready.',
  remember: 'Create a file named reload-marker.txt containing the single word pelican. Change nothing else.',
  recall: 'What file did you create earlier in this conversation, and what word is in it? Answer from memory, without reading or listing any files.',
  subagent: '@cursor list the files in this folder. Do not change anything.',
  arena: 'Add the line `export const six = 6;` at the end of a.ts. Change nothing else.',
} as const;

/** The fake agent's turns, keyed by a phrase of each prompt; the first key a prompt contains wins. */
const FAKE_TURNS: Record<string, readonly FakeStep[]> = {
  'export const four': [
    { tool: { id: 'e1', kind: 'edit', title: 'Edit a.ts', locations: ['a.ts'] } },
    { write: { path: 'a.ts', text: `${A_TS}export const four = 4;\n` } },
    { done: { id: 'e1', status: 'completed' } },
    { text: 'Added the line at the end of a.ts.' },
  ],
  '`ls`': [
    { tool: { id: 'l1', kind: 'execute', title: '`ls`', rawInput: { command: 'ls' } } },
    { ask: { id: 'l1' } },
    { done: { id: 'l1', status: 'completed', output: 'README.md\na.ts\nnotes.txt\n' } },
    { text: 'README.md, a.ts, notes.txt' },
  ],
  'rm notes.txt': [
    { tool: { id: 'x1', kind: 'execute', title: '`rm notes.txt`', rawInput: { command: 'rm notes.txt' } } },
    { ask: { id: 'x1' } },
    { text: 'The command was rejected, so notes.txt is still there.' },
  ],
  'export const five': [
    { tool: { id: 'p1', kind: 'edit', title: 'Edit a.ts', locations: ['a.ts'] } },
    { ask: { id: 'p1', kind: 'edit', title: 'Edit a.ts' } },
    { text: 'The edit was refused in plan mode.' },
  ],
  'git status': [
    { tool: { id: 'g1', kind: 'execute', title: '`git status`', rawInput: { command: 'git status' } } },
    { ask: { id: 'g1' } },
    { done: { id: 'g1', status: 'completed', output: 'On branch lane\nnothing to commit\n' } },
    { tool: { id: 'c1', kind: 'execute', title: '`cp README.md README.copy.md`', rawInput: { command: 'cp README.md README.copy.md' } } },
    { ask: { id: 'c1' } },
    { write: { path: 'README.copy.md', text: '# Scenarios\n' } },
    { done: { id: 'c1', status: 'completed' } },
    { text: 'The branch is lane.' },
  ],
  [`sleep ${SLEEP}`]: [
    { tool: { id: 's1', kind: 'execute', title: `\`sleep ${SLEEP} && echo slept\``, rawInput: { command: `sleep ${SLEEP} && echo slept` } } },
    { ask: { id: 's1' } },
    { run: ['sleep', SLEEP] },
    { waitCancel: true },
    { text: 'never' },
  ],
  'one word': [{ text: 'ready' }],
  pelican: [
    { tool: { id: 'm1', kind: 'edit', title: 'Edit reload-marker.txt', locations: ['reload-marker.txt'] } },
    { write: { path: 'reload-marker.txt', text: 'pelican\n' } },
    { done: { id: 'm1', status: 'completed' } },
    { text: 'Created reload-marker.txt.' },
  ],
  'earlier in this conversation': [{ text: 'You created reload-marker.txt, and it holds the word pelican.' }],
  'list the files': [
    { tool: { id: 'f1', kind: 'execute', title: '`ls`', rawInput: { command: 'ls' } } },
    { ask: { id: 'f1' } },
    { done: { id: 'f1', status: 'completed', output: 'README.md\na.ts\nnotes.txt\n' } },
    { text: 'The folder holds README.md, a.ts and notes.txt.' },
  ],
  'export const six': [{ write: { path: 'a.ts', text: `${A_TS}export const six = 6;\n` } }, { text: 'Added six.' }],
};

const FAKE_MODELS: acp.SessionConfigOption = {
  id: 'model',
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: 'default[]',
  options: [
    { value: 'default[]', name: 'Auto' },
    { value: 'claude-4.8-opus-high', name: 'Opus 4.8 High' },
    { value: 'composer-2.5[fast=true]', name: 'composer-2.5' },
    { value: 'gemini-3-flash', name: 'Gemini 3 Flash' },
  ],
};
const FAKE_SETUP: FakeScript['setup'] = { ...CURSOR_SETUP, configOptions: [CURSOR_SETUP.configOptions![0]!, FAKE_MODELS] };

const usage = { input: 10, cacheRead: 0, cacheWrite: 0 };
const classifierAllow = toolCall('', [{ id: 'cv', name: CLASSIFIER_TOOL.name, input: { reason: 'a copy inside the lane', verdict: 'allow' } }], usage);
const ranking = answer(['```json', '{"ranking": [{"lane": "B", "reason": "Cursor added the line."}, {"lane": "A", "reason": "Fine too."}], "summary": "B."}', '```'].join('\n'), usage);

const secrets: string[] = [];
const redact = (text: string) => secrets.reduce((t, s) => t.replaceAll(s, '<key>'), text.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>'));
const say = (line: string) => console.log(redact(line));
const clip = (text: string, n = 160) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n)}...` : flat;
};

const geno = (() => {
  if (FAKE) return { DASHSCOPE_API_KEY: 'sk-fake', DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic' };
  const file = process.env['GCODE_ENV_FILE'] || path.resolve(import.meta.dirname, '../../../.env');
  const dotenv = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
  const key = dotenv['DASHSCOPE_API_KEY'];
  const baseUrl = dotenv['DASHSCOPE_BASE_URL'];
  if (!key || !baseUrl) return undefined;
  secrets.push(key);
  return { DASHSCOPE_API_KEY: key, DASHSCOPE_BASE_URL: baseUrl };
})();

// The cap is counted where every Cursor prompt passes, the agent's stdin, so the @cursor child and the Arena lane
// count too. backends.ts imports `spawn` by name; syncBuiltinESMExports carries the wrapper into that binding.
let promptsUsed = 0;
let refusedOverCap = 0;
const agentChildren = new Set<ChildProcess>();
const realSpawn = childProcess.spawn;
childProcess.spawn = ((...params: Parameters<typeof realSpawn>) => {
  const child = Reflect.apply(realSpawn, childProcess, params) as ChildProcess;
  const argv = [params[0], ...(Array.isArray(params[1]) ? params[1] : [])].map(String);
  if (!argv.some((a) => /sandbox-host\.(ts|js)$/.test(a) || /(^|\/)(cursor-)?agent$/.test(a)) || child.stdin === null) return child;
  agentChildren.add(child);
  child.on('exit', () => agentChildren.delete(child));
  const real = child.stdin;
  const gate = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      const prompts = (String(chunk).match(/"method":"session\/prompt"/g) ?? []).length;
      if (prompts > 0 && promptsUsed + prompts > CAP) {
        refusedOverCap += prompts;
        child.kill('SIGTERM');
        done();
        return;
      }
      promptsUsed += prompts;
      real.write(chunk, (error) => done(error ?? undefined));
    },
    final(done) {
      real.end(() => done());
    },
  });
  real.on('error', (error) => gate.destroy(error));
  // Node closes a child's stdin when it exits, which is what ends an agent left under a killed sandbox host; with
  // the gate in its place, that close would reach only the gate.
  child.on('exit', () => real.destroy());
  (child as { stdin: Writable }).stdin = gate;
  return child;
}) as typeof realSpawn;
syncBuiltinESMExports();

// The agent runs as a grandchild, under the sandbox host, so a leak shows only in the process tree.
const agentPids = new Set<number>();
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
function sampleAgents(): void {
  const children = new Map<number, number[]>();
  for (const line of execFileSync('ps', ['-ax', '-o', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number) as [number, number];
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const queue = [...agentChildren].flatMap((c) => (c.pid === undefined || c.exitCode !== null || c.signalCode !== null ? [] : [c.pid]));
  for (let pid = queue.pop(); pid !== undefined; pid = queue.pop()) {
    agentPids.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }
}
setInterval(sampleAgents, 250).unref();

type Check = { readonly what: string; readonly ok: boolean; readonly seen: string };
const check = (what: string, ok: boolean, seen: unknown = ''): Check => ({ what, ok, seen: typeof seen === 'string' ? seen : JSON.stringify(seen) });

class Timeout extends Error {}
const bounded = <T>(work: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Timeout(`${what}: no answer within ${Math.round(ms / 1000)}s`)), ms).unref())]);
async function until(ready: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > end) throw new Timeout(`${what}: not within ${Math.round(ms / 1000)}s`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const sleepPids = (): string[] =>
  execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => new RegExp(`\\bsleep ${SLEEP}\\b`).test(line))
    .map((line) => line.trim().split(/\s+/)[0]!);

type Answer = 'allow' | 'reject';
type Asked = { readonly sessionId: string; readonly title: string; readonly kinds: readonly string[]; readonly answered: string };

function world(n: number, files: Record<string, string>, replies: readonly Reply[]) {
  const root = mkdtempSync(path.join(tmpdir(), `cursor-scenario-${n}-`));
  const repo = path.join(execFileSync('realpath', [root], { encoding: 'utf8' }).trim(), 'work');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  for (const [name, text] of Object.entries({ ...BASE_FILES, ...files })) writeFileSync(path.join(repo, name), text);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=scenario', '-c', 'user.email=scenario@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  git('add', '-A');
  git('commit', '-qm', 'start');

  const home = FAKE ? path.join(path.dirname(repo), 'home') : process.env['HOME']!;
  let pathVar = `${process.env['PATH'] ?? '/usr/bin:/bin'}:${path.join(home, '.local/bin')}`;
  const calls = path.join(home, '.cursor/agents/calls.jsonl');
  if (FAKE) {
    const bin = path.join(path.dirname(repo), 'bin');
    mkdirSync(path.join(home, '.cursor/agents'), { recursive: true });
    mkdirSync(bin);
    const script: FakeScript = { log: calls, loadSession: true, setup: FAKE_SETUP, turns: FAKE_TURNS };
    writeFileSync(path.join(home, 'script.json'), JSON.stringify(script));
    const fixture = fileURLToPath(new URL('./fake-acp-agent.ts', import.meta.url));
    writeFileSync(path.join(bin, 'agent'), `#!/bin/sh\nFAKE_ACP_SCRIPT='${path.join(home, 'script.json')}' exec '${process.execPath}' --import '${import.meta.resolve('tsx')}' '${fixture}' "$@"\n`);
    chmodSync(path.join(bin, 'agent'), 0o755);
    pathVar = `${bin}:/usr/bin:/bin`;
  }
  const transport = fakeTransport([...replies]);
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('GCODE_'))),
    GCODE_HOME: path.join(path.dirname(repo), 'gcode-home'),
    HOME: home,
    PATH: pathVar,
    GCODE_PROVIDER: 'modelstudio',
    GCODE_MODEL: 'qwen3.8-flash',
    ...(geno ?? { GCODE_CLASSIFIER_MODEL: 'off' }),
  };
  const errs: string[] = [];
  const io: Io = { env, cwd: repo, out: () => {}, err: (line) => errs.push(line), write: () => {}, interrupts: () => new AbortController().signal, confirm: async () => false, fetch: FAKE ? transport.fetch : globalThis.fetch };
  const updates: acp.SessionNotification[] = [];
  const asked: Asked[] = [];
  const arenas: ArenaUpdate[] = [];
  let policy: Answer = 'allow';
  const window = acp
    .client({ name: `cursor-scenario-${n}` })
    .onRequest(acp.methods.client.fs.readTextFile, ({ params }) => ({ content: readFileSync(params.path, 'utf8') }))
    .onRequest(acp.methods.client.fs.writeTextFile, ({ params }) => {
      writeFileSync(params.path, params.content);
      return {};
    })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      const option = params.options.find((o) => o.kind === (policy === 'allow' ? 'allow_once' : 'reject_once'));
      asked.push({ sessionId: params.sessionId, title: params.toolCall.title ?? '', kinds: params.options.map((o) => o.kind), answered: option?.kind ?? 'cancelled' });
      return option === undefined ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'selected', optionId: option.optionId } };
    })
    .onNotification(acp.methods.client.session.update, ({ params }) => void updates.push(params))
    .onNotification(ARENA_UPDATE_METHOD, (raw) => raw as ArenaUpdate, ({ params }) => void arenas.push(params));

  const engines: { close(): void }[] = [];
  /** A fresh engine on the same store, as a restarted editor gets. */
  const open = async () => {
    const store = openStore(env);
    const shared = engineShared(io);
    const connection = window.connect(gcodeAgent(io, store, { maxTurns: 10, maxCostUsd: 0.05 }, mcpSessions(store, env), shared));
    const close = () => {
      shared.externals.closeAll();
      connection.close();
    };
    engines.push({ close });
    await bounded(
      connection.agent.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, _meta: { [TASKS_CAPABILITY]: true } } }),
      30_000,
      'initialize',
    );
    return { agent: connection.agent, store, close };
  };
  const shown = (sessionId: string) => updates.filter((u) => u.sessionId === sessionId).map((u) => u.update);
  const textOf = (sessionId: string, from = 0) =>
    shown(sessionId)
      .slice(from)
      .flatMap((u) => (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text' ? [u.content.text] : []))
      .join('');
  const approvals = (sessionId: string): ApprovalRecord[] =>
    shown(sessionId).flatMap((u) => (u.sessionUpdate === 'tool_call_update' && u._meta?.[APPROVAL_META] != null ? [u._meta[APPROVAL_META] as ApprovalRecord] : []));
  const events = async (store: ReturnType<typeof openStore>, sessionId: string): Promise<readonly TurnEvent[]> => (await readSessionLog(sessionFile(store, sessionId as never))).events;
  const laneOf = (log: readonly TurnEvent[]) => {
    const start = log.findLast((e) => e.kind === 'backend-start');
    return start?.kind === 'backend-start' && start.lane != null ? { name: start.lane, dir: path.join(repo, '.geno/worktrees', start.lane) } : undefined;
  };
  const agentCalls = (): Record<string, any>[] => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
  const newCursorChat = async (agent: acp.ClientContext) => {
    const started = await bounded(agent.request(acp.methods.agent.session.new, { cwd: repo, mcpServers: [], _meta: { [BACKEND_META]: { id: 'cursor' } } }), 120_000, 'session/new on Cursor');
    return started;
  };
  const prompt = (agent: acp.ClientContext, sessionId: string, text: string, ms: number, meta?: Record<string, unknown>) =>
    bounded(agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }], ...(meta === undefined ? {} : { _meta: meta }) }), ms, `prompt "${clip(text, 40)}"`);
  const close = () => {
    for (const engine of engines) engine.close();
  };
  return {
    repo,
    errs,
    transport,
    asked,
    arenas,
    allow: () => void (policy = 'allow'),
    reject: () => void (policy = 'reject'),
    open,
    shown,
    textOf,
    approvals,
    events,
    laneOf,
    agentCalls,
    newCursorChat,
    prompt,
    close,
  };
}
type World = ReturnType<typeof world>;

type Scenario = {
  readonly n: number;
  readonly name: string;
  /** Cursor prompts it sends, so a run that would pass the cap skips it before spending anything. */
  readonly cursorPrompts: number;
  readonly needsGeno: boolean;
  readonly limitS: number;
  readonly files?: Record<string, string>;
  readonly replies?: readonly Reply[];
  run(w: World, ms: (live: number) => number): Promise<Check[]>;
};

const turnMs = (live: number) => (FAKE ? 30_000 : live * 1000);

const SCENARIOS: readonly Scenario[] = [
  {
    n: 1,
    name: 'Edit then Apply',
    cursorPrompts: 1,
    needsGeno: false,
    limitS: 300,
    async run(w, ms) {
      const { agent, store } = await w.open();
      const { sessionId } = await w.newCursorChat(agent);
      const done = await w.prompt(agent, sessionId, PROMPTS.edit, ms(180));
      const lane = w.laneOf(await w.events(store, sessionId));
      const laneBytes = lane === undefined ? undefined : readFileSync(path.join(lane.dir, 'a.ts'));
      const mainBefore = readFileSync(path.join(w.repo, 'a.ts'));
      const applied = lane === undefined ? undefined : await w.prompt(agent, sessionId, `Apply lane ${lane.name}`, ms(60), { [LANE_APPLY_META]: lane.name });
      const mainAfter = readFileSync(path.join(w.repo, 'a.ts'));
      return [
        check('turn ended', done.stopReason === 'end_turn', done.stopReason),
        check('the lane holds the new line', laneBytes?.toString('utf8').includes('export const four = 4;') === true, laneBytes?.toString('utf8') ?? 'no lane'),
        check('main is unchanged before Apply', mainBefore.toString('utf8') === A_TS),
        check('Apply ended', applied?.stopReason === 'end_turn', applied?.stopReason ?? 'not run'),
        check('main equals the lane byte for byte after Apply', laneBytes !== undefined && mainAfter.equals(laneBytes), `${mainAfter.length} bytes in main, ${laneBytes?.length ?? 0} in the lane`),
      ];
    },
  },
  {
    n: 2,
    name: 'Command allowed',
    cursorPrompts: 1,
    needsGeno: false,
    limitS: 240,
    async run(w, ms) {
      const { agent } = await w.open();
      const { sessionId } = await w.newCursorChat(agent);
      w.allow();
      const done = await w.prompt(agent, sessionId, PROMPTS.ls, ms(180));
      const said = w.textOf(sessionId);
      const ls = w.asked.filter((a) => /\bls\b/.test(a.title));
      const record = w.approvals(sessionId).find((r) => /\bls\b/.test(r.command));
      return [
        check('turn ended', done.stopReason === 'end_turn', done.stopReason),
        check('Cursor asked before ls, with allow_once offered', ls.some((a) => a.kinds.includes('allow_once')), w.asked),
        check('the client answered allow_once', ls.some((a) => a.answered === 'allow_once')),
        check('Geno recorded the user allowing it', record?.decidedBy === 'user' && record.verdict === 'allow', record ?? 'no record'),
        check('the answer names the files', said.includes('a.ts') && said.includes('notes.txt'), clip(said)),
      ];
    },
  },
  {
    n: 3,
    name: 'Command rejected',
    cursorPrompts: 1,
    needsGeno: false,
    limitS: 240,
    async run(w, ms) {
      const { agent, store } = await w.open();
      const { sessionId } = await w.newCursorChat(agent);
      w.reject();
      const done = await w.prompt(agent, sessionId, PROMPTS.rm, ms(180));
      const lane = w.laneOf(await w.events(store, sessionId));
      const said = w.textOf(sessionId);
      const record = w.approvals(sessionId).find((r) => /\brm\b/.test(r.command));
      return [
        check('turn ended', done.stopReason === 'end_turn', done.stopReason),
        check('Cursor asked before rm and the client rejected', w.asked.some((a) => /\brm\b/.test(a.title) && a.answered === 'reject_once'), w.asked),
        check('notes.txt still exists in the lane', lane !== undefined && existsSync(path.join(lane.dir, 'notes.txt')), lane?.name ?? 'no lane'),
        check('notes.txt still exists in main', existsSync(path.join(w.repo, 'notes.txt'))),
        check('the turn shows the refusal on the call', record?.decidedBy === 'user' && record.verdict === 'deny', record ?? 'no record'),
        check('the answer mentions the refusal', /reject|refus|denied|declin|not (?:been )?(?:run|allowed|permitted|removed|deleted)|permission|still there/i.test(said), clip(said)),
      ];
    },
  },
  {
    n: 4,
    name: 'Plan mode',
    cursorPrompts: 1,
    needsGeno: false,
    limitS: 240,
    async run(w, ms) {
      const { agent, store } = await w.open();
      const { sessionId } = await w.newCursorChat(agent);
      await agent.request(acp.methods.agent.session.setMode, { sessionId, modeId: 'plan' });
      const done = await w.prompt(agent, sessionId, PROMPTS.plan, ms(180));
      const lane = w.laneOf(await w.events(store, sessionId));
      const changed = lane === undefined ? '' : execFileSync('git', ['-C', lane.dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
      const records = w.approvals(sessionId);
      return [
        check('turn ended', done.stopReason === 'end_turn', done.stopReason),
        check('a lane exists for the chat', lane !== undefined, lane?.name ?? 'none'),
        check('no file in the lane changed', changed === '', changed || 'clean'),
        check('main a.ts is unchanged', readFileSync(path.join(w.repo, 'a.ts'), 'utf8') === A_TS),
        check('no client prompt appeared', w.asked.length === 0, w.asked),
        check('Geno allowed nothing', records.every((r) => r.verdict === 'deny' && r.decidedBy !== 'user'), records.length === 0 ? 'Cursor asked nothing' : records.map((r) => `${r.rule} ${r.verdict}`)),
      ];
    },
  },
  {
    n: 5,
    name: 'Auto mode',
    cursorPrompts: 1,
    needsGeno: true,
    limitS: 240,
    replies: [classifierAllow, classifierAllow],
    async run(w, ms) {
      const { agent, store } = await w.open();
      const { sessionId } = await w.newCursorChat(agent);
      await agent.request(acp.methods.agent.session.setMode, { sessionId, modeId: 'auto' });
      const done = await w.prompt(agent, sessionId, PROMPTS.auto, ms(180));
      const lane = w.laneOf(await w.events(store, sessionId));
      const records = w.approvals(sessionId);
      return [
        check('turn ended', done.stopReason === 'end_turn', done.stopReason),
        check('no client prompt appeared', w.asked.length === 0, w.asked),
        // git status is on Geno's safe list, so its rule answers; the cp is gray, so the classifier does.
        check('Geno answered every ask, and the classifier allowed one', records.length > 0 && records.every((r) => r.verdict === 'allow') && records.some((r) => r.decidedBy === 'classifier'), records.map((r) => `${clip(r.command, 40)}: ${r.decidedBy} ${r.verdict}`)),
        check('the classified copy ran in the lane', lane !== undefined && existsSync(path.join(lane.dir, 'README.copy.md'))),
        check('the answer is there', w.textOf(sessionId).trim() !== '', clip(w.textOf(sessionId))),
      ];
    },
  },
  {
    n: 6,
    name: 'Cancel',
    cursorPrompts: 1,
    needsGeno: false,
    limitS: 240,
    async run(w, ms) {
      const { agent } = await w.open();
      const { sessionId } = await w.newCursorChat(agent);
      w.allow();
      const turn = w.prompt(agent, sessionId, PROMPTS.cancel, ms(200));
      turn.catch(() => {});
      await until(() => w.shown(sessionId).some((u) => u.sessionUpdate === 'tool_call'), ms(150), 'the first tool call');
      // Cancelling once the command runs is what proves Cursor stops it; a cancel before that proves only the stop reason.
      const seen = await until(() => sleepPids().length > 0, FAKE ? 10_000 : 20_000, 'the sleep').then(
        () => sleepPids(),
        () => [],
      );
      const sent = Date.now();
      await agent.notify(acp.methods.agent.session.cancel, { sessionId });
      const done = await bounded(turn, 20_000, 'the cancelled turn');
      const gone = await until(() => sleepPids().length === 0, 10_000, 'the sleep to end').then(
        () => true,
        () => false,
      );
      const left = sleepPids();
      for (const pid of left) execFileSync('kill', ['-9', pid]);
      return [
        check('the stop reason is cancelled', done.stopReason === 'cancelled', `${done.stopReason} ${((Date.now() - sent) / 1000).toFixed(1)}s after cancel`),
        check('the command was running before the cancel', seen.length > 0, seen.length > 0 ? `pid ${seen.join(', ')}` : 'never seen, so the next check proves little'),
        check(`no sleep ${SLEEP} is left running`, gone, left.length === 0 ? 'none' : `killed ${left.join(', ')}`),
      ];
    },
  },
  {
    n: 7,
    name: 'Model switch',
    cursorPrompts: 1,
    needsGeno: false,
    limitS: 240,
    async run(w, ms) {
      const { agent, store } = await w.open();
      const started = await w.newCursorChat(agent);
      const { sessionId } = started;
      const models = started.configOptions?.find((o) => o.id === 'model');
      const offered = models?.type === 'select' ? models.options.flatMap((o) => ('options' in o ? o.options : [o])) : [];
      const label = (o: acp.SessionConfigSelectOption) => `${o.value} ${o.name}`;
      const cheap = offered.filter((o) => !/opus|fable|high/i.test(label(o)) && o.name !== 'Auto' && o.value !== 'default[]');
      const pick = cheap.find((o) => /low|flash/i.test(label(o))) ?? cheap[0];
      if (pick === undefined) return [check('a cheap model is offered', false, offered.map(label))];
      const switched = await agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: 'model', value: pick.value });
      const done = await w.prompt(agent, sessionId, PROMPTS.oneWord, ms(180));
      const used = (done._meta?.[TURN_USAGE_META] as { model?: string } | undefined)?.model;
      const logged = (await w.events(store, sessionId)).findLast((e) => e.kind === 'backend-model');
      const said = w.textOf(sessionId).trim();
      return [
        check('picked a cheap model', true, `${pick.value} (${pick.name}) of ${offered.length}`),
        check('the session holds it', switched.configOptions.find((o) => o.id === 'model')?.currentValue === pick.value),
        check('the switch is logged', logged?.kind === 'backend-model' && logged.model === pick.value),
        check('the turn reports that model', used === pick.name || used === pick.value, used ?? 'none'),
        check('the reply is one word', /^\W*\w+\W*$/.test(said), said),
      ];
    },
  },
  {
    n: 8,
    name: 'Reload',
    cursorPrompts: 2,
    needsGeno: false,
    limitS: 480,
    async run(w, ms) {
      const first = await w.open();
      const { sessionId } = await w.newCursorChat(first.agent);
      const made = await w.prompt(first.agent, sessionId, PROMPTS.remember, ms(180));
      first.close();
      const second = await w.open();
      const loaded = await bounded(second.agent.request(acp.methods.agent.session.load, { sessionId, cwd: w.repo, mcpServers: [] }), 60_000, 'session/load');
      const from = w.shown(sessionId).length;
      const recalled = await w.prompt(second.agent, sessionId, PROMPTS.recall, ms(180));
      const said = w.textOf(sessionId, from);
      const starts = (await w.events(second.store, sessionId)).filter((e) => e.kind === 'backend-start');
      const ids = starts.map((e) => (e.kind === 'backend-start' ? e.agentSessionId : ''));
      const fork = await second.agent.request(acp.methods.agent.session.fork, { sessionId, cwd: w.repo, mcpServers: [] }).then(
        () => 'forked',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      return [
        check('the first turn ended', made.stopReason === 'end_turn', made.stopReason),
        check('session/load names the Cursor backend', (loaded._meta?.[BACKEND_META] as { id?: string } | undefined)?.id === 'cursor'),
        check('the new engine took up the same Cursor session', ids.length === 2 && ids[0] === ids[1] && starts.every((e) => e.kind === 'backend-start' && e.loadable === true), ids),
        check('no "could not take up" notice', !said.includes('could not take up')),
        ...(FAKE ? [check('the fake got session/load', w.agentCalls().some((c) => c['method'] === 'session/load'))] : []),
        check('the answer remembers the earlier turn', /pelican/i.test(said) && /reload-marker/i.test(said), clip(said)),
        check('a fork of the Cursor chat is refused', fork !== 'forked', clip(fork, 120)),
      ];
    },
  },
  {
    n: 9,
    name: '@cursor subagent',
    cursorPrompts: 1,
    needsGeno: true,
    limitS: 300,
    async run(w, ms) {
      const { agent, store } = await w.open();
      const { sessionId } = await agent.request(acp.methods.agent.session.new, { cwd: w.repo, mcpServers: [] });
      w.allow();
      const done = await w.prompt(agent, sessionId, PROMPTS.subagent, ms(240));
      const log = await w.events(store, sessionId);
      const result = log.find((e) => e.kind === 'tool-result' && e.name === 'agent');
      const report = result !== undefined && 'output' in result ? result.output : '';
      const end = log.find((e) => e.kind === 'child-end');
      return [
        check('turn ended', done.stopReason === 'end_turn', done.stopReason),
        check('the child ran on Cursor', /^<subagent_report agent="cursor"/.test(report), clip(report, 80)),
        check('the child finished', end?.kind === 'child-end' && end.end.kind === 'done', end?.kind === 'child-end' ? end.end : 'no child-end'),
        check('the report lists the files', report.includes('a.ts') && report.includes('README.md'), clip(report.replace(/^<subagent_report[^>]*>/, ''), 160)),
      ];
    },
  },
  {
    n: 10,
    name: 'Arena',
    cursorPrompts: 1,
    needsGeno: true,
    limitS: 600,
    files: { '.gcode.json': `${JSON.stringify({ check: 'true', arena: { variants: [{ seed: 'plain' }, { seed: 'plain', backend: 'cursor' }] } })}\n` },
    replies: [answer('Added the line to a.ts.', usage), ranking],
    async run(w, ms) {
      const { agent } = await w.open();
      const { run } = await agent.request<ArenaNewResponse>(ARENA_NEW_METHOD, { cwd: w.repo, task: PROMPTS.arena, n: 2 });
      const latest = () => w.arenas.findLast((u) => u.run.id === run.id)?.run ?? run;
      await until(() => ['ranked', 'no-winner', 'stopped'].includes(latest().status), ms(540), 'the ranking');
      const ranked: ArenaRun = latest();
      const cursorLane = ranked.lanes.find((l) => l.variant.backend === 'cursor');
      const genoLane = ranked.lanes.find((l) => l.variant.backend === undefined);
      const first = ranked.lanes.find((l) => l.rank === 1);
      const picked = first === undefined ? undefined : await agent.request<{ run: ArenaRun }>(ARENA_PICK_METHOD, { cwd: w.repo, id: run.id, lane: first.lane }).then((r) => r.run);
      const cursorA = cursorLane === undefined ? '' : readFileSync(path.join(w.repo, '.geno/worktrees', cursorLane.lane, 'a.ts'), 'utf8');
      return [
        check('two lanes, one on Cursor and one on Geno', cursorLane !== undefined && genoLane !== undefined, ranked.lanes.map((l) => `${l.letter} ${l.variant.backend ?? 'geno'}`)),
        check('both lanes ran to an end', ranked.lanes.every((l) => l.status === 'passed' || l.status === 'failed'), ranked.lanes.map((l) => `${l.letter} ${l.status}`)),
        check('the Cursor lane made the edit', cursorA.includes('export const six = 6;')),
        check('the run is ranked', ranked.status === 'ranked', ranked.lanes.map((l) => `${l.letter} #${l.rank ?? '-'}`)),
        check('the pick completed', picked?.winner === first?.lane && picked !== undefined, picked?.winner ?? 'no pick'),
      ];
    },
  },
];

const FAKE_LIMITS: Record<number, string> = {
  1: 'the fake writes its edit by script, so only Cursor shows it edits the right line',
  6: 'the fake kills its own sleep on cancel, so only Cursor shows whether its terminal command stops',
  7: 'the fake reports no model, so the model in the turn is Geno’s own name for the pick',
  8: 'the fake answers from its script, so only Cursor’s loadSession shows real memory',
};

const wanted = (process.env['GCODE_SCENARIOS'] ?? '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);
const chosen = wanted.length === 0 ? SCENARIOS : SCENARIOS.filter((s) => wanted.includes(s.n));
say(`Cursor scenarios on the ${FAKE ? 'fake agent' : 'real Cursor agent'}: ${chosen.map((s) => s.n).join(', ')}; Cursor prompt cap ${CAP}`);

type Row = { readonly s: Scenario; readonly result: 'PASS' | 'FAIL' | 'SKIP'; readonly prompts: number; readonly seconds: number; readonly why: string };
const rows: Row[] = [];
for (const s of chosen) {
  const t0 = Date.now();
  const usedBefore = promptsUsed;
  say(`\n## ${s.n}. ${s.name}`);
  const skip = (why: string) => {
    rows.push({ s, result: 'SKIP', prompts: 0, seconds: 0, why });
    say(`SKIP ${s.n}. ${s.name}: ${why}`);
  };
  if (promptsUsed + s.cursorPrompts > CAP) {
    skip(`it needs ${s.cursorPrompts} Cursor prompts and ${CAP - promptsUsed} remain under the cap`);
    continue;
  }
  if (s.needsGeno && geno === undefined) {
    skip('no DASHSCOPE_API_KEY and DASHSCOPE_BASE_URL in GCODE_ENV_FILE or the repository .env');
    continue;
  }
  const w = world(s.n, s.files ?? {}, s.replies ?? []);
  say(`repo: ${w.repo}`);
  let checks: Check[];
  try {
    checks = await bounded(s.run(w, turnMs), FAKE ? 90_000 : s.limitS * 1000, `scenario ${s.n}`);
  } catch (error) {
    checks = [check('ran to its end', false, error instanceof Error ? error.message : String(error))];
  }
  w.close();
  sampleAgents();
  await until(() => [...agentPids].every((pid) => !alive(pid)), 5000, 'the agents to exit').catch(() => {});
  const stray = [...agentPids].filter(alive);
  for (const pid of stray) process.kill(pid, 'SIGKILL');
  agentPids.clear();
  checks.push(check('closing the engine left no Cursor process', stray.length === 0, stray.length === 0 ? 'none' : `killed pid ${stray.join(', ')}`));
  if (refusedOverCap > 0) checks.push(check('stayed under the Cursor prompt cap', false, `${refusedOverCap} prompts refused`));
  refusedOverCap = 0;
  const starts = w.errs.filter((l) => /^backend: cursor pid/.test(l));
  checks.push(check('every Cursor process ran in Geno’s sandbox', starts.length > 0 && starts.every((l) => l.includes('sandbox')), `${starts.length} started`));
  for (const c of checks) say(`  ${c.ok ? 'ok ' : 'NOT'} ${c.what}${c.seen === '' ? '' : `: ${clip(c.seen, 240)}`}`);
  const backendLines = w.errs.filter((l) => /^(backend|lane)/.test(l));
  if (backendLines.length > 0) say(`  engine: ${backendLines.map((l) => clip(l, 140)).join('\n          ')}`);
  const failed = checks.filter((c) => !c.ok);
  const result = failed.length === 0 ? 'PASS' : 'FAIL';
  const seconds = (Date.now() - t0) / 1000;
  rows.push({ s, result, prompts: promptsUsed - usedBefore, seconds, why: failed.map((c) => c.what).join('; ') });
  say(`${result} ${s.n}. ${s.name}: ${checks.length - failed.length}/${checks.length} checks, ${promptsUsed - usedBefore} Cursor prompts, ${seconds.toFixed(1)}s`);
}

say('\n| # | Scenario | Result | Cursor prompts | Seconds | Failed checks or note |');
say('| --- | --- | --- | --- | --- | --- |');
for (const r of rows) {
  const note = r.why || (FAKE && FAKE_LIMITS[r.s.n] !== undefined ? `fake: ${FAKE_LIMITS[r.s.n]}` : '');
  say(`| ${r.s.n} | ${r.s.name} | ${r.result} | ${r.prompts} | ${r.seconds.toFixed(1)} | ${note} |`);
}
say(`\nCursor prompts sent: ${promptsUsed} of ${CAP}.`);
process.exit(rows.some((r) => r.result === 'FAIL') ? 1 : 0);
