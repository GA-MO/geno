// Writes the results doc for one round from what the stages left in its folder: the checks of every page, the
// judge's pairs, the feedback round, how each agent worked, the cost, and the verdict by the rule fixed before the
// run. Also writes the owner's blind vote page and its key.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { REPO } from '../../real-usecases/env.mjs';
import { CHECKS, CLS_MAX, FRAME_P95_MS, GROUPS, LCP_MS, LONG_FRAMES_MAX, feedbackFacts, groupSize, passed, regressions, score } from './checks.mjs';
import { ASKS, FEEDBACK, PROMPT } from './task.mjs';
import { decide, minJudgeWins, pairVerdict } from './rules.mjs';
import { roundsOf } from './logs.mjs';
import { writeVotePage } from './vote.mjs';

export const docPath = (round) => path.join(REPO, 'docs/results', `landing-beancraft-${round}.md`);

/** The rule, as it stood before the first run; the report repeats it word for word. */
export const RULES = `## Win rule (fixed before the run)

Every count below is over the final pages, after the feedback round, summed over the runs of a side. A side wins when all four hold:

1. It passes at least as many brief checks (ก) as the other side.
2. It passes at least as many quality checks (ข) as the other side.
3. It passes at least as many motion checks (ค) as the other side.
4. It wins at least 6 of the 9 judged pairs of final pages (two thirds of the pairs when the runs differ from 3).

Otherwise the result is a tie, and the cheaper side, by API dollars over both rounds, is named. A pair is won only when the judge picks the same side in both orders. A split, or a tie in either order, counts as a tie.`;

const method = (runs) => `## Method

Both harnesses get the same brief word for word, in an empty folder (\`~/Development/beancraft\` in a fresh HOME), on \`claude-sonnet-5-5\`. Claude Code runs \`claude -p --permission-mode auto\`, and Geno runs \`gcode agent --mode auto --browser\`. Both get the same headless browser server (chrome-devtools-mcp). The brief follows UI-Bench prompt #21, with the stack and motion asks added. When a request ends by handing work back, the simulated user answers "go on" up to twice. After the first request ends, the same session gets one feedback message. Each side builds the page ${runs} times.

A script scores each page after round 1 and after round 2, in headless Chrome on the Mac's GPU, with no model involved. cdnjs was reachable. The meter still serves GSAP from one in-memory copy fetched from cdnjs, so a page's LCP does not depend on the network. LCP and CLS are unthrottled local numbers. Smooth scroll is measured while a script wheels from top to bottom in 100px steps every 60ms. Pass lines: LCP within ${LCP_MS}ms at 375px, CLS at most ${CLS_MAX}, p95 frame within ${FRAME_P95_MS}ms with at most ${LONG_FRAMES_MAX} frames over 33ms. A check passes only when it saw the thing work, so an empty page fails "no sideways scroll" too.

The judge is \`claude-opus-5-5\` and sees screenshots only: the first screen at 1280px, the whole page at 1280px and at 375px, and a strip of motion frames (load, pointer on the hero, scroll to the bottom). It scores each page on brief fit (40), beauty (30) and layout (30). Every Claude Code page meets every Geno page (3 × 3 = 9 pairs), in both orders, for the first and the final pages. The 9 final pairs are judged a second time to measure how stable the judge is. For round 2 the judge also sees each page before and after and says whether each of the three asks was fixed.

The brief:

\`\`\`
${PROMPT}
\`\`\`

The feedback:

\`\`\`
${FEEDBACK}
\`\`\``;

const mark = (s) => (s === undefined ? '-' : s.pass ? '✓' : '✗');
const money = (n) => `$${n.toFixed(2)}`;
const secs = (ms) => `${Math.round(ms / 1000)}s`;
const ktok = (u) => `${Math.round(((u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0)) / 1000)}k`;
const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined);
const NAMES = { claude: 'Claude Code', geno: 'Geno' };

/** Before the first run: the doc with the method and the rule, and no results. */
export function writeRulesOnly(round) {
  writeFileSync(docPath(round), `# Landing page bake-off: Geno vs Claude Code (${round})\n\nResults pending: the run had not started when this was written.\n\n${RULES}\n\n${method(3)}\n`);
}

export async function writeReport({ round, dir, jobs, model, budget, spentUsd, judged, problems }) {
  const pages = jobs.map((job) => {
    const record = readJson(path.join(job.dir, 'record.json'));
    const m = { r1: readJson(path.join(job.dir, 'shots-r1', 'measures.json')), r2: readJson(path.join(job.dir, 'shots-r2', 'measures.json')) };
    // A finished run whose page was never measured scores as all-fail, so it loses instead of stalling the verdict.
    const scoreOf = (x) => (x ? score(x) : record ? score({ fatal: 'not measured' }) : undefined);
    // Cost and working counts come from the run's logs, not the record, so a fix to their counting reaches old runs.
    const rounds = record ? roundsOf(job.dir, job.harness).map((r, i) => ({ ...record.rounds[i], ...r })) : undefined;
    return { ...job, label: `${job.harness === 'claude' ? 'C' : 'G'}${job.n}`, record: record && { ...record, rounds }, m, scores: { r1: scoreOf(m.r1), r2: scoreOf(m.r2) } };
  });
  const done = pages.filter((p) => p.record && p.scores.r2);
  const side = (h) => done.filter((p) => p.harness === h);
  const lines = [`# Landing page bake-off: Geno vs Claude Code (${round})`, ''];

  // Judge pairs.
  const claude = pages.filter((p) => p.harness === 'claude');
  const geno = pages.filter((p) => p.harness === 'geno');
  const pairs = claude.flatMap((c) => geno.map((g) => ({ c, g })));
  const verdictOf = (r, c, g, rep = 1) => {
    const ab = judged[`pair|${r}|c${c.n}|g${g.n}|AB|${rep}`];
    const ba = judged[`pair|${r}|c${c.n}|g${g.n}|BA|${rep}`];
    return ab && ba ? { winner: pairVerdict(ab, ba), ab, ba } : undefined;
  };
  const wins = (r, h) => pairs.filter(({ c, g }) => verdictOf(r, c, g)?.winner === h).length;
  const judgedCount = (r) => pairs.filter(({ c, g }) => verdictOf(r, c, g)).length;
  const sum = (h, group, r = 'r2') => side(h).reduce((s, p) => s + passed(p.scores[r], group), 0);
  const cost = (h) => side(h).reduce((s, p) => s + p.record.rounds.reduce((t, x) => t + x.costUsd, 0), 0);
  const sides = Object.fromEntries(['claude', 'geno'].map((h) => [h, { brief: sum(h, 'brief'), quality: sum(h, 'quality'), motion: sum(h, 'motion'), judgeWins: wins('r2', h), costUsd: cost(h) }]));
  const complete = side('claude').length === claude.length && side('geno').length === geno.length && judgedCount('r2') === pairs.length && pairs.length > 0;
  const verdict = decide(sides, pairs.length);

  lines.push('## Verdict', '');
  if (!complete) lines.push(`Incomplete: ${done.length} of ${pages.length} runs finished and ${judgedCount('r2')} of ${pairs.length} final pairs were judged, so the rule is not applied.`, '');
  else {
    const cheaper = verdict.cheaper === 'same' ? 'Both cost the same.' : `${NAMES[verdict.cheaper]} was cheaper (${money(sides[verdict.cheaper].costUsd)} against ${money(sides[verdict.cheaper === 'claude' ? 'geno' : 'claude'].costUsd)}).`;
    lines.push(verdict.winner === 'tie' ? `**Tie** by the rule below. ${cheaper}` : `**${NAMES[verdict.winner]} wins** by the rule below. ${cheaper}`, '');
  }
  const need = minJudgeWins(pairs.length);
  lines.push('| | Claude Code | Geno | needed to win |', '|---|---|---|---|');
  for (const g of ['brief', 'quality', 'motion']) lines.push(`| ${GROUPS[g]} checks passed (final) | ${sides.claude[g]}/${groupSize(g) * claude.length} | ${sides.geno[g]}/${groupSize(g) * geno.length} | at least the other's |`);
  lines.push(`| judged pairs won (final) | ${sides.claude.judgeWins}/${pairs.length} | ${sides.geno.judgeWins}/${pairs.length} | ${need} |`);
  lines.push(`| API cost, both rounds | ${money(sides.claude.costUsd)} | ${money(sides.geno.costUsd)} | tie-break |`, '');
  lines.push(`API credit spent this round, judge and hand-back reader included: ${money(spentUsd)} of the ${money(budget)} budget. Runner model: \`${model}\`.`, '');
  if (problems.length > 0) lines.push('Problems in this run:', '', ...problems.map((p) => `- ${p}`), '');

  lines.push(RULES, '');
  const notes = path.join(path.dirname(docPath(round)), `landing-beancraft-${round}`, 'notes.md');
  if (existsSync(notes)) lines.push(readFileSync(notes, 'utf8').trim(), '');

  // Meter calibration.
  const cal = readJson(path.join(dir, 'calibration.json'));
  if (cal) {
    lines.push('## The meter on its fixtures', '', 'Checked before the runs. The reference page under `scripts/harness-parity/landing/fixtures/` does all the brief asks; the agents never see it.', '', '| fixture | checks passed | what it shows |', '|---|---|---|');
    const what = { reference: 'a page that does everything', blank: 'an empty page', missing: 'a folder with no index.html', hostile: 'a dialog, a stored preference, an outside font, an error, a pin, and a hang under reduced motion' };
    for (const [name, r] of Object.entries(cal).filter(([k]) => k !== 'off')) lines.push(`| ${name} | ${r.passed}/${r.of} | ${what[name]} |`);
    lines.push('');
  }

  // Checks per page.
  lines.push('## Checks per page', '', `C is Claude Code, G is Geno. Each cell is round 1 then the final page.`, '', `| check | ${pages.map((p) => p.label).join(' | ')} |`, `|---|${pages.map(() => '---').join('|')}|`);
  for (const c of CHECKS) lines.push(`| ${GROUPS[c.group].split(' ')[0]} ${c.label} | ${pages.map((p) => `${mark(p.scores.r1?.[c.id])}${mark(p.scores.r2?.[c.id])}`).join(' | ')} |`);
  for (const g of ['brief', 'quality', 'motion']) lines.push(`| **${GROUPS[g]} total** | ${pages.map((p) => (p.scores.r2 ? `${passed(p.scores.r1, g)}→${passed(p.scores.r2, g)}` : '-')).join(' | ')} |`);
  lines.push('');
  const failing = pages.flatMap((p) => (p.scores.r2 ? Object.entries(p.scores.r2).filter(([, s]) => !s.pass).map(([id, s]) => `- ${p.label} ${id}: ${s.detail}`) : []));
  if (failing.length > 0) lines.push('Why the final pages failed:', '', ...failing, '');

  // Judge.
  const matrix = (r, rep = 1) => {
    const out = [`| | ${geno.map((g) => g.label).join(' | ')} |`, `|---|${geno.map(() => '---').join('|')}|`];
    for (const c of claude) out.push(`| ${c.label} | ${geno.map((g) => { const v = verdictOf(r, c, g, rep); return v ? `${v.winner === 'tie' ? 'tie' : NAMES[v.winner]} (${v.ab.totals.join('/')}, ${v.ba.totals.join('/')})` : '-'; }).join(' | ')} |`);
    return out;
  };
  lines.push('## Judge', '', 'Each cell names the pair\'s winner, then the weighted totals of the first and second page shown in each order (Claude Code first, then Geno first).', '');
  lines.push(`### Final pages: Claude Code ${wins('r2', 'claude')}, Geno ${wins('r2', 'geno')}, tie ${judgedCount('r2') - wins('r2', 'claude') - wins('r2', 'geno')}`, '', ...matrix('r2'), '');
  lines.push(`### Round 1 pages: Claude Code ${wins('r1', 'claude')}, Geno ${wins('r1', 'geno')}, tie ${judgedCount('r1') - wins('r1', 'claude') - wins('r1', 'geno')}`, '', ...matrix('r1'), '');
  const again = pairs.filter(({ c, g }) => verdictOf('r2', c, g, 2));
  if (again.length > 0) {
    const same = again.filter(({ c, g }) => verdictOf('r2', c, g, 2).winner === verdictOf('r2', c, g).winner).length;
    const orders = again.flatMap(({ c, g }) => ['AB', 'BA'].map((o) => judged[`pair|r2|c${c.n}|g${g.n}|${o}|1`].winner === judged[`pair|r2|c${c.n}|g${g.n}|${o}|2`].winner));
    const agreeOrders = pairs.filter(({ c, g }) => { const v = verdictOf('r2', c, g); return v && v.ab.winner !== 'tie' && pairVerdict(v.ab, v.ba) !== 'tie'; }).length;
    lines.push('### How stable the judge is', '', `The ${again.length} final pairs judged a second time got the same pair verdict ${same} of ${again.length} times, and the same pick in a given order ${orders.filter(Boolean).length} of ${orders.length} times. In the first judging, both orders agreed on a winner in ${agreeOrders} of ${judgedCount('r2')} pairs.`, '', ...matrix('r2', 2), '');
  }
  const via = [...new Set(Object.values(judged).map((j) => j.via))];
  if (via.length > 0) lines.push(`The judge ran through ${via.map((v) => (v === 'api' ? 'the Messages API' : "the Claude Code CLI on the owner's sign-in")).join(' and ')}.`, '');

  // Round 2.
  lines.push('## The feedback round', '', `Diff is index.html lines added and removed against round 1, and the share of round 1's lines removed. Fixed is the judge's read of the three asks (${Object.keys(ASKS).join(', ')}): yes, partly or no. Gap spread is the standard deviation of the gaps between sections at 375px over their mean, before and after. Price is the smallest price font size and its contrast at 375px.`, '');
  lines.push('| page | diff | broke | fixed | kept the rest | gap spread | price |', '|---|---|---|---|---|---|---|');
  for (const p of done) {
    const d = p.record.rounds[1].diff;
    const broke = regressions(p.scores.r1, p.scores.r2);
    const fix = judged[`fix|${p.harness}${p.n}`];
    const [f1, f2] = [feedbackFacts(p.m.r1), feedbackFacts(p.m.r2)];
    const fixed = fix === undefined ? '-' : fix.forfeit ? 'no page' : Object.keys(ASKS).map((k) => fix[k]).join(', ');
    const kept = fix === undefined || fix.forfeit ? '-' : fix.kept ? 'yes' : 'no';
    lines.push(`| ${p.label} | +${d.added} −${d.removed} (${d.share === null ? '-' : `${Math.round(d.share * 100)}%`}) | ${broke.length}${broke.length ? ` (${broke.join(', ')})` : ''} | ${fixed} | ${kept} | ${f1.gapSpread ?? '-'} → ${f2.gapSpread ?? '-'} | ${f1.priceFontPx ?? '-'}px ${f1.priceContrast ?? '-'}:1 → ${f2.priceFontPx ?? '-'}px ${f2.priceContrast ?? '-'}:1 |`);
  }
  lines.push('');

  // Behaviour and cost.
  lines.push('## How each agent worked', '', 'Per round (1 / 2). Shots are screenshots it took of its own work. Edits against writes counts edit calls and whole-file writes, and rewrites are writes over a file that was already there. Shell changes are file changes made from bash: a heredoc, a sed, or a Python replace script. The diff share in the feedback table tells a spot fix from a rewrite. Hand-backs are segments that ended without finishing, each answered with "go on".', '');
  lines.push('| page | shots | edits / writes (rewrites) | shell changes | tool errors | model calls | hand-backs |', '|---|---|---|---|---|---|---|');
  for (const p of pages.filter((x) => x.record)) {
    const [a, b] = p.record.rounds;
    const hb = (r) => r.ends.filter((e) => e.kind !== 'done').length;
    lines.push(`| ${p.label} | ${a.behaviour.screenshots} / ${b.behaviour.screenshots} | ${a.behaviour.edits}/${a.behaviour.writes} (${a.behaviour.rewrites}) · ${b.behaviour.edits}/${b.behaviour.writes} (${b.behaviour.rewrites}) | ${a.behaviour.shellWrites} / ${b.behaviour.shellWrites} | ${a.behaviour.toolErrors} / ${b.behaviour.toolErrors} | ${a.modelCalls} / ${b.modelCalls} | ${hb(a)} / ${hb(b)} |`);
  }
  lines.push('', '## Cost', '', '| page | round 1 | round 2 |', '|---|---|---|');
  for (const p of pages.filter((x) => x.record)) lines.push(`| ${p.label} | ${p.record.rounds.map((r) => `${money(r.costUsd)} · ${secs(r.ms)} · ${ktok(r.usage)} tokens`).join(' | ')} |`);
  lines.push('');

  const vote = await writeVotePage(round, pages, judged);
  lines.push('## Owner vote', '', `A blind page of ${vote.pairs} pairs of final pages, sides shuffled: [${path.relative(path.dirname(docPath(round)), vote.page)}](${path.relative(path.dirname(docPath(round)), vote.page)}). The key is kept apart in \`${path.relative(REPO, vote.key)}\`. After voting, \`node scripts/harness-parity/landing/agree.mjs --round ${round} --votes <the code the page shows>\` says how many pairs the judge and the owner agree on.`, '');
  const owner = readJson(path.join(path.dirname(vote.key), 'owner-votes.json'));
  if (owner) lines.push(`The owner voted: ${owner.summary}`, '');

  lines.push(method(claude.length), '');
  lines.push(`Run folders: \`${dir}\`.`, '');
  writeFileSync(docPath(round), `${lines.join('\n')}\n`);
  console.log(`wrote ${path.relative(REPO, docPath(round))}`);
}
