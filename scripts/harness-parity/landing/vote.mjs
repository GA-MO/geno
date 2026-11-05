// The owner's blind vote: three pairs of final pages, Claude Code run n against Geno run n, sides shuffled once and
// kept in a key file apart from the page. The page shows a code to paste into agree.mjs.
import { randomInt } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPO } from '../../real-usecases/env.mjs';
import { pairVerdict } from './rules.mjs';

const VIEWS = [
  ['hero', 'First screen, 1280px'],
  ['desktop', 'Whole page, 1280px'],
  ['phone', 'Whole page, 375px'],
  ['motion', 'Motion: load, pointer on the hero, scroll'],
];

export const voteDir = (round) => path.join(REPO, 'docs/results', `landing-beancraft-${round}`);

const page = (pairs) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blind Page Vote</title>
<style>
  :root { --bg: #f6f5f2; --card: #fff; --ink: #1c1b19; --muted: #6b6862; --line: #e4e1da; --accent: #1c1b19; --pick: #2f6b4f; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Inter", system-ui, sans-serif; }
  header { padding: 28px 16px 8px; max-width: 1360px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
  header p { margin: 0; color: var(--muted); }
  main { max-width: 1360px; margin: 0 auto; padding: 8px 16px 120px; display: grid; gap: 28px; }
  .pair { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 16px; }
  .pair h2 { font-size: 16px; margin: 0 0 12px; display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .pair h2 span { color: var(--muted); font-weight: 500; font-size: 13px; }
  .switch { display: inline-flex; background: var(--bg); border: 1px solid var(--line); border-radius: 999px; padding: 3px; margin-bottom: 12px; }
  .switch button { border: 0; background: transparent; font: 600 14px system-ui; padding: 0 18px; min-height: 40px; border-radius: 999px; cursor: pointer; color: var(--muted); transition: background .15s, color .15s; }
  .switch button[aria-pressed="true"] { background: var(--card); color: var(--ink); box-shadow: 0 1px 3px rgb(0 0 0 / .12); }
  .sides { display: grid; gap: 16px; }
  .side h3 { font-size: 14px; margin: 0 0 8px; }
  .view { margin: 0 0 14px; }
  .view figcaption { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  .view img { width: 100%; display: block; border-radius: 8px; border: 1px solid var(--line); background: #eee; }
  .votes { display: grid; grid-template-columns: 1fr auto 1fr; gap: 8px; margin-top: 4px; }
  .votes button { min-height: 48px; border-radius: 12px; border: 1px solid var(--line); background: var(--card); font: 600 15px system-ui; cursor: pointer; transition: border-color .15s, background .15s, transform .1s; }
  .votes button:active { transform: scale(.98); }
  .votes button[aria-pressed="true"] { border-color: var(--pick); background: #eaf3ee; color: var(--pick); }
  .bar { position: fixed; left: 0; right: 0; bottom: 0; background: rgb(255 255 255 / .92); backdrop-filter: blur(8px); border-top: 1px solid var(--line); padding: 12px 16px; }
  .bar div { max-width: 1360px; margin: 0 auto; display: flex; gap: 12px; align-items: center; justify-content: space-between; }
  .bar code { font: 600 15px ui-monospace, Menlo, monospace; }
  .bar button { min-height: 44px; padding: 0 18px; border-radius: 12px; border: 0; background: var(--accent); color: #fff; font: 600 14px system-ui; cursor: pointer; }
  .bar button:disabled { opacity: .35; cursor: default; }
  @media (max-width: 899px) { .sides[data-show="A"] .side[data-side="B"], .sides[data-show="B"] .side[data-side="A"] { display: none; } }
  @media (min-width: 900px) { .switch { display: none; } .sides { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>
<header>
  <h1>Which landing page is better?</h1>
  <p>Same brief, same model, two harnesses. Judge as the client would: does it deliver the brief, does it look premium, does the layout hold at both widths.</p>
</header>
<main>
${pairs.map((p, i) => `  <section class="pair" data-pair="${i + 1}">
    <h2>Pair ${i + 1} <span>of ${pairs.length}</span></h2>
    <div class="switch" role="group" aria-label="Show page"><button aria-pressed="true" data-show="A">Page A</button><button aria-pressed="false" data-show="B">Page B</button></div>
    <div class="sides" data-show="A">
${['A', 'B'].map((s) => `      <div class="side" data-side="${s}"><h3>Page ${s}</h3>
${VIEWS.filter(([k]) => p[s][k]).map(([k, label]) => `        <figure class="view"><figcaption>${label}</figcaption><img src="${p[s][k]}" alt="Page ${s}, ${label}" loading="lazy"></figure>`).join('\n')}
      </div>`).join('\n')}
    </div>
    <div class="votes" role="group" aria-label="Your vote"><button data-vote="A">A is better</button><button data-vote="T">Tie</button><button data-vote="B">B is better</button></div>
  </section>`).join('\n')}
</main>
<div class="bar"><div><span>Your votes: <code id="code">none yet</code></span><button id="copy" disabled>Copy code</button></div></div>
<script>
  const KEY = 'blind-vote';
  let votes = {};
  try { votes = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
  const pairs = [...document.querySelectorAll('.pair')];
  const code = () => pairs.map((p) => p.dataset.pair + (votes[p.dataset.pair] || '?')).join('-');
  const render = () => {
    for (const p of pairs) for (const b of p.querySelectorAll('[data-vote]')) b.setAttribute('aria-pressed', String(votes[p.dataset.pair] === b.dataset.vote));
    const all = pairs.every((p) => votes[p.dataset.pair]);
    document.getElementById('code').textContent = Object.keys(votes).length ? code() : 'none yet';
    document.getElementById('copy').disabled = !all;
  };
  for (const p of pairs) {
    p.querySelector('.votes').addEventListener('click', (e) => {
      const b = e.target.closest('[data-vote]');
      if (!b) return;
      votes[p.dataset.pair] = b.dataset.vote;
      try { localStorage.setItem(KEY, JSON.stringify(votes)); } catch {}
      render();
    });
    p.querySelector('.switch').addEventListener('click', (e) => {
      const b = e.target.closest('[data-show]');
      if (!b) return;
      p.querySelector('.sides').dataset.show = b.dataset.show;
      for (const x of p.querySelectorAll('.switch button')) x.setAttribute('aria-pressed', String(x === b));
    });
  }
  document.getElementById('copy').addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(code()); e.target.textContent = 'Copied'; } catch { e.target.textContent = code(); }
    setTimeout(() => (e.target.textContent = 'Copy code'), 1600);
  });
  render();
</script>
</body>
</html>
`;

/** Copies each pair's four images next to the page, writes the page, and keeps the side key in its own file. */
export async function writeVotePage(round, pages, judged) {
  const dir = voteDir(round);
  mkdirSync(path.join(dir, 'img'), { recursive: true });
  const keyFile = path.join(dir, 'vote-key.json');
  const sheetsOf = (p) => (existsSync(path.join(p.dir, 'shots-r2', 'sheets.json')) ? JSON.parse(readFileSync(path.join(p.dir, 'shots-r2', 'sheets.json'), 'utf8')) : {});
  const ready = (p) => p !== undefined && sheetsOf(p).hero !== undefined;
  const runs = [...new Set(pages.map((p) => p.n))].filter((n) => ready(pages.find((p) => p.harness === 'claude' && p.n === n)) && ready(pages.find((p) => p.harness === 'geno' && p.n === n)));
  const old = existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, 'utf8')) : { pairs: [] };
  const key = { note: 'Which harness is Page A and Page B in each pair of vote.html. Do not open before voting.', pairs: [] };
  const shown = [];
  runs.forEach((n, i) => {
    const flip = old.pairs[i]?.n === n ? old.pairs[i].A === 'geno' : randomInt(2) === 1;
    const sides = { A: flip ? 'geno' : 'claude', B: flip ? 'claude' : 'geno' };
    const ab = judged[`pair|r2|c${n}|g${n}|AB|1`];
    const ba = judged[`pair|r2|c${n}|g${n}|BA|1`];
    key.pairs.push({ pair: i + 1, n, ...sides, judge: ab && ba ? pairVerdict(ab, ba) : null });
    const images = {};
    for (const s of ['A', 'B']) {
      const sheets = sheetsOf(pages.find((p) => p.harness === sides[s] && p.n === n));
      images[s] = {};
      for (const view of Object.keys(sheets)) {
        const name = `p${i + 1}-${s}-${view}.jpg`;
        copyFileSync(sheets[view], path.join(dir, 'img', name));
        images[s][view] = `img/${name}`;
      }
    }
    shown.push(images);
  });
  writeFileSync(keyFile, `${JSON.stringify(key, null, 2)}\n`);
  const file = path.join(dir, 'vote.html');
  writeFileSync(file, page(shown));
  return { page: file, key: keyFile, pairs: shown.length };
}
