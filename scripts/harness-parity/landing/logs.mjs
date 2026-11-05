// Each round's cost and working counts, read again from a run's own logs, so a fix to the counting reaches runs
// that already finished.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { GO_ON, transcriptOf } from '../harness.mjs';
import { behaviour } from './stats.mjs';
import { FEEDBACK, PROMPT } from './task.mjs';

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
 * Claude Code's dollars per round. A resumed session reports `total_cost_usd` as the session's running total, so a
 * round costs its last total minus the one before it; a total that goes down started a fresh count and is added.
 * A crashed or failed start reports zero, which says nothing about the running total and is skipped.
 */
function claudeCosts(job) {
  const costs = [0, 0];
  let round = 0;
  let last = 0;
  for (const e of lines(path.join(job, 'claude.jsonl'))) {
    if (e.type === 'hp-user' && e.text === FEEDBACK) round = 1;
    if (e.type !== 'result') continue;
    const total = e.total_cost_usd ?? 0;
    if (total === 0) continue;
    costs[round] += total >= last ? total - last : total;
    last = total;
  }
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
  const steps = !started ? [] : transcriptOf(harness, { job, home: path.join(job, 'home') }, { session, texts: [PROMPT, FEEDBACK, GO_ON] }).steps;
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
