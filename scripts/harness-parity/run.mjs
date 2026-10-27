// Runs each task on Claude Code (`claude -p`) and on Geno (`gcode agent`) with the same model, in a throwaway copy
// of the workspace and a fresh HOME, then scores the run: hidden check, hand-backs, self-check, turns, time, tokens.
// When a run ends by handing work back, the simulated user says "go on" (up to twice), as the real user did.
// usage: node scripts/harness-parity/run.mjs --round r0 --model claude-sonnet-5-5 [--task id]... [--harness claude|geno] [--parallel 3]
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { campaignEnv, REPO } from '../real-usecases/env.mjs';
import { classifyEnd } from './llm.mjs';
import { RUNS_DIR } from './paths.mjs';
import { CHENGDU_CHECKPOINTS, TASKS } from './tasks.mjs';
import { finalText, fromClaudeStream, fromGenoLog, render, selfVerified } from './transcript.mjs';

const { values } = parseArgs({ options: { round: { type: 'string' }, model: { type: 'string' }, task: { type: 'string', multiple: true }, harness: { type: 'string', multiple: true }, parallel: { type: 'string', default: '3' }, continues: { type: 'string', default: '2' } } });
if (!values.round || !values.model) throw new Error('--round and --model are required');
const RUNS = RUNS_DIR;
const GO_ON = 'ทำต่อได้เลย ตัดสินใจเองได้ ไม่ต้องถามผม';
const SEGMENT_MS = 40 * 60_000;
const BROWSER_MCP = { mcpServers: { 'chrome-devtools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.10.1', '--isolated', '--headless', '--no-usage-statistics', '--no-performance-crux', '--categoryPerformance=false', '--categoryMemory=false'] } } };

const write = (file, text, mode) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  if (mode) chmodSync(file, mode);
};

function prepare(task, job) {
  rmSync(job, { recursive: true, force: true });
  const home = path.join(job, 'home');
  const ws = path.join(home, 'Development', 'เฉิงตู');
  const base = path.join(job, 'base');
  mkdirSync(ws, { recursive: true });
  execFileSync('sh', ['-c', `git --git-dir="${CHENGDU_CHECKPOINTS}" archive ${task.sha} | tar -x -C "${ws}"`]);
  rmSync(path.join(ws, '.mcp.json'), { force: true });
  rmSync(path.join(ws, '.claude'), { recursive: true, force: true });
  for (const [rel, content] of Object.entries(task.extra ?? {})) {
    if (typeof content === 'string') write(path.join(ws, rel), content);
    else execFileSync('sh', ['-c', `git --git-dir="${CHENGDU_CHECKPOINTS}" archive ${content.fromSha} ${rel} | tar -x -C "${ws}"`]);
  }
  cpSync(ws, base, { recursive: true });
  write(path.join(home, '.gitconfig'), `[user]\n\tname = Dev\n\temail = dev@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[url "${home}/.hp/github/"]\n\tinsteadOf = https://github.com/\n\tinsteadOf = git@github.com:\n`);
  write(path.join(home, '.claude', 'settings.json'), '{}\n');
  mkdirSync(path.join(home, '.hp'), { recursive: true });
  write(path.join(home, '.config', 'gh', 'hosts.yml'), 'github.com:\n    user: dev\n    git_protocol: https\n');
  // The fake GitHub (gh, and curl for its pages) and a baton that is not installed, first on PATH as ~/.local/bin.
  for (const shim of ['gh', 'curl']) write(path.join(home, '.local', 'bin', shim), readFileSync(path.join(REPO, 'scripts/harness-parity/shims', shim), 'utf8'), 0o755);
  write(path.join(home, '.local', 'bin', 'baton'), '#!/bin/sh\necho "baton: command not found" >&2\nexit 127\n', 0o755);
  for (const [rel, text] of Object.entries(task.homeFiles ?? {})) write(path.join(home, rel), text);
  return { home, ws, base };
}

function sh(cmd, args, opts, outFile) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), SEGMENT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (outFile) writeFileSync(outFile, out, { flag: 'a' });
      resolve({ code, signal, out, err });
    });
  });
}

function baseEnv(home) {
  const env = { ...campaignEnv(), HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), GCODE_HOME: path.join(home, '.gcode'), PATH: `${path.join(home, '.local', 'bin')}:${process.env.PATH}` };
  for (const k of ['GCODE_MODEL', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
  return env;
}

let nextPort = 19100 + Math.floor(Math.random() * 500);

const harnesses = {
  async claude({ job, home, ws }, model, text, state) {
    const port = nextPort++;
    const capture = path.join(job, 'requests');
    mkdirSync(capture, { recursive: true });
    const proxy = spawn('node', [path.join(REPO, 'scripts/harness-parity/proxy.mjs'), String(port), capture], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 600));
    const mcp = path.join(job, 'browser-mcp.json');
    writeFileSync(mcp, JSON.stringify(BROWSER_MCP));
    const stream = path.join(job, 'claude.jsonl');
    writeFileSync(stream, `${JSON.stringify({ type: 'hp-user', text })}\n`, { flag: 'a' });
    const args = ['-p', text, '--model', model, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--mcp-config', mcp, ...(state.session ? ['--resume', state.session] : [])];
    const r = await sh('claude', args, { cwd: ws, env: { ...baseEnv(home), ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` } }, stream);
    proxy.kill();
    state.session ??= /"session_id":"([0-9a-f-]{36})"/.exec(r.out)?.[1];
    const result = r.out.split('\n').filter((l) => l.includes('"type":"result"')).map((l) => JSON.parse(l)).at(-1);
    return { stoppedBy: result?.subtype && result.subtype !== 'success' ? result.subtype : r.signal ? `killed ${r.signal}` : undefined, err: r.err };
  },
  async geno({ job, home, ws }, model, text, state) {
    const args = [path.join(REPO, 'packages/engine/src/cli.ts'), 'agent', ...(state.session ? ['--session', state.session] : ['--workspace', ws]), '--mode', 'auto', '--browser', text];
    const env = { ...baseEnv(home), GCODE_PROVIDER: 'anthropic', GCODE_MODEL: model, ...(process.env.HP_WIRE ? { GCODE_WIRE_LOG: path.join(job, 'geno-wire.jsonl') } : {}) };
    const r = await sh(path.join(REPO, 'node_modules/.bin/tsx'), args, { cwd: ws, env }, path.join(job, 'geno.out'));
    state.session ??= /session: ([0-9a-f-]{36})/.exec(r.out)?.[1];
    state.texts.push(text);
    writeFileSync(path.join(job, 'geno.err'), r.err, { flag: 'a' });
    const stop = /stopped after .*|budget.*|Reached the turn limit.*/i.exec(`${r.out}\n${r.err}`)?.[0];
    // A run that could not start, such as a session log the engine cannot read, is the harness failing, not the model.
    const failed = r.code !== 0 && r.code !== 3 ? `engine exited ${r.code}: ${r.err.trim().split('\n').at(-1)?.slice(0, 200)}` : undefined;
    return { stoppedBy: r.code === 3 ? stop ?? 'turn or cost limit' : r.signal ? `killed ${r.signal}` : failed, err: r.err };
  },
};

function transcriptOf(name, { job, home }, state) {
  if (name === 'claude') return fromClaudeStream(path.join(job, 'claude.jsonl'));
  const log = path.join(home, '.gcode', 'sessions', `${state.session}.jsonl`);
  return existsSync(log) ? fromGenoLog(log, state.texts) : { steps: [], usage: {}, modelCalls: 0, costUsd: 0 };
}

async function runJob(task, name, model) {
  const job = path.join(RUNS, values.round, `${task.id}.${name}.${model.replace('claude-', '')}`);
  const paths = { job, ...prepare(task, job) };
  const state = { session: undefined, texts: [] };
  const ends = [];
  const started = Date.now();
  let text = task.prompt;
  for (let segment = 0; ; segment++) {
    const { stoppedBy, err } = await harnesses[name](paths, model, text, state);
    if (state.session === undefined) return { task: task.id, harness: name, model, error: `no session: ${err.slice(-400)}` };
    const t = transcriptOf(name, paths, state);
    const end = await classifyEnd(task.prompt, finalText(t.steps.slice(t.steps.findLastIndex((s) => s.kind === 'user') + 1)), stoppedBy);
    ends.push({ ...end, stoppedBy });
    if (end.kind === 'done' || segment >= Number(values.continues)) break;
    text = GO_ON;
  }
  const ms = Date.now() - started;
  const t = transcriptOf(name, paths, state);
  let check;
  try {
    check = await task.check({ ...paths });
  } catch (error) {
    check = { pass: false, detail: `check threw: ${error.message}` };
  }
  const diff = execFileSync('sh', ['-c', `git diff --no-index --stat=200 --stat-name-width=160 "${paths.base}" "${paths.ws}" | grep -v '/[.]git/' | tail -15; true`], { encoding: 'utf8' });
  writeFileSync(path.join(job, 'transcript.md'), `# ${task.id} · ${name} · ${model}\n\n${render(t.steps)}\n\n## change summary\n${diff}\n`);
  const record = {
    task: task.id, set: task.set, harness: name, model, session: state.session, ms, modelCalls: t.modelCalls, costUsd: t.costUsd, usage: t.usage,
    handbacks: ends.filter((e) => e.kind !== 'done').length, ends, selfVerified: selfVerified(t.steps), toolCalls: t.steps.filter((s) => s.kind === 'tool').length, check, diff,
  };
  writeFileSync(path.join(job, 'record.json'), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

const tasks = values.task ? TASKS.filter((t) => values.task.includes(t.id)) : TASKS;
const names = values.harness ?? ['claude', 'geno'];
const queue = tasks.flatMap((task) => names.map((name) => [task, name]));
const results = [];
await Promise.all(
  Array.from({ length: Number(values.parallel) }, async () => {
    while (queue.length > 0) {
      const [task, name] = queue.shift();
      console.log(`>>> ${task.id} ${name}`);
      const r = await runJob(task, name, values.model).catch((error) => ({ task: task.id, harness: name, error: String(error.stack ?? error) }));
      results.push(r);
      console.log(`<<< ${task.id} ${name}: ${r.error ?? `${r.check.pass ? 'PASS' : `FAIL (${r.check.detail})`} handbacks=${r.handbacks} [${r.ends.map((e) => e.kind).join(',')}] verified=${r.selfVerified} calls=${r.modelCalls} $${r.costUsd.toFixed(2)} ${Math.round(r.ms / 1000)}s`}`);
    }
  }),
);
writeFileSync(path.join(RUNS, values.round, `results-${values.model.replace('claude-', '')}-${Date.now()}.json`), `${JSON.stringify(results, null, 2)}\n`);
