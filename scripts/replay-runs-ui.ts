// Plays every archived real-model run through the real chat panel and checks what a user would see, at no model cost.
// Each run's session log becomes the panel's actions with run-to-gallery.ts's pipeline (the engine's replayUpdates and
// the extension's session-updates.ts mapping). A running UI gallery serves the panel bundle.
// usage: GCODE_UI_PORT=5396 pnpm ui   (in another terminal)
//        pnpm tsx scripts/replay-runs-ui.ts [output folder] [--port 5396] [--only <substring>]
// It writes results.json, table.md and one screenshot per run and look into the output folder.
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Action } from '../packages/extension/src/chat/messages.js';
import { MODES } from '../packages/extension/test/webview/host.js';
import { readRun, REPO, RUNS } from './real-usecases/archived-run.js';
import { actionsOf } from './run-to-gallery.js';

const { chromium } = createRequire(path.join(REPO, 'packages/extension/package.json'))('playwright-core') as typeof import('playwright-core');

const args = process.argv.slice(2);
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const out = path.resolve(args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? 'scratchpad/replay-runs-ui');
const origin = `http://127.0.0.1:${flag('--port') ?? '5390'}`;
const only = flag('--only');
const LOOKS = [
  { name: 'dark-300', theme: 'dark', width: 300, detail: 'compact' },
  { name: 'light-420', theme: 'light', width: 420, detail: 'full' },
] as const;
/** Tools whose step means little without the thing it acted on. */
const NEEDS_TARGET = new Set(['read', 'edit', 'grep', 'glob', 'list', 'skill', 'agent', 'web_fetch', 'tool_search', 'bash_output', 'monitor', 'task_stop', 'todo']);

const runDirs = (dir: string): string[] =>
  existsSync(path.join(dir, 'case.json'))
    ? [dir]
    : readdirSync(dir)
        .map((f) => path.join(dir, f))
        .filter((f) => statSync(f).isDirectory())
        .flatMap(runDirs);

/** The run's actions moved in time to end now, as the gallery does, so turn clocks read their real length. */
function recent(actions: readonly Action[]): Action[] {
  const at = (a: Action) => ('at' in a && typeof a.at === 'number' ? [a.at] : []);
  const shift = Date.now() - Math.max(...actions.flatMap((a) => [...at(a), ...(a.type === 'child' ? at(a.action) : [])]));
  const moved = <T extends Action>(a: T): T => ('at' in a && typeof a.at === 'number' ? { ...a, at: a.at + shift } : a);
  return actions.map((a) => (a.type === 'child' ? { ...a, action: moved(a.action) } : moved(a)));
}

const harness = (query: string, width: number) => `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<script>window.__received=[];window.__gallery={attach(){},receive(f,m){window.__received.push(m)}};
window.__deliver=(m)=>{const v=document.querySelector('iframe').contentWindow;v.dispatchEvent(new v.MessageEvent('message',{data:v.structuredClone(m)}));};</script>
<iframe src="/panel.html?${query}" style="width:${width}px;height:1000px;border:0;display:block"></iframe></body></html>`;

/** What the panel shows, read inside its frame: overflow, cut text, steps, harness text and the last header. */
function inspect() {
  const width = document.documentElement.clientWidth;
  const shown = (e: Element) => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
  const inScroller = (e: Element) => {
    for (let p = e.parentElement; p; p = p.parentElement) if (['auto', 'scroll'].includes(getComputedStyle(p).overflowX)) return true;
    return false;
  };
  const named = (e: Element) => {
    for (let p: Element | null = e, i = 0; p && i < 4; p = p.parentElement, i++) if (p.getAttribute('title') || p.getAttribute('aria-label')) return true;
    return false;
  };
  const describe = (e: Element) => `${e.tagName.toLowerCase()}.${[...e.classList].slice(0, 2).join('.')} "${(e.textContent ?? '').trim().slice(0, 50)}"`;
  const all = [...document.querySelectorAll('body *')].filter(shown);
  const wide = all.filter((e) => e.getBoundingClientRect().right > width + 1 && getComputedStyle(e).position !== 'fixed' && !inScroller(e));
  const pastEdge = wide.filter((e) => !wide.some((o) => o !== e && o.contains(e))).slice(0, 6).map(describe);
  const cutText = all.filter((e) => getComputedStyle(e).textOverflow === 'ellipsis' && (e as HTMLElement).scrollWidth > (e as HTMLElement).clientWidth + 1 && !named(e)).slice(0, 6).map(describe);
  const steps = [...document.querySelectorAll('.calls')].filter(shown).map((s) => ({
    name: s.getAttribute('data-step') ?? '',
    verb: (s.querySelector('.step-verb, .command-title')?.textContent ?? '').trim(),
    target: (s.querySelector('.step-target')?.textContent ?? '').trim(),
    chips: s.querySelectorAll('.file-chip').length,
    failed: s.querySelector('.step-failed') !== null,
  }));
  const harnessText = [...document.querySelectorAll('.turn *')]
    .filter((e) => e.children.length === 0 && /^\[(abort|error|max-turns|max-cost)\]|\[exit code \d+\]|\[Geno\] Next time/.test((e.textContent ?? '').trim()))
    .slice(0, 4)
    .map((e) => (e.textContent ?? '').trim().slice(0, 100));
  const lastHead = ([...document.querySelectorAll('.turn-head')].at(-1)?.textContent ?? '').trim().replace(/\s+/g, ' ');
  for (const e of document.querySelectorAll('*')) if ((e as HTMLElement).scrollTop > 0) (e as HTMLElement).scrollTop = 0;
  return { pastEdge, cutText, steps, harnessText, lastHead, replacement: (document.body.innerText.match(/�/g) ?? []).length };
}

type Seen = ReturnType<typeof inspect>;
const thaiShare = (s: string) => (s.match(/[฀-๿]/g) ?? []).length / Math.max(1, (s.match(/[A-Za-z฀-๿]/g) ?? []).length);

/** The failed checks for one run in one look, each as a short line. */
function verdicts(seen: Seen, actions: readonly Action[], consoleErrors: readonly string[]): Record<string, string> {
  const failed: Record<string, string> = {};
  const prompts = actions.flatMap((a) => (a.type === 'turn-start' ? [a.prompt] : []));
  const texts = actions.flatMap((a) => (a.type === 'text' ? [a.text] : []));
  const raw = seen.steps.filter((s) => s.name !== 'bash' && (s.verb.includes('_') || s.verb === s.name));
  const bare = seen.steps.filter((s) => NEEDS_TARGET.has(s.name) && s.target === '' && s.chips === 0);
  if (consoleErrors.length > 0) failed['console'] = consoleErrors[0]!;
  if (seen.pastEdge.length > 0) failed['edge'] = seen.pastEdge.join(' | ');
  if (seen.cutText.length > 0) failed['cut'] = seen.cutText.join(' | ');
  if (seen.harnessText.length > 0 || seen.replacement > 0) failed['harness text'] = seen.harnessText.join(' | ');
  if (raw.length > 0) failed['raw label'] = [...new Set(raw.map((s) => s.verb))].join(', ');
  if (bare.length > 0) failed['no target'] = [...new Set(bare.map((s) => `${s.verb} (${s.name})`))].join(', ');
  if (prompts.some((p) => thaiShare(p) > 0.3) && thaiShare(texts.slice(-3).join(' ')) < 0.2) failed['Thai answer'] = 'a Thai prompt got a non-Thai answer';
  if (actions.findLastIndex((a) => a.type === 'tool' && 'name' in a) > actions.findLastIndex((a) => a.type === 'text')) failed['ends with answer'] = 'the turn ends on a tool step';
  return failed;
}

const CHECKS = ['console', 'edge', 'cut', 'harness text', 'raw label', 'no target', 'Thai answer', 'ends with answer'];

mkdirSync(path.join(out, 'shots'), { recursive: true });
const rows: { rel: string; name: string; error?: string; looks: Record<string, Seen & { failed: Record<string, string> }> }[] = [];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 520, height: 1000 } });
  const consoleErrors: string[] = [];
  page.on('console', (m) => void (m.type() === 'error' && consoleErrors.push(m.text().slice(0, 200))));
  page.on('pageerror', (e) => void consoleErrors.push(e.message.slice(0, 200)));
  await page.route(`${origin}/__replay/**`, (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({ contentType: 'text/html', body: harness(url.searchParams.toString(), Number(url.searchParams.get('width'))) });
  });
  for (const dir of runDirs(RUNS).sort()) {
    const rel = path.relative(RUNS, dir).split(path.sep).join('/');
    if (only !== undefined && !rel.includes(only)) continue;
    const name = rel.replace(/\//g, '__');
    let actions: Action[];
    try {
      actions = recent(actionsOf(readRun(dir)));
    } catch (error) {
      rows.push({ rel, name, error: String(error).slice(0, 200), looks: {} });
      continue;
    }
    const row: (typeof rows)[number] = { rel, name, looks: {} };
    for (const look of LOOKS) {
      consoleErrors.length = 0;
      await page.goto(`${origin}/__replay/?${new URLSearchParams({ theme: look.theme, style: 'glass', detail: look.detail, review: 'auto', motion: 'reduce', width: String(look.width) })}`);
      await page.waitForFunction(() => (window as any).__received.some((m: { type: string }) => m.type === 'ready'));
      const setup = [
        { type: 'roots', roots: [] },
        { type: 'reset', transcript: { model: 'qwen3.8-flash', turns: [] } },
        { type: 'header', header: { project: 'workspace', title: undefined, branch: undefined } },
        { type: 'window-focus', focused: true },
        { type: 'modes', modes: MODES },
        { type: 'commands', commands: [] },
      ];
      await page.evaluate(async (messages) => {
        for (const m of messages) {
          (window as any).__deliver(m);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }, [...setup, ...actions]);
      await page.waitForTimeout(900);
      const frame = page.frames().find((f) => f.url().includes('panel.html'))!;
      // tsx keeps function names with a helper the page lacks.
      await frame.evaluate('window.__name = (f) => f');
      const seen = await frame.evaluate(inspect);
      await page.waitForTimeout(250);
      await page.locator('iframe').screenshot({ path: path.join(out, 'shots', `${name}--${look.name}.png`) });
      row.looks[look.name] = { ...seen, failed: verdicts(seen, actions, consoleErrors) };
    }
    rows.push(row);
    console.log(`${rel}: ${Object.entries(row.looks).map(([look, l]) => `${look} ${Object.keys(l.failed).join(', ') || 'ok'}`).join('; ')}`);
  }
} finally {
  await browser.close();
}

writeFileSync(path.join(out, 'results.json'), JSON.stringify(rows, null, 1));
const table = [
  '| Run | Steps (full) | Chips | Failed steps | Last header | Checks passed | Failed checks |',
  '| --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map((r) => {
    if (r.error !== undefined) return `| ${r.rel} | | | | | not replayed | ${r.error} |`;
    const failed = CHECKS.filter((c) => Object.values(r.looks).some((l) => c in l.failed));
    const full = r.looks['light-420']!;
    return `| ${r.rel} | ${full.steps.length} | ${full.steps.reduce((n, s) => n + s.chips, 0)} | ${full.steps.filter((s) => s.failed).length} | ${full.lastHead.replace(/^Geno/, '')} | ${CHECKS.length - failed.length}/${CHECKS.length} | ${failed.join(', ') || 'none'} |`;
  }),
];
writeFileSync(path.join(out, 'table.md'), `${table.join('\n')}\n`);
console.log(`${rows.length} runs; ${rows.filter((r) => r.error !== undefined).length} not replayed; written to ${out}`);
