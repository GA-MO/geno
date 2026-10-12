/**
 * Drives the tour's motion in Chromium in both views. On each page: a step to the next beat must start motion whose
 * dot ends on the receiver (the frames go to the output folder), ten fast → presses must land ten beats on with no
 * stale animation left running, Space must play and stop, play must wait at a fork, and with reduced motion a step
 * must start no animation at all. Fails on any console error.
 * Usage: pnpm --filter @g-code/docs motion [base-url] [out-dir] [page ...]
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const [base = 'http://localhost:4346', out = path.join(process.env['TMPDIR'] ?? '/tmp', 'docs-motion'), ...named] = process.argv.slice(2);
const pages = named.length > 0 ? named : ['/foundations/agent-loop/', '/scenarios/perm/ask-mode-bash-approval/', '/scenarios/sub/blocking-report/'];
const VIEWS = ['Sequence', 'Swim lane'] as const;
mkdirSync(out, { recursive: true });

const problems: string[] = [];
const file = (label: string, frame: string) => path.join(out, `${label.replace(/\W+/g, '-').replace(/^-|-$/g, '')}-${frame}.png`);
const fail = (where: string, problem: string): void => void problems.push(`${where}\n  ${problem}`);

async function open(browser: Browser, url: string, view: string, reducedMotion: 'reduce' | 'no-preference', video = false): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion, ...(video ? { recordVideo: { dir: out, size: { width: 1440, height: 900 } } } : {}) });
  const page = await context.newPage();
  page.on('console', (message) => message.type() === 'error' && fail(`${url} ${view}`, `console: ${message.text()}`));
  page.on('pageerror', (error) => fail(`${url} ${view}`, `page error: ${error.message}`));
  await page.goto(`${base}${url}`);
  await page.waitForSelector('.story-page[data-hydrated]');
  await page.getByRole('tab', { name: view }).click();
  await page.waitForTimeout(300);
  return page;
}

const position = (page: Page) => page.locator('.read .count').innerText().then((text) => text.match(/\d+/g)!.map(Number) as [number, number]);

/** Web Animations the tour started (CSS spinners in the mocks are not motion this checks). */
function scripted(): { readonly target: string; readonly tagged: boolean }[] {
  return document
    .getAnimations()
    .filter((animation) => !(animation instanceof CSSAnimation) && !(animation instanceof CSSTransition) && animation.playState !== 'finished')
    .map((animation) => {
      const target = (animation.effect as KeyframeEffect).target!;
      return { target: `${target.tagName.toLowerCase()}.${String(target.getAttribute('class')).split(' ')[0]}`, tagged: target.closest('[data-mo]') !== null && target.isConnected };
    });
}

async function stepFrames(page: Page, label: string): Promise<void> {
  await page.keyboard.press('ArrowRight');
  const ride = await page.evaluate(() => {
    const animations = document.getAnimations().filter((animation) => !(animation instanceof CSSAnimation) && !(animation instanceof CSSTransition));
    for (const animation of animations) animation.pause();
    const found = animations.find((animation) => (animation.effect as KeyframeEffect).target!.matches('.mo-dot, .sq-ride'));
    return found === undefined ? undefined : { duration: Number(found.effect!.getTiming().duration), count: animations.length };
  });
  if (ride === undefined) return fail(label, 'stepping to the next beat started no dot');
  const drawn = await page.evaluate(() => [...document.querySelectorAll('.ln-svg path[data-mo="draw-path"]')].filter((path) => path.getAnimations().length > 0).map((path) => path.getAttribute('d')));
  const heads = () => page.evaluate((ds) => [...document.querySelectorAll('.ln-svg path[data-mo="draw-path"]')].filter((path) => ds.includes(path.getAttribute('d'))).map((path) => getComputedStyle(path).markerEnd), drawn);
  for (const [k, fraction] of [0, 0.25, 0.5, 0.75, 1].entries()) {
    await page.evaluate((time) => {
      for (const animation of document.getAnimations()) if (!(animation instanceof CSSAnimation) && !(animation instanceof CSSTransition)) animation.currentTime = time;
    }, Math.min(ride.duration * fraction, ride.duration - 1));
    await page.locator('.story-body > section').screenshot({ path: file(label, String(k)) });
    if (fraction === 0.5 && (await heads()).some((head) => head !== 'none')) fail(label, 'an arrowhead shows before its line reaches it');
  }
  const landed = await page.evaluate(() => {
    const dot = document.querySelector('.sq-row.current .mo-dot, .ln-svg .mo-dot')!.getBoundingClientRect();
    const receiver = document.querySelector('.sq-row.current .sq-tip, .ln-recv.current, .ln-diamond.current') ?? document.querySelector('.ln-node.current');
    const box = receiver!.getBoundingClientRect();
    const x = dot.left + dot.width / 2;
    const y = dot.top + dot.height / 2;
    return { inside: x >= box.left - 6 && x <= box.right + 6 && y >= box.top - 6 && y <= box.bottom + 6, dot: [Math.round(x), Math.round(y)], box: [Math.round(box.left), Math.round(box.top), Math.round(box.right), Math.round(box.bottom)] };
  });
  if (!landed.inside) fail(label, `the dot ends at ${landed.dot} outside the receiver ${landed.box}`);
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) animation.play();
  });
  await page.waitForTimeout(1_000);
  if ((await heads()).some((head) => !head.startsWith('url('))) fail(label, 'an arrowhead stays hidden after its line is drawn');
}

async function rapid(page: Page, label: string): Promise<void> {
  const [from, total] = await position(page);
  for (let k = 0; k < 10; k++) await page.keyboard.press('ArrowRight');
  const pressed = Date.now();
  const [at] = await position(page);
  const lag = Date.now() - pressed;
  const want = Math.min(from + 10, total);
  if (at !== want) fail(label, `10 fast → presses from beat ${from} landed on ${at}, not ${want}`);
  if (lag > 100) fail(label, `the beat count took ${lag}ms to read after the presses`);
  const stale = (await page.evaluate(scripted)).filter((animation) => !animation.tagged);
  if (stale.length > 0) fail(label, `animations still run on untagged elements: ${stale.map((animation) => animation.target).join(', ')}`);
  const running = (await page.evaluate(scripted)).length;
  const pulse = await page.evaluate(() => document.getAnimations().some((animation) => (animation.effect as KeyframeEffect).pseudoElement === '::after' && (animation.effect as KeyframeEffect).target!.closest('[data-mo="end"]') !== null));
  if (at === total && (await page.locator('.read .end-row').count()) > 0 && !pulse) fail(label, 'reaching the end did not pulse the end node');
  console.log(`${label}: 10 presses ${from} -> ${at}/${total}, ${running} animation(s) running, read after ${lag}ms`);
}

async function play(page: Page, label: string): Promise<void> {
  await page.evaluate(() => (location.hash = ''));
  await page.reload();
  await page.waitForSelector('.story-page[data-hydrated]');
  const [first] = await position(page);
  await page.keyboard.press(' ');
  if ((await page.locator('.btn.play').getAttribute('aria-pressed')) !== 'true') return fail(label, 'Space did not start play');
  await page.waitForFunction((from) => Number(document.querySelector('.read .count')!.textContent!.match(/\d+/)![0]) > from, first, { timeout: 12_000 }).catch(() => fail(label, 'play did not move past the first beat in 12s'));
  await page.keyboard.press(' ');
  if ((await page.locator('.btn.play').getAttribute('aria-pressed')) !== 'false') fail(label, 'Space did not stop play');
  const fork = await page.evaluate(() => document.querySelectorAll('.read .fork-option').length);
  for (let guard = 0; guard < 40 && (await page.locator('.read .fork-option').count()) === 0 && (await page.locator('.read .btn.primary').count()) > 0; guard++) await page.keyboard.press('ArrowRight');
  if ((await page.locator('.read .fork-option').count()) === 0 && fork === 0) return;
  const [at] = await position(page);
  await page.keyboard.press(' ');
  await page.waitForTimeout(3_000);
  const [still] = await position(page);
  if (still !== at) fail(label, `play left the fork at beat ${at} for ${still} without a pick`);
  await page.locator('.read .fork-option:not([aria-pressed="true"])').first().click();
  await page.locator('.story-body > section').screenshot({ path: file(label, 'picked') });
  await page.keyboard.press(' ');
  console.log(`${label}: play moved on, then waited at the fork on beat ${at}`);
  for (let guard = 0; guard < 40 && (await position(page))[0] < (await position(page))[1] - 1; guard++) await page.keyboard.press('ArrowRight');
  const [last, total] = await position(page);
  if ((await page.locator('.read .fork-option').count()) > 0 || last !== total - 1) return;
  await page.keyboard.press(' ');
  await page.waitForFunction(() => document.querySelector('.btn.play')!.getAttribute('aria-pressed') === 'false', undefined, { timeout: 12_000 }).catch(() => fail(label, 'play did not stop at the end'));
  if ((await position(page))[0] !== total) fail(label, `play stopped on beat ${(await position(page))[0]}, not the last beat ${total}`);
}

async function reduced(browser: Browser, url: string, view: string): Promise<void> {
  const label = `${url} ${view} reduced`;
  const page = await open(browser, url, view, 'reduce');
  await page.keyboard.press('ArrowRight');
  const running = await page.evaluate(scripted);
  if (running.length > 0) fail(label, `reduced motion still started ${running.length} animation(s): ${running.map((animation) => animation.target).join(', ')}`);
  await page.context().close();
}

const browser = await chromium.launch();
for (const url of pages)
  for (const view of VIEWS) {
    const label = `${url} ${view}`;
    const page = await open(browser, url, view, 'no-preference', url === pages[0]);
    await stepFrames(page, label);
    await page.waitForTimeout(800);
    await rapid(page, label);
    await play(page, label);
    await page.context().close();
    await reduced(browser, url, view);
  }
await browser.close();
for (const problem of problems) console.log(problem);
console.log(`motion: ${pages.length} page(s), ${VIEWS.length} views, frames and video in ${out}, ${problems.length} problem(s)`);
process.exitCode = problems.length === 0 ? 0 : 1;
