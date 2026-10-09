// Saves every Layer A run's full input and output under docs/results/real-usecases/runs/<case>/<run>/, for reuse as
// recordings for the shared fake model, regression evals and example docs, and writes runs/index.json.
// Run it after scripts/real-usecases/rescore.mjs. usage: node scripts/real-usecases/archive.mjs [--append]
// --append adds a later round's Layer A runs (GCODE_CAMPAIGN_SCRATCH) as new folders and index entries, and never
// rewrites a folder that exists.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { CASES } from './cases.mjs';
import { analyze, outputOf } from './checks.mjs';
import { campaignEnv, HOME, REPO, SCRATCH, sessionsOf } from './env.mjs';

const APPEND = process.argv.includes('--append');

const RUNS = path.join(REPO, 'docs/results/real-usecases/runs');
const GZIP_OVER = 200 * 1024;
const env = campaignEnv();
const SECRETS = [env.DASHSCOPE_API_KEY, env.OPENROUTER_API_KEY].filter((v) => v !== undefined && v.length >= 8);
const BASE_URL = env.DASHSCOPE_BASE_URL;

/**
 * Takes every key, the Model Studio workspace URL and any Authorization header out of a text before it is written. An
 * appended run also loses this checkout's path and the user's home, which every workspace path holds.
 */
export function redact(text) {
  let out = text;
  if (APPEND) out = out.split(REPO).join('<repo>').split(homedir()).join('<home>');
  for (const secret of SECRETS) out = out.split(secret).join('<redacted-key>');
  if (BASE_URL) out = out.split(BASE_URL.replace(/\/$/, '')).join('<DASHSCOPE_BASE_URL>');
  return out.replace(/("?authorization"?\s*[:=]\s*"?)(Bearer\s+)?[^"\s,}]+/gi, '$1<redacted>').replace(/sk-[A-Za-z0-9]{20,}/g, '<redacted-key>');
}

function write(dir, name, text) {
  const clean = redact(text);
  if (Buffer.byteLength(clean) > GZIP_OVER) {
    writeFileSync(path.join(dir, `${name}.gz`), gzipSync(clean));
    return `${name}.gz`;
  }
  writeFileSync(path.join(dir, name), clean);
  return name;
}

/**
 * Shrinks a JSONL of model requests by writing what each request repeats from the previous request of the same kind
 * as a reference: `system` and `tools` become {"$same": true}, and `messages` becomes {"$prefix": n, "tail": [...]},
 * the previous request's first n messages followed by the tail. runs/README.md gives the three lines that expand it.
 */
function deltaRequests(text) {
  const previous = new Map();
  return text.split('\n').filter(Boolean).map((line) => {
    const entry = JSON.parse(line);
    const request = entry.request;
    if (request === undefined || typeof request !== 'object' || !Array.isArray(request.messages)) return line;
    const kind = `${entry.url ?? ''}|${request.tools === undefined ? 'no-tools' : 'tools'}|${request.tool_choice === undefined ? '' : 'forced'}`;
    const before = previous.get(kind);
    previous.set(kind, request);
    if (before === undefined) return line;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    let n = 0;
    while (n < before.messages.length && n < request.messages.length && same(before.messages[n], request.messages[n])) n++;
    const out = { ...request, messages: { $prefix: n, tail: request.messages.slice(n) } };
    if (request.system !== undefined && same(request.system, before.system)) out.system = { $same: true };
    if (request.tools !== undefined && same(request.tools, before.tools)) out.tools = { $same: true };
    return JSON.stringify({ ...entry, request: out });
  }).join('\n') + '\n';
}

const readLog = (file) => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
/** The session and every subagent it started, children after their parent. */
function family(id, dir = path.join(HOME, 'sessions')) {
  const file = path.join(dir, `${id}.jsonl`);
  if (!existsSync(file)) return [];
  const events = readLog(file);
  const children = [...new Set(events.filter((e) => e.kind === 'child-start').map((e) => e.child))];
  return [{ id, events }, ...children.flatMap((child) => family(child, dir))];
}

const short = (text, max) => {
  const flat = String(text ?? '');
  return flat.length <= max ? flat : `${flat.slice(0, max)}\n… (${flat.length - max} more characters in session.jsonl)`;
};

/** A readable transcript: the user's prompts, the model's text, and each tool call with its result. */
function transcript(spec, run, events) {
  const results = new Map(events.filter((e) => e.kind === 'tool-result').map((e) => [e.toolUseId, e]));
  const lines = [`# ${spec.id}, run ${run}`, '', `Mode: ${spec.mode ?? 'non-interactive'}. Fixture: \`${spec.fixture}\`. Model: ${events[0]?.session?.model}.`, ''];
  for (const e of events) {
    if (e.kind === 'user') lines.push(`## User${e.from ? ` (${e.from})` : ''}`, '', e.content, '');
    if (e.kind === 'notice' && e.budget) lines.push(`> Geno budget notice: ${JSON.stringify(e.budget)}`, '');
    if (/compact/.test(e.kind)) lines.push(`> Compaction (${e.trigger ?? e.kind}): ${e.tokensBefore ?? '?'} -> ${e.tokensAfter ?? '?'} tokens`, '');
    if (e.kind === 'error') lines.push(`> Error (${e.error}): ${short(e.message, 400)}`, '');
    if (e.kind === 'child-start') lines.push(`> Subagent ${e.role} started: ${e.child}`, '');
    if (e.kind === 'child-end') lines.push(`> Subagent ended: ${JSON.stringify(e.end).slice(0, 200)}`, '');
    if (e.kind !== 'assistant') continue;
    for (const block of e.content ?? []) {
      if (block.type === 'text' && block.text.trim()) lines.push(`**Geno:** ${block.text.trim()}`, '');
      if (block.type !== 'tool_use') continue;
      const result = results.get(block.id);
      const approval = result?.approval ? ` (${result.approval.decidedBy} ${result.approval.verdict}: ${result.approval.reason})` : '';
      lines.push(`- \`${block.name}\` ${'`'}${short(JSON.stringify(block.input), 300).replace(/`/g, "'")}${'`'} -> **${result?.status ?? 'no result'}**${approval}`);
      const out = result === undefined ? '' : outputOf({ result });
      if (out) lines.push('', '  ```', ...short(out, 600).split('\n').map((l) => `  ${l}`), '  ```');
      lines.push('');
    }
  }
  return lines.join('\n');
}

/** The workspace's change against its first commit, untracked files included, without touching its index. */
function diffOf(ws) {
  if (!existsSync(ws)) return '';
  const root = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: ws, encoding: 'utf8' }).trim();
  const index = path.join(tmpdir(), `archive-index-${process.pid}`);
  const gitEnv = { ...process.env, GIT_INDEX_FILE: index };
  rmSync(index, { force: true });
  spawnSync('git', ['add', '-A'], { cwd: ws, env: gitEnv });
  const diff = spawnSync('git', ['diff', '--cached', root], { cwd: ws, env: gitEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout;
  rmSync(index, { force: true });
  return diff;
}

/** Each model request as sent, rebuilt by the engine from the log, for runs that had no wire log. */
function rebuiltRequests(session, events) {
  const cache = path.join(SCRATCH, 'rebuilt', `${session}.jsonl`);
  if (existsSync(cache)) return readFileSync(cache, 'utf8');
  const text = rebuild(session, events);
  mkdirSync(path.dirname(cache), { recursive: true });
  writeFileSync(cache, text);
  return text;
}

function rebuild(session, events) {
  const out = [];
  for (const e of events.filter((x) => x.kind === 'assistant')) {
    const r = spawnSync(`${REPO}/node_modules/.bin/tsx`, [`${REPO}/packages/engine/src/cli.ts`, 'session', 'request', session, String(e.seq)], { env: campaignEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) out.push(JSON.stringify({ seq: e.seq, request: JSON.parse(r.stdout) }));
  }
  return out.join('\n');
}

const scores = JSON.parse(readFileSync(path.join(SCRATCH, 'scores.json'), 'utf8'));
const index = [];
const added = [];
for (const score of scores) {
  const spec = CASES.find((c) => c.id === score.case);
  const runDir = path.join(RUNS, score.case, String(score.run));
  if (APPEND && existsSync(runDir)) throw new Error(`${runDir} exists; --append never rewrites a run`);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  added.push(runDir);
  const ws = path.join(SCRATCH, 'ws', `${score.case}-r${score.run}`, 'repo');
  const sessions = family(score.session, sessionsOf(score.case, score.run));
  const [main] = sessions;
  const files = {};

  files.case = write(runDir, 'case.json', `${JSON.stringify({
    case: spec.id, area: spec.area, layer: 'A', run: score.run, mode: spec.mode ?? 'non-interactive',
    prompts: (spec.steps ?? [{ prompt: spec.prompt }]).map((s) => ({ prompt: s.prompt, maxTurns: s.maxTurns ?? spec.maxTurns ?? 40 })),
    maxCostUsd: spec.maxCost ?? 0.2, env: spec.env ?? {}, settings: spec.settings ?? {}, sibling: spec.sibling ?? null, plugins: spec.plugins ?? [],
    ...(score.engine === undefined ? {} : { engineCommit: score.engine, home: 'a fresh HOME, CLAUDE_CONFIG_DIR and GCODE_HOME per run (scripts/real-usecases/home.mjs)' }),
    fixture: { name: spec.fixture, source: 'scripts/real-usecases/fixtures.mjs', setup: spec.setup ? spec.setup.toString() : null, initialCommit: existsSync(ws) ? execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: ws, encoding: 'utf8' }).trim() : null },
    replay: `node scripts/real-usecases/run.mjs --case ${spec.id} --run <n>`,
  }, null, 2)}\n`);
  files.session = write(runDir, 'session.jsonl', `${main.events.map((e) => JSON.stringify(e)).join('\n')}\n`);
  for (const child of sessions.slice(1)) write(runDir, `child-${child.id}.jsonl`, `${child.events.map((e) => JSON.stringify(e)).join('\n')}\n`);

  const wire = path.join(SCRATCH, 'wire', `${score.case}-r${score.run}.jsonl`);
  if (existsSync(wire)) {
    files.wire = write(runDir, 'wire.jsonl', deltaRequests(readFileSync(wire, 'utf8')));
  } else {
    files.requests = write(runDir, 'requests.jsonl', deltaRequests(rebuiltRequests(score.session, main.events)));
  }
  files.diff = write(runDir, 'diff.patch', diffOf(ws));
  files.transcript = write(runDir, 'transcript.md', transcript(spec, score.run, main.events));

  const run = analyze(main.events);
  const usage = sessions.flatMap((s) => s.events).filter((e) => e.kind === 'assistant').reduce((sum, e) => ({
    input: sum.input + (e.usage?.input ?? 0), cacheRead: sum.cacheRead + (e.usage?.cacheRead ?? 0), cacheWrite: sum.cacheWrite + (e.usage?.cacheWrite ?? 0), output: sum.output + (e.usage?.output ?? 0), latencyMs: sum.latencyMs + (e.latencyMs ?? 0),
  }), { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, latencyMs: 0 });
  const passed = score.checks.every((c) => c.pass !== false);
  // Every model call of the session and its subagents, plus the Auto classifier's calls, which `gcode usage` leaves out.
  const all = sessions.flatMap((s) => s.events);
  const cost = all.reduce((sum, e) => sum + (e.kind === 'assistant' ? (e.costUsd ?? 0) : e.kind === 'tool-result' ? (e.approval?.classifier?.costUsd ?? 0) : 0), 0);
  files.result = write(runDir, 'result.json', `${JSON.stringify({ case: score.case, run: score.run, session: score.session, passed, costUsd: cost, classifierUsd: score.classifierUsd, modelCalls: run.assistants.length, toolCalls: run.calls.length, tokens: usage, errors: score.errors, checks: score.checks }, null, 2)}\n`);

  // A run that stashes the user's work (ISSUES.md P-01) is not an example to copy, whatever its checks say.
  const stashes = run.calls.some((c) => c.name === 'bash' && /git stash(?!\s+(list|show))/.test(String(c.input.command)));
  const goodExample = passed && !stashes && run.calls.length <= 10 && run.errors.length === 0;
  const round = score.engine === undefined ? {} : { engineCommit: score.engine, phase: /^fix-b/.test(String(score.run)) ? 'before' : 'after', note: /^fix-b/.test(String(score.run)) ? `before the fixes, on ${score.engine}` : `after the fixes, on ${score.engine}; see FIXES.md` };
  index.push({ case: score.case, area: score.area, layer: 'A', run: score.run, ...round, model: main.events[0]?.session?.model, date: main.events[0]?.session?.createdAt, passed, costUsd: Number(cost.toFixed(6)), modelCalls: run.assistants.length, goodExample, dir: path.relative(path.join(REPO, 'docs/results/real-usecases'), runDir), files });
}

// Layer B: each UI step's chat is a session of the run's extension host, found by the prompt the step sent.
const STEP_PROMPTS = {
  'B10-thai-and-working': 'อธิบายโปรเจกต์นี้สั้นๆ',
  'B01-ask-allow': 'Delete the build folder',
  'B02-ask-deny': /Run git clean -fdx|Remove src\/profile\.js/,
  'B03-no-and-tell': 'Delete the dist folder',
  'B04-keep-undo': 'Two small edits',
  'B05-lanes': /Add one line at the end of README|Create CONTRIBUTING\.md/,
  'B07-subagent-row': 'Use an explore subagent',
  'B08-mcp-banner': 'MCP server\'s echo tool',
  'B09-stop-and-resume-thai': 'Read every file in this repository',
};
const reportsB = !APPEND && existsSync(path.join(SCRATCH, 'layer-b.jsonl')) ? readLog(path.join(SCRATCH, 'layer-b.jsonl')) : [];
for (const runNo of [...new Set(reportsB.map((r) => r.run ?? '1'))]) {
  const kept = path.join(SCRATCH, `layer-b-r${runNo}`);
  const sessionsDir = path.join(kept, 'sessions');
  if (!existsSync(sessionsDir)) continue;
  const all = readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl')).map((f) => ({ id: f.replace('.jsonl', ''), events: readLog(path.join(sessionsDir, f)) }));
  const panelDir = path.join(RUNS, 'B-panel', runNo);
  rmSync(panelDir, { recursive: true, force: true });
  mkdirSync(panelDir, { recursive: true });
  const panelFiles = {
    wire: existsSync(path.join(kept, 'wire.jsonl')) ? write(panelDir, 'wire.jsonl', deltaRequests(readFileSync(path.join(kept, 'wire.jsonl'), 'utf8'))) : null,
    diff: existsSync(path.join(kept, 'diff.patch')) ? write(panelDir, 'diff.patch', readFileSync(path.join(kept, 'diff.patch'), 'utf8')) : null,
  };
  write(panelDir, 'README.md', `# Layer B run ${runNo}\n\nThe pooled VS Code window, driven by \`packages/extension/test/suite/real-model.ts\` with GCODE_REAL_RUN=${runNo}. \`wire.jsonl\` holds every model request and response of every step's chat, subagents and lanes included. \`diff.patch\` is the workspace's change at the end of the run. Each step's own folder is \`runs/<step>/${runNo}/\`.\n`);
  for (const report of reportsB.filter((r) => (r.run ?? '1') === runNo && r.step !== 'cost')) {
    const match = STEP_PROMPTS[report.step];
    const hits = all.filter(({ events }) => events.some((e) => e.kind === 'user' && (typeof match === 'string' ? e.content.includes(match) : match.test(e.content))));
    const stepDir = path.join(RUNS, report.step, runNo);
    rmSync(stepDir, { recursive: true, force: true });
    mkdirSync(stepDir, { recursive: true });
    const files = { report: write(stepDir, 'result.json', `${JSON.stringify(report, null, 2)}\n`) };
    let costUsd = 0;
    for (const hit of hits) {
      for (const member of family(hit.id, sessionsDir)) {
        write(stepDir, `session-${member.id}.jsonl`, `${member.events.map((e) => JSON.stringify(e)).join('\n')}\n`);
        costUsd += member.events.reduce((sum, e) => sum + (e.kind === 'assistant' ? (e.costUsd ?? 0) : 0), 0);
      }
      write(stepDir, `transcript-${hit.id}.md`, transcript({ id: report.step, mode: 'ask (VS Code panel)', fixture: 'packages/extension/test/suite/real-model-fixture.ts' }, runNo, hit.events));
    }
    const shotDir = path.join(REPO, 'docs/results/real-usecases/shots', `r${runNo}`);
    const shots = existsSync(shotDir) ? readdirSync(shotDir).filter((f) => f.startsWith(report.step.split('-')[0] + '-')).map((f) => `shots/r${runNo}/${f}`) : [];
    write(stepDir, 'case.json', `${JSON.stringify({ case: report.step, layer: 'B', run: runNo, mode: 'ask', suite: 'packages/extension/test/suite/real-model.ts', fixture: 'packages/extension/test/suite/real-model-fixture.ts', sessions: hits.map((h) => h.id), screenshots: shots, wire: `runs/B-panel/${runNo}/${panelFiles.wire}` }, null, 2)}\n`);
    const turns = hits.flatMap((h) => analyze(h.events).calls);
    index.push({ case: report.step, area: 'ui', layer: 'B', run: Number(runNo), model: 'qwen3.8-flash', date: report.at, passed: report.ok === true, costUsd: Number(costUsd.toFixed(6)), modelCalls: hits.reduce((n, h) => n + analyze(h.events).assistants.length, 0), goodExample: report.ok === true && turns.length <= 10, dir: path.relative(path.join(REPO, 'docs/results/real-usecases'), stepDir), files: { ...files, screenshots: shots } });
  }
}
const kept = APPEND ? JSON.parse(readFileSync(path.join(RUNS, 'index.json'), 'utf8')) : [];
writeFileSync(path.join(RUNS, 'index.json'), `${JSON.stringify([...kept, ...index], null, 2)}\n`);

// The user's own files must never reach an archived request: their CLAUDE.md, a SessionStart hook, or their paths.
const USER_MARKERS = ['pstack model configuration', 'EXTREMELY_IMPORTANT', homedir()];
for (const dir of APPEND ? added : []) {
  for (const f of readdirSync(dir)) {
    const file = path.join(dir, f);
    const text = f.endsWith('.gz') ? gunzipSync(readFileSync(file)).toString('utf8') : readFileSync(file, 'utf8');
    const found = USER_MARKERS.filter((m) => text.includes(m));
    if (found.length > 0) throw new Error(`${file} holds ${found.join(', ')}`);
  }
}

const leaks = SECRETS.flatMap((secret) => {
  const r = spawnSync('grep', ['-rlF', secret, RUNS], { encoding: 'utf8' });
  return r.stdout.trim() === '' ? [] : r.stdout.trim().split('\n');
});
const zipped = readdirSync(RUNS, { recursive: true }).filter((f) => String(f).endsWith('.gz'));
for (const z of zipped) {
  const r = spawnSync('sh', ['-c', `gunzip -c "${path.join(RUNS, String(z))}" | grep -cF "$KEY"`], { env: { ...process.env, KEY: SECRETS[0] ?? 'none' }, encoding: 'utf8' });
  if (r.stdout.trim() !== '0') leaks.push(String(z));
}
if (leaks.length > 0) throw new Error(`a key is still in: ${leaks.join(', ')}`);
console.log(`archived ${index.length} runs; no key found in ${RUNS}`);
