// How each harness is driven for one request: Claude Code (`claude -p`) and Geno (`gcode agent`) with the same model,
// in a fresh HOME with the same headless browser server. Shared by the task rounds (run.mjs) and the landing suite.
// When a request ends by handing work back, the simulated user says "go on" (up to `continues` times), as the real user did.
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { campaignEnv, REPO } from '../real-usecases/env.mjs';
import { classifyEnd } from './llm.mjs';
import { finalText, fromClaudeStream, fromGenoLog } from './transcript.mjs';

export const GO_ON = 'ทำต่อได้เลย ตัดสินใจเองได้ ไม่ต้องถามผม';
const SEGMENT_MS = 40 * 60_000;
const BROWSER_MCP = { mcpServers: { 'chrome-devtools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.10.1', '--isolated', '--headless', '--no-usage-statistics', '--no-performance-crux', '--categoryPerformance=false', '--categoryMemory=false'] } } };

export const write = (file, text, mode) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  if (mode) chmodSync(file, mode);
};

/** The fresh HOME every run gets: git identity, empty Claude settings, the fake GitHub and a missing baton. */
export function writeHome(home, homeFiles = {}) {
  write(path.join(home, '.gitconfig'), `[user]\n\tname = Dev\n\temail = dev@example.com\n[commit]\n\tgpgsign = false\n[init]\n\tdefaultBranch = main\n[url "${home}/.hp/github/"]\n\tinsteadOf = https://github.com/\n\tinsteadOf = git@github.com:\n`);
  write(path.join(home, '.claude', 'settings.json'), '{}\n');
  mkdirSync(path.join(home, '.hp'), { recursive: true });
  write(path.join(home, '.config', 'gh', 'hosts.yml'), 'github.com:\n    user: dev\n    git_protocol: https\n');
  // The fake GitHub (gh, and curl for its pages) and a baton that is not installed, first on PATH as ~/.local/bin.
  for (const shim of ['gh', 'curl']) write(path.join(home, '.local', 'bin', shim), readFileSync(path.join(REPO, 'scripts/harness-parity/shims', shim), 'utf8'), 0o755);
  write(path.join(home, '.local', 'bin', 'baton'), '#!/bin/sh\necho "baton: command not found" >&2\nexit 127\n', 0o755);
  for (const [rel, text] of Object.entries(homeFiles)) write(path.join(home, rel), text);
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

export const harnesses = {
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
    const args = ['-p', text, '--model', model, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--mcp-config', mcp, ...(state.session ? ['--resume', state.session] : []), ...(state.capUsd ? ['--max-budget-usd', String(state.capUsd)] : [])];
    const r = await sh('claude', args, { cwd: ws, env: { ...baseEnv(home), ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` } }, stream);
    proxy.kill();
    state.session ??= /"session_id":"([0-9a-f-]{36})"/.exec(r.out)?.[1];
    const result = r.out.split('\n').filter((l) => l.includes('"type":"result"')).map((l) => JSON.parse(l)).at(-1);
    return { stoppedBy: result?.subtype && result.subtype !== 'success' ? result.subtype : r.signal ? `killed ${r.signal}` : undefined, err: r.err };
  },
  async geno({ job, home, ws }, model, text, state) {
    const args = [path.join(REPO, 'packages/engine/src/cli.ts'), 'agent', ...(state.session ? ['--session', state.session] : ['--workspace', ws]), '--mode', 'auto', '--browser', ...(state.capUsd ? ['--max-cost', String(state.capUsd)] : []), text];
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

export function transcriptOf(name, { job, home }, state) {
  if (name === 'claude') return fromClaudeStream(path.join(job, 'claude.jsonl'));
  const log = path.join(home, '.gcode', 'sessions', `${state.session}.jsonl`);
  return existsSync(log) ? fromGenoLog(log, state.texts) : { steps: [], usage: {}, modelCalls: 0, costUsd: 0 };
}

/**
 * Sends `text` in the run's session, then "go on" while the agent hands work back, up to `continues` times. Returns
 * how each segment ended, or `error` when the harness never started a session.
 */
export async function converse(name, paths, model, state, text, request, continues) {
  const ends = [];
  for (let segment = 0; ; segment++) {
    const { stoppedBy, err } = await harnesses[name](paths, model, segment === 0 ? text : GO_ON, state);
    if (state.session === undefined) return { ends, error: `no session: ${err.slice(-400)}` };
    const t = transcriptOf(name, paths, state);
    const end = await classifyEnd(request, finalText(t.steps.slice(t.steps.findLastIndex((s) => s.kind === 'user') + 1)), stoppedBy);
    ends.push({ ...end, stoppedBy });
    if (end.kind === 'done' || segment >= continues) return { ends };
  }
}

/** `git diff --stat` of a run's workspace against where it started. */
export const diffStat = (base, ws) => execFileSync('sh', ['-c', `git diff --no-index --stat=200 --stat-name-width=160 "${base}" "${ws}" | grep -v '/[.]git/' | tail -15; true`], { encoding: 'utf8' });
