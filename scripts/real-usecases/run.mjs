// Layer A runner: one case at a time through the real engine on the real model, scored from the session log.
// usage: node scripts/real-usecases/run.mjs (--case <id>)... | --all  [--run <n or label>] [--cap 2.80] [--cost-scale 1]
// --cost-scale multiplies each step's --max-cost, which is sized for qwen3.8-flash, for a pricier model.
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { CASES } from './cases.mjs';
import { analyze, checksFor } from './checks.mjs';
import { campaignEnv, ENGINE, REPO, runHome, SCRATCH } from './env.mjs';
import { prepareHome } from './home.mjs';
import { FIXTURES, SIBLINGS } from './fixtures.mjs';

const { values } = parseArgs({ options: { case: { type: 'string', multiple: true }, all: { type: 'boolean' }, run: { type: 'string', default: '1' }, cap: { type: 'string', default: '2.80' }, 'cost-scale': { type: 'string', default: '1' } } });
const LEDGER = path.join(SCRATCH, 'ledger.jsonl');
const RESULTS = path.join(SCRATCH, 'results.jsonl');
const AGENT_TIMEOUT_MS = 20 * 60_000;

export const spent = () => (existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8').trim().split('\n').filter(Boolean).reduce((sum, l) => sum + JSON.parse(l).costUsd, 0) : 0);

function writeTree(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(root, rel === '_dot_env' ? '.env' : rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

function prepare(spec, runNo) {
  const dir = path.join(SCRATCH, 'ws', `${spec.id}-r${runNo}`);
  rmSync(dir, { recursive: true, force: true });
  const ws = path.join(dir, 'repo');
  const files = { ...FIXTURES[spec.fixture] };
  if (spec.settings) files['.g-code/settings.json'] = `${JSON.stringify({ ...JSON.parse(files['.g-code/settings.json'] ?? '{}'), ...spec.settings }, null, 2)}\n`;
  writeTree(ws, files);
  writeFileSync(path.join(ws, '.gitignore'), 'node_modules/\n');
  if (spec.sibling) writeTree(path.join(dir, spec.sibling), SIBLINGS[spec.sibling]);
  git(ws, 'init', '-q', '-b', 'main');
  git(ws, 'add', '-A');
  git(ws, 'commit', '-qm', 'Initial commit');
  spec.setup?.(ws);
  if (spec.commitSetup) {
    git(ws, 'add', '-A');
    git(ws, 'commit', '-qm', 'Add setup files');
  }
  return ws;
}

function gcode(cwd, args, extraEnv, timeoutMs = AGENT_TIMEOUT_MS) {
  return spawnSync(`${ENGINE}/node_modules/.bin/tsx`, [`${ENGINE}/packages/engine/src/cli.ts`, ...args], { cwd, env: campaignEnv(extraEnv), encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
}

/** The Auto classifier's calls, which the log keeps on each judged tool result. */
export const classifierCost = (events) => events.reduce((sum, e) => sum + (e.kind === 'tool-result' ? (e.approval?.classifier?.costUsd ?? 0) : 0), 0);

/**
 * The session's cost as `gcode usage` gives it, subagents included. An engine from before G-09 leaves the classifier
 * out (no classifierCostUsd field), so it is added here.
 */
function costOf(session, events, homeEnv) {
  const usage = JSON.parse(gcode(REPO, ['usage', '--session', session, '--json'], homeEnv).stdout);
  return (usage.costUsd ?? 0) + (usage.classifierCostUsd === undefined ? classifierCost(events) : 0);
}

function runCase(spec, runNo) {
  const ws = prepare(spec, runNo);
  const home = runHome(spec.id, runNo);
  const homeEnv = prepareHome(home, spec);
  rmSync(path.join(SCRATCH, "wire", `${spec.id}-r${runNo}.jsonl`), { force: true });
  const steps = spec.steps ?? [{ prompt: spec.prompt }];
  const outFile = path.join(SCRATCH, 'out', `${spec.id}-r${runNo}.txt`);
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, '');
  let session;
  const started = Date.now();
  for (const step of steps) {
    const mode = spec.mode === undefined ? ['--non-interactive'] : ['--mode', spec.mode];
    const args = ['agent', ...(session ? [] : ['--workspace', ws]), ...mode, '--max-turns', String(step.maxTurns ?? spec.maxTurns ?? 40), '--max-cost', String((spec.maxCost ?? 0.2) * Number(values['cost-scale'])), ...(session ? ['--session', session] : []), step.prompt];
    const result = gcode(ws, args, { ...homeEnv, ...(spec.env ?? {}), GCODE_WIRE_LOG: path.join(SCRATCH, "wire", `${spec.id}-r${runNo}.jsonl`) }, (spec.timeoutMin ?? 20) * 60_000);
    appendFileSync(outFile, `$ gcode ${args.slice(0, -1).join(' ')} <prompt>\n${result.stdout}\n--- stderr ---\n${result.stderr}\n--- exit ${result.status} signal ${result.signal}\n\n`);
    session ??= /session: ([0-9a-f-]{36})/.exec(result.stdout)?.[1];
    if (session === undefined) break;
  }
  const ms = Date.now() - started;
  if (session === undefined) return { case: spec.id, run: runNo, error: `no session; see ${outFile}`, costUsd: 0 };
  const logFile = path.join(homeEnv.GCODE_HOME, 'sessions', `${session}.jsonl`);
  const kept = path.join(SCRATCH, 'logs', `${spec.id}-r${runNo}.jsonl`);
  mkdirSync(path.dirname(kept), { recursive: true });
  copyFileSync(logFile, kept);
  const events = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const run = analyze(events);
  const scratchpad = events[0]?.environment?.scratchpad;
  const ctx = { ws, scratchpad, home, gitStatus: execFileSync('git', ['status', '--porcelain'], { cwd: ws, encoding: 'utf8' }) };
  const checks = checksFor(spec).map((check) => {
    try {
      if (check.verify !== undefined) {
        const r = spawnSync('sh', ['-c', check.verify], { cwd: ws, encoding: 'utf8', timeout: 120_000 });
        const passed = r.status === (check.expectExit ?? 0);
        return { id: check.id, what: check.what, pass: passed, detail: passed ? '' : `${r.stdout}${r.stderr}`.trim().split('\n').slice(-4).join(' / ').slice(0, 300) };
      }
      return { id: check.id, what: check.what, ...check.test(run, ctx) };
    } catch (error) {
      return { id: check.id, what: check.what, pass: false, detail: `check threw: ${error.message}` };
    }
  });
  const costUsd = costOf(session, events, homeEnv);
  return { case: spec.id, area: spec.area, run: runNo, engine: engineCommit(), session, costUsd, ms, modelCalls: run.assistants.length, toolCalls: run.calls.length, errors: run.errors.map((e) => `${e.error}: ${e.message.slice(0, 120)}`), checks };
}

/** The commit whose engine ran: a checkout's HEAD, marked dirty when it has changes, or an exported tree's .engine-commit. */
function engineCommit() {
  if (existsSync(path.join(ENGINE, '.engine-commit'))) return readFileSync(path.join(ENGINE, '.engine-commit'), 'utf8').trim();
  const head = git(ENGINE, 'rev-parse', '--short=8', 'HEAD').trim();
  return git(ENGINE, 'status', '--porcelain', '--', 'packages').trim() === '' ? head : `${head}+dirty`;
}

const cap = Number(values.cap);
const chosen = values.all ? CASES : CASES.filter((c) => values.case?.includes(c.id));
if (chosen.length === 0) throw new Error('no case chosen');
for (const spec of chosen) {
  if (spent() >= cap) {
    console.log(`STOP: spent $${spent().toFixed(4)} reached the cap $${cap}`);
    break;
  }
  console.log(`>>> ${spec.id} run ${values.run} (spent so far $${spent().toFixed(4)})`);
  const result = runCase(spec, /^\d+$/.test(values.run) ? Number(values.run) : values.run);
  appendFileSync(LEDGER, `${JSON.stringify({ layer: 'A', case: spec.id, run: result.run, session: result.session, costUsd: result.costUsd })}\n`);
  appendFileSync(RESULTS, `${JSON.stringify(result)}\n`);
  const failed = (result.checks ?? []).filter((c) => c.pass === false);
  console.log(`<<< ${spec.id}: ${result.error ?? `${failed.length === 0 ? 'PASS' : 'FAIL'} $${result.costUsd.toFixed(4)} ${result.modelCalls} model calls ${Math.round(result.ms / 1000)}s session ${result.session}`}`);
  for (const c of result.checks ?? []) console.log(`    ${c.pass === true ? 'ok  ' : c.pass === false ? 'FAIL' : 'n/a '} ${c.id}${c.detail ? `: ${c.detail}` : ''}`);
  for (const e of result.errors ?? []) console.log(`    error event: ${e}`);
}
console.log(`total spent $${spent().toFixed(4)}`);
