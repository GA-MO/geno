// pnpm tsx packages/engine/test/session-search-bench.ts [sessions] [max tool output bytes]
// Writes a store of generated session logs (300 by default, mixed English and Thai, with tool output up to 2,500 bytes
// a call, which the index skips), then times the History through SessionIndex: the first use, which reads every log,
// warm searches, and a search after one log grew. For comparison it also times what listing the History cost before
// U57, reading and summarizing every log on each list. Prints the medians and ranges over the runs.
import { appendFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { asSessionId, summarizeSession, type SearchOptions, type Session, type SessionScope, type TurnEvent } from '@g-code/core';
import { SessionIndex } from '../src/session-index.js';
import { readSessionLog, type SessionLog } from '../src/sessions.js';
import { openStore } from '../src/store.js';

const SESSIONS = Number(process.argv[2] ?? 300);
const MAX_OUTPUT = Number(process.argv[3] ?? 2500);
const RUNS = 5;
const WORKSPACE = '/Users/me/projects/shop';
const HISTORY: SearchOptions = { match: 'all', limit: 50, snippetLength: 120 };
const SCOPE: SessionScope = { kind: 'project', workspace: WORKSPACE };

let seed = 57;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));

const EN = 'the parser cache order checkout payment queue worker migration schema index route page layout button form token session user admin price cart stock email webhook retry deploy build test lint'.split(' ');
const TH = ['ตัดสินใจ', 'ฐานข้อมูล', 'หน้าเว็บ', 'ทดสอบ', 'แก้ไข', 'ลูกค้า', 'คำสั่งซื้อ', 'ชำระเงิน', 'ตะกร้า', 'สินค้า', 'ผู้ใช้', 'ระบบ'];
const sentence = (words: number) => Array.from({ length: words }, () => (random() < 0.3 ? pick(TH) : pick(EN))).join(random() < 0.5 ? ' ' : '');
const blob = (bytes: number) => Array.from({ length: Math.ceil(bytes / 40) }, (_, i) => `line ${i}: ${pick(EN)} ${pick(EN)} ok 0.${between(0, 999)}ms`).join('\n');

function sessionEvents(n: number): TurnEvent[] {
  const createdAt = new Date(Date.UTC(2026, 0, 1) + n * 3_600_000).toISOString();
  const session: Session = { id: asSessionId(`bench-${String(n).padStart(4, '0')}`), createdAt, workspace: WORKSPACE, provider: 'modelstudio', model: 'qwen3.8-flash', effort: 'medium' };
  const events: TurnEvent[] = [{ kind: 'session-start', session }];
  let seq = 1;
  let clock = Date.parse(createdAt);
  const at = () => new Date((clock += between(500, 20_000))).toISOString();
  for (let turn = 0, turns = between(3, 25); turn < turns; turn++) {
    events.push({ kind: 'user', seq: seq++, at: at(), content: sentence(between(8, 60)) });
    for (let call = 0, calls = between(1, 6); call < calls; call++) {
      const id = `tu_${n}_${seq}`;
      events.push({
        kind: 'assistant',
        seq: seq++,
        at: at(),
        content: [
          { type: 'text', text: sentence(between(10, 80)), citations: null },
          { type: 'tool_use', id, name: 'bash', input: { command: `pnpm test ${pick(EN)}` }, caller: { type: 'direct' } },
        ] as never,
        stopReason: 'tool_use',
        usage: { input: 9000, cacheRead: 8000, cacheWrite: 0, output: 300 },
        costUsd: 0.001,
        latencyMs: 3000,
        model: 'qwen3.8-flash',
      });
      events.push({ kind: 'tool-result', seq: seq++, at: at(), toolUseId: id, name: 'bash', status: 'ok', output: blob(between(200, MAX_OUTPUT)) });
    }
    events.push({
      kind: 'assistant',
      seq: seq++,
      at: at(),
      content: [{ type: 'text', text: sentence(between(40, 300)), citations: null }] as never,
      stopReason: 'end_turn',
      usage: { input: 9000, cacheRead: 8000, cacheWrite: 0, output: 600 },
      costUsd: 0.001,
      latencyMs: 4000,
      model: 'qwen3.8-flash',
    });
  }
  return events;
}

const QUERIES = ['parser', 'checkout payment', 'ตัดสินใจ', 'ฐานข้อมูล ลูกค้า', 'webhook retry deploy', 'zzz-no-such-word', 'ระบบ', 'migration schema'];

const summaryOf = (log: SessionLog) => summarizeSession(log.session, log.events);
const ms = (start: number) => performance.now() - start;
const median = (xs: readonly number[]) => xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const show = (xs: readonly number[]) => `${median(xs).toFixed(1)} ms (${Math.min(...xs).toFixed(1)} to ${Math.max(...xs).toFixed(1)})`;

const home = await mkdtemp(path.join(tmpdir(), 'gcode-search-bench-'));
const store = openStore({ GCODE_HOME: home });
await mkdir(store.sessionsDir, { recursive: true });
let events = 0;
for (let n = 0; n < SESSIONS; n++) {
  const lines = sessionEvents(n);
  events += lines.length;
  await writeFile(path.join(store.sessionsDir, `bench-${String(n).padStart(4, '0')}.jsonl`), `${lines.map((e) => JSON.stringify(e)).join('\n')}\n`);
}
const files = await readdir(store.sessionsDir);
const bytes = (await Promise.all(files.map(async (f) => (await stat(path.join(store.sessionsDir, f))).size))).reduce((a, b) => a + b, 0);
console.log(`${SESSIONS} sessions, ${events} events, ${(bytes / 1e6).toFixed(1)} MB of logs in ${store.sessionsDir}`);

const listing: number[] = [];
for (let run = 0; run < RUNS; run++) {
  const start = performance.now();
  await Promise.all(files.map(async (name) => summaryOf(await readSessionLog(path.join(store.sessionsDir, name)))));
  listing.push(ms(start));
}

const cold: number[] = [];
const warm: number[] = [];
const grown: number[] = [];
let texts = 0;
for (let run = 0; run < RUNS; run++) {
  const index = new SessionIndex(store);
  let start = performance.now();
  await index.search('parser', SCOPE, HISTORY, console.error);
  cold.push(ms(start));
  if (run === 0) texts = (await index.docs(console.error)).reduce((sum, doc) => sum + doc.turns.reduce((n, turn) => n + turn.texts.length, 0), 0);
  for (const query of QUERIES) {
    start = performance.now();
    await index.search(query, SCOPE, HISTORY, console.error);
    warm.push(ms(start));
  }
  const file = path.join(store.sessionsDir, files[run]!);
  await appendFile(file, `${JSON.stringify({ kind: 'user', seq: 100_000 + run, at: new Date().toISOString(), content: 'a new prompt about the parser' })}\n`);
  start = performance.now();
  await index.search('parser', SCOPE, HISTORY, console.error);
  grown.push(ms(start));
}
const index = new SessionIndex(store);
await index.docs(console.error);
for (const query of QUERIES) {
  const hits = await index.search(query, SCOPE, HISTORY, console.error);
  console.log(`  ${JSON.stringify(query)}: ${hits.length} sessions`);
}
console.log(`indexed texts: ${texts}`);
console.log(`listing before U57 (reads every log on each list): ${show(listing)}`);
console.log(`first search or list (reads every log): ${show(cold)}`);
console.log(`warm search, ${QUERIES.length} queries x ${RUNS}: ${show(warm)}`);
console.log(`search after one log grew: ${show(grown)}`);
await rm(home, { recursive: true, force: true });
