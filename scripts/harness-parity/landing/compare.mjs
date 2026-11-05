// Serves the blind compare page: each pair of the owner's vote, Claude Code run n against Geno run n, live in
// iframes at 375 and 1280, first round or after feedback. Page URLs name only the pair and the side (A or B), as
// the vote key shuffled them; /reveal.json names the harnesses and is fetched only when the owner asks.
// usage: node scripts/harness-parity/landing/compare.mjs [--round l1] [--port 4600]
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { RUNS_DIR } from '../paths.mjs';
import { pairVerdict } from './rules.mjs';
import { TASK_ID } from './task.mjs';
import { voteDir } from './vote.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const NAMES = { claude: 'Claude Code', geno: 'Geno', tie: 'tie' };

/**
 * The file a URL asks for, or why not: `/p/<pair>-<A|B>/<r1|r2>/<file>` maps to that run's page folder. Anything
 * that leaves the folder, names an unknown pair, side or round, or does not decode is refused.
 */
export function resolvePage(key, runsDir, url) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url, 'http://x').pathname);
  } catch {
    return { status: 400, message: 'the address does not decode' };
  }
  if (pathname.includes('\0')) return { status: 400, message: 'the address has a null byte' };
  const m = /^\/p\/(\d{1,2})-([AB])\/(r1|r2)(?:\/(.*))?$/.exec(pathname);
  if (!m) return { status: 404, message: 'pages are at /p/<pair>-<A|B>/<r1|r2>/' };
  const pair = key.pairs.find((p) => p.pair === Number(m[1]));
  if (!pair) return { status: 404, message: `there is no pair ${m[1]}` };
  const base = path.join(runsDir, `${TASK_ID}.${pair[m[2]]}.${pair.n}`, m[3]);
  const file = path.join(base, m[4] || 'index.html');
  const rel = path.relative(base, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { status: 403, message: 'that file is outside the page' };
  if (!existsSync(file) || !statSync(file).isFile()) return { status: 404, message: 'no such file in the page' };
  return { file };
}

/** Which harness each side is, and the judge's verdict on the pair in each round. */
export function revealOf(key, judged) {
  const verdict = (round, n) => {
    const ab = judged[`pair|${round}|c${n}|g${n}|AB|1`];
    const ba = judged[`pair|${round}|c${n}|g${n}|BA|1`];
    return ab && ba ? NAMES[pairVerdict(ab, ba)] : 'not judged';
  };
  return key.pairs.map((p) => ({ pair: p.pair, A: `${NAMES[p.A]} run ${p.n}`, B: `${NAMES[p.B]} run ${p.n}`, judge: { r1: verdict('r1', p.n), r2: verdict('r2', p.n) } }));
}

export function parsePort(value) {
  if (!/^\d{1,5}$/.test(String(value)) || Number(value) < 1 || Number(value) > 65535) throw new Error(`--port must be a whole number from 1 to 65535, got "${value}"`);
  return Number(value);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { round: { type: 'string', default: 'l1' }, port: { type: 'string', default: '4600' } } });
  let port;
  try {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(values.round)) throw new Error(`--round must be lowercase letters, digits and dashes, got "${values.round}"`);
    port = parsePort(values.port);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const keyFile = path.join(voteDir(values.round), 'vote-key.json');
  if (!existsSync(keyFile)) {
    console.error(`no vote key for round ${values.round} at ${keyFile}: run the report stage first`);
    process.exit(2);
  }
  const key = JSON.parse(readFileSync(keyFile, 'utf8'));
  const runsDir = path.join(RUNS_DIR, values.round);
  const judgedFile = path.join(runsDir, 'judge.json');
  const pairs = key.pairs.map((p) => ({ pair: p.pair }));
  const send = (res, status, type, body) => res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/') return send(res, 200, TYPES['.html'], readFileSync(path.join(HERE, 'compare.html')));
    if (pathname === '/pairs.json') return send(res, 200, TYPES['.json'], JSON.stringify({ round: values.round, pairs }));
    if (pathname === '/reveal.json') return send(res, 200, TYPES['.json'], JSON.stringify(revealOf(key, existsSync(judgedFile) ? JSON.parse(readFileSync(judgedFile, 'utf8')) : {})));
    const r = resolvePage(key, runsDir, req.url);
    if (r.file === undefined) return send(res, r.status, 'text/plain; charset=utf-8', r.message);
    res.writeHead(200, { 'content-type': TYPES[path.extname(r.file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(r.file).pipe(res);
  });
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `port ${port} is in use: pass another with --port` : error.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => console.log(`compare page: http://127.0.0.1:${port}/  (round ${values.round}, Ctrl-C to stop)`));
}
