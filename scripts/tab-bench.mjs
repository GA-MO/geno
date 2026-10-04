// Replays sampled cursor positions through the extension's prompt builder against a running tab server.
// Run with tsx so the TypeScript core resolves: pnpm tab:bench [--half] [--keystroke] [--n 100] [--seed 1]
// --keystroke times the request after one more typed character, once the server has seen the position before,
// which is what live typing looks like; the default times each position cold.
// Start a fresh server per run: llama-server's RAM prompt cache keeps earlier runs' prompts and flatters later ones.
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  asCompletionId,
  buildFimPrompt,
  completionText,
  DEFAULT_FIM_BUDGET,
  DEFAULT_MAX_LINES,
  firstFilter,
  percentile,
  streamFim,
} from '../packages/core/src/tab/index.ts';

const { values } = parseArgs({
  options: {
    repo: { type: 'string', default: path.join(homedir(), 'Development/next-15-template') },
    endpoint: { type: 'string', default: 'http://127.0.0.1:8012' },
    n: { type: 'string', default: '100' },
    warmup: { type: 'string', default: '5' },
    seed: { type: 'string', default: '1' },
    half: { type: 'boolean', default: false },
    keystroke: { type: 'boolean', default: false },
    show: { type: 'string', default: '5' },
    log: { type: 'string' },
  },
});

const home = process.env.GCODE_HOME || path.join(homedir(), '.g-code');
const logFile = values.log ?? path.join(home, 'tab-events.jsonl');
const budget = values.half
  ? Object.fromEntries(Object.entries(DEFAULT_FIM_BUDGET).map(([k, v]) => [k, v / 2]))
  : DEFAULT_FIM_BUDGET;

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', 'out']);

async function sourceFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) found.push(...(await sourceFiles(full)));
    if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(full);
  }
  return found.sort();
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A cursor inside a non-trivial line with the rest of that line removed, as if the user were typing it. */
function sample(files, texts, random) {
  for (;;) {
    const file = files[Math.floor(random() * files.length)];
    const lines = texts.get(file).split('\n');
    const lineNo = Math.floor(random() * lines.length);
    const line = lines[lineNo];
    const indent = line.length - line.trimStart().length;
    if (line.trim().length < 3) continue;
    const col = indent + Math.floor(random() * (line.length - indent));
    const before = lines.slice(0, lineNo).join('\n');
    const prefix = (lineNo > 0 ? `${before}\n` : '') + line.slice(0, col);
    const suffix = lineNo + 1 < lines.length ? `\n${lines.slice(lineNo + 1).join('\n')}` : '';
    const siblings = files.filter((f) => f !== file && path.dirname(f) === path.dirname(file)).slice(0, 2);
    return {
      file,
      line: lineNo + 1,
      expected: line.slice(col),
      inputs: {
        repo: path.basename(values.repo),
        path: path.relative(values.repo, file),
        prefix,
        suffix,
        snippets: siblings.map((f) => ({ path: path.relative(values.repo, f), text: texts.get(f) })),
      },
    };
  }
}

async function complete(s) {
  const built = buildFimPrompt(s.inputs, budget);
  const sentAt = new Date().toISOString();
  const result = await streamFim({
    fetch,
    endpoint: values.endpoint,
    prompt: built,
    now: () => performance.now(),
  });
  const text = completionText(result.text);
  const here = { version: 1, offset: built.inputs.prefix.length };
  const filter = firstFilter({
    text,
    suffix: built.inputs.suffix,
    maxLines: DEFAULT_MAX_LINES,
    requested: here,
    current: here,
  });
  const request = {
    id: asCompletionId(randomUUID()),
    kind: 'fim',
    path: s.file,
    version: 1,
    offset: s.inputs.prefix.length,
    inputs: built.inputs,
    model: result.model ?? 'unknown',
    source: 'model',
    promptTokens: result.promptTokens ?? built.tokens,
    sentAt,
    ttftMs: result.ttftMs,
    latencyMs: result.latencyMs,
    text,
    outcome: filter === undefined ? { kind: 'shown' } : { kind: 'suppressed', filter },
    persisted: 'unknown',
  };
  return { s, built, result, text, filter, request };
}

const files = await sourceFiles(values.repo);
const texts = new Map(await Promise.all(files.map(async (f) => [f, await readFile(f, 'utf8')])));
const random = mulberry32(Number(values.seed));
const warmup = Array.from({ length: Number(values.warmup) }, () => sample(files, texts, random));
const samples = Array.from({ length: Number(values.n) }, () => sample(files, texts, random));

for (const s of warmup) await complete(s);

await mkdir(path.dirname(logFile), { recursive: true });
const typeOne = (s) => ({
  ...s,
  expected: s.expected.slice(1),
  inputs: { ...s.inputs, prefix: s.inputs.prefix + s.expected[0] },
});

const runs = [];
for (const s of samples) {
  if (values.keystroke) await complete(s);
  const run = await complete(values.keystroke ? typeOne(s) : s);
  await appendFile(logFile, `${JSON.stringify({ kind: 'request', request: run.request })}\n`);
  runs.push(run);
}

const ms = (v) => (v === null ? '-' : `${v.toFixed(0)} ms`);
const spread = (label, xs, fmt) => console.log(`${label.padEnd(24)} p50 ${fmt(percentile(xs, 50))}  p90 ${fmt(percentile(xs, 90))}`);
const num = (v) => (v === null ? '-' : v.toFixed(0));
const timed = runs.map((r) => r.result);
const ttft = timed.flatMap((r) => (r.ttftMs === null ? [] : [r.ttftMs]));
const total = timed.map((r) => r.latencyMs);
const server = timed.flatMap((r) => (r.timings === null ? [] : [r.timings]));

console.log(`repo: ${values.repo} (${files.length} .ts/.tsx files)`);
console.log(`endpoint: ${values.endpoint}, model: ${timed[0]?.model}`);
console.log(`budget: ${JSON.stringify(budget)}${values.half ? ' (half)' : ''}`);
console.log(`requests: ${runs.length} sequential, after ${warmup.length} uncounted warmup; seed ${values.seed}`);
console.log(`mode: ${values.keystroke ? 'one keystroke after an uncounted request at the same spot' : 'cold position'}`);
console.log(`log: ${logFile}`);
spread('time to first token', ttft, ms);
spread('total latency', total, ms);
spread('prompt tokens (server)', timed.map((r) => r.promptTokens), num);
spread('prompt tokens (estimate)', runs.map((r) => r.built.tokens), num);
spread('prompt tokens processed', server.map((t) => t.promptTokens), num);
spread('server prompt eval', server.map((t) => t.promptMs), ms);
spread('server prompt tok/s', server.map((t) => (t.promptTokens / t.promptMs) * 1000), num);
spread('server generation', server.map((t) => t.predictedMs), ms);
spread('generated tokens', server.map((t) => t.predictedTokens), num);
spread('server gen tok/s', server.map((t) => (t.predictedTokens / t.predictedMs) * 1000), num);
console.log(`no first token (empty reply): ${runs.length - ttft.length}`);
const passes = (xs) => percentile(xs, 50) <= 200 && percentile(xs, 90) <= 500;
console.log(`bar 200 ms p50 / 500 ms p90: ttft ${passes(ttft) ? 'PASS' : 'FAIL'}, total ${passes(total) ? 'PASS' : 'FAIL'}`);
const suppressed = Object.groupBy(runs.filter((r) => r.filter), (r) => r.filter);
console.log(`shown ${runs.filter((r) => !r.filter).length}, suppressed ${JSON.stringify(Object.fromEntries(Object.entries(suppressed).map(([k, v]) => [k, v.length])))}`);
const firstLine = (t) => t.split('\n')[0].trim();
const exact = runs.filter((r) => firstLine(r.text) !== '' && firstLine(r.text) === r.s.expected.trim()).length;
console.log(`first line equals the removed text: ${exact}/${runs.length}`);

const show = Number(values.show);
for (const r of runs.filter((r) => !r.filter).slice(0, show)) {
  const context = r.s.inputs.prefix.split('\n').slice(-3).join('\n');
  console.log(`\n--- ${path.relative(values.repo, r.s.file)}:${r.s.line}  (${ms(r.result.latencyMs)})`);
  console.log(`${context}█${r.text}`);
  console.log(`--- removed text was: ${JSON.stringify(r.s.expected)}`);
}
