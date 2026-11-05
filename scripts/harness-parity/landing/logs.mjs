// Each round's cost and working counts, read again from a run's own logs, so a fix to the counting reaches runs
// that already finished.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { GO_ON, transcriptOf } from '../harness.mjs';
import { spendSince } from '../transcript.mjs';
import { behaviour } from './stats.mjs';
import { FEEDBACK, GO_ON_EN, PROMPT } from './task.mjs';

/** A log's JSON lines; a line cut off by a crash mid-write is skipped, not fatal. */
const lines = (file) =>
  (existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []).flatMap((l) => {
    try {
      return l.trim().startsWith('{') ? [JSON.parse(l)] : [];
    } catch {
      return [];
    }
  });

/**
 * Anthropic's list price per million tokens, as packages/core/src/cost.ts has it; a cache write costs 1.25 times
 * input for five minutes and twice input for an hour.
 */
const RATES = { 'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 }, 'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 }, 'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1 } };

/** What one model call cost, from the usage Claude Code streamed for it. An unpriced model is priced as Opus, never as free. */
export function priceUsage(model, u) {
  const r = RATES[model] ?? RATES['claude-opus-5-5'];
  const hour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const fiveMinutes = (u.cache_creation_input_tokens ?? 0) - hour;
  return ((u.input_tokens ?? 0) * r.input + (u.output_tokens ?? 0) * r.output + (u.cache_read_input_tokens ?? 0) * r.cacheRead + fiveMinutes * r.input * 1.25 + hour * r.input * 2) / 1_000_000;
}

/**
 * Claude Code's dollars per round, each result line priced by spendSince. A segment that was killed before its
 * result line is priced from the usage of the model calls it streamed.
 */
function claudeCosts(job) {
  const costs = [0, 0];
  let round = 0;
  let last = 0;
  let calls = new Map();
  let settled = true;
  const settle = () => {
    if (!settled) costs[round] += [...calls.values()].reduce((s, m) => s + priceUsage(m.model, m.usage), 0);
    calls = new Map();
    settled = true;
  };
  for (const e of lines(path.join(job, 'claude.jsonl'))) {
    if (e.type === 'hp-user') {
      settle();
      if (e.text === FEEDBACK) round = 1;
      settled = false;
    }
    // Each streamed event repeats its call's usage as it grows, so the last one per call id is the call's total.
    if (e.type === 'assistant' && e.message?.usage) calls.set(e.message.id, e.message);
    if (e.type !== 'result') continue;
    settled = true;
    const total = e.total_cost_usd ?? 0;
    costs[round] += spendSince(last, total);
    last = total || last;
  }
  settle();
  return costs;
}

function genoCosts(log) {
  const costs = [0, 0];
  let round = 0;
  for (const e of lines(log)) {
    if (e.kind === 'user' && e.content === FEEDBACK) round = 1;
    if (e.kind === 'assistant') costs[round] += e.costUsd ?? 0;
  }
  return costs;
}

const genoLog = (job, session) => path.join(job, 'home', '.gcode', 'sessions', `${session}.jsonl`);
/** Geno's session id, from what the engine printed when the run started. */
const genoSession = (job) => {
  const out = path.join(job, 'geno.out');
  return existsSync(out) ? /session: ([0-9a-f-]{36})/.exec(readFileSync(out, 'utf8'))?.[1] : undefined;
};
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

/** [round 1, round 2] of { costUsd, behaviour } for a run folder; a round that never started reads as zero. */
export function roundsOf(job, harness) {
  const session = harness === 'geno' ? genoSession(job) : undefined;
  const started = harness === 'geno' ? session !== undefined : existsSync(path.join(job, 'claude.jsonl'));
  const steps = !started ? [] : transcriptOf(harness, { job, home: path.join(job, 'home') }, { session, texts: [PROMPT, FEEDBACK, GO_ON, GO_ON_EN] }).steps;
  const cut = steps.findIndex((s) => s.kind === 'user' && s.text === FEEDBACK);
  const costs = harness === 'claude' ? claudeCosts(job) : session === undefined ? [0, 0] : genoCosts(genoLog(job, session));
  return [
    { costUsd: costs[0], behaviour: behaviour(cut === -1 ? steps : steps.slice(0, cut)) },
    { costUsd: costs[1], behaviour: behaviour(cut === -1 ? [] : steps.slice(cut), ['index.html']) },
  ];
}

/** The dollars a run folder spent so far, finished or not, so a failed or killed run's spend is not lost. */
export function spentBy(job, harness) {
  if (harness === 'claude') return sum(claudeCosts(job));
  const session = genoSession(job);
  return session === undefined ? 0 : sum(genoCosts(genoLog(job, session)));
}
