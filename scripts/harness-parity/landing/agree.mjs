// Reads the owner's vote code from vote.html ("1A-2B-3T"), unblinds it with the key, and says on how many pairs the
// owner and the judge agree. Keeps the votes next to the key so the next report shows them.
// usage: node scripts/harness-parity/landing/agree.mjs --round l1 --votes 1A-2B-3T [--from vote|compare]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { voteDir } from './vote.mjs';

const NAMES = { claude: 'Claude Code', geno: 'Geno', tie: 'tie' };

/** The vote code as { pair: 'A' | 'B' | 'T' }, refusing anything that does not name every pair exactly once. */
export function parseVotes(code, pairs) {
  const parts = String(code ?? '').trim().toUpperCase().split(/[\s,-]+/).filter(Boolean);
  const votes = {};
  for (const part of parts) {
    const m = /^([1-9])([ABT])$/.exec(part);
    if (!m) throw new Error(`"${part}" is not a vote: each one is a pair number then A, B or T, as in 1A-2B-3T`);
    if (votes[m[1]] !== undefined) throw new Error(`pair ${m[1]} is voted twice`);
    votes[m[1]] = m[2];
  }
  const missing = Array.from({ length: pairs }, (_, i) => String(i + 1)).filter((p) => votes[p] === undefined);
  const extra = Object.keys(votes).filter((p) => Number(p) > pairs);
  if (missing.length || extra.length) throw new Error(`the page has ${pairs} pairs: ${missing.length ? `no vote for ${missing.join(', ')}` : `no pair ${extra.join(', ')}`}`);
  return votes;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const { values } = parseArgs({ options: { round: { type: 'string', default: 'l1' }, votes: { type: 'string' }, from: { type: 'string', default: 'vote' } } });
  const FROM = { vote: 'the screenshots on the vote page', compare: 'the live pages on the compare page' };
  if (FROM[values.from] === undefined) {
    console.error(`--from must be vote or compare, got "${values.from}"`);
    process.exit(2);
  }
  const keyFile = path.join(voteDir(values.round), 'vote-key.json');
  if (!existsSync(keyFile)) {
    console.error(`no vote key for round ${values.round} at ${keyFile}: run the report stage first`);
    process.exit(2);
  }
  const key = JSON.parse(readFileSync(keyFile, 'utf8'));
  let votes;
  try {
    votes = parseVotes(values.votes, key.pairs.length);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const rows = key.pairs.map((p) => {
    const owner = votes[p.pair] === 'T' ? 'tie' : p[votes[p.pair]];
    return { pair: p.pair, owner, judge: p.judge, agree: owner === p.judge };
  });
  const agreed = rows.filter((r) => r.agree).length;
  const summary = `From ${FROM[values.from]}, after feedback: ${rows.map((r) => `pair ${r.pair} ${r.owner === 'tie' ? 'tie' : `${NAMES[r.owner]} run ${key.pairs.find((p) => p.pair === r.pair).n}`} (judge ${r.judge ? NAMES[r.judge] : 'not judged'})`).join(', ')}. The judge agrees on ${agreed} of ${rows.length} pairs.`;
  writeFileSync(path.join(voteDir(values.round), 'owner-votes.json'), `${JSON.stringify({ code: values.votes, from: values.from, rows, agreed, of: rows.length, summary }, null, 2)}\n`);
  console.log(summary);
}
