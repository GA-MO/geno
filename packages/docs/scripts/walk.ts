/**
 * Walks story tours in Chromium the way a reader does: both views, every branch to its end, at desktop and phone
 * widths. Fails on text that spills out of its box, a page wider than the window, a lane node taller than its lane,
 * a lane node narrower than 200px or whose title needs more than 2 lines, a lane item showing under the lane names, a
 * current beat outside the visible lanes, a reading card whose title sits below the fold of an unscrolled page at
 * 1440, or a console error. Usage: pnpm --filter @g-code/docs walk [base-url] [page ...]
 */
import { chromium, type Page } from 'playwright';

const [base = 'http://localhost:4330', ...named] = process.argv.slice(2);
const pages = named.length > 0 ? named : ['/scenarios/perm/ask-mode-bash-approval/', '/scenarios/turn/with-tools/', '/scenarios/sub/blocking-report/'];
const SIZES = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];

interface Finding {
  readonly where: string;
  readonly problem: string;
}

function audit(): string[] {
  const problems: string[] = [];
  // Text for screen readers only (the anchor link's "Section titled …") is clipped to nothing on purpose; take it out
  // while measuring.
  const unseen = [...document.querySelectorAll<HTMLElement>('main *')].filter((element) => {
    const style = getComputedStyle(element);
    return style.position === 'absolute' && (/^rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)$/.test(style.clip) || style.clipPath === 'inset(50%)');
  });
  const displays = unseen.map((element) => element.style.display);
  for (const element of unseen) element.style.display = 'none';
  for (const element of document.querySelectorAll<HTMLElement>('main *')) {
    if (element.closest('svg') !== null) continue;
    const style = getComputedStyle(element);
    if (style.display === 'none' || element.clientWidth === 0) continue;
    const scrolls = style.overflowX === 'auto' || style.overflowX === 'scroll';
    if (scrolls || element.scrollWidth <= element.clientWidth + 1) continue;
    // scrollWidth also counts a ::before/::after hit area (a heading's anchor link has one), so a spill must show as
    // text drawn past the box. Only text counts: Fumadocs pulls its chevrons a few pixels outside their row on purpose.
    // (No named helpers in here: the bundler's __name does not exist in the page.)
    const box = element.getBoundingClientRect();
    const texts = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const rects: DOMRect[] = [];
    for (let text = texts.nextNode(); text !== null; text = texts.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(text);
      rects.push(...range.getClientRects());
    }
    if (rects.some((rect) => rect.width > 0 && (rect.right > box.right + 1 || rect.left < box.left - 1))) problems.push(`text spills out of ${element.tagName.toLowerCase()}.${String(element.className).split(' ')[0]}: "${element.textContent?.slice(0, 40)}"`);
  }
  unseen.forEach((element, i) => (element.style.display = displays[i]!));
  if (document.documentElement.scrollWidth > document.documentElement.clientWidth) problems.push(`the page is ${document.documentElement.scrollWidth}px wide in a ${document.documentElement.clientWidth}px window`);
  const lane = document.querySelector<HTMLElement>('.ln-band');
  if (lane !== null) {
    const captions = [...document.querySelectorAll<HTMLElement>('.ln-caption')].map((caption) => caption.getBoundingClientRect());
    const bands = [...document.querySelectorAll<HTMLElement>('.ln-band')].map((band) => band.getBoundingClientRect());
    const scroller = document.querySelector<HTMLElement>('.ln-scroll')!;
    const shown = scroller.getBoundingClientRect();
    for (const node of document.querySelectorAll<HTMLElement>('.ln-node, .ln-chip, .ln-end, .ln-diamond, .ln-recv')) {
      const box = node.getBoundingClientRect();
      const name = node.textContent?.slice(0, 40) || node.getAttribute('aria-label')?.slice(0, 40);
      if (!bands.some((band) => box.top >= band.top - 0.5 && box.bottom <= band.bottom + 0.5)) problems.push(`lane item "${name}" (${Math.round(box.height)}px) does not fit inside its lane`);
      // What the reader sees of an item is the part inside the scrolling lanes.
      const left = Math.max(box.left, shown.left);
      const right = Math.min(box.right, shown.right);
      if (left < right && captions.some((caption) => left < caption.right && caption.left < right && box.top < caption.bottom && caption.top < box.bottom)) problems.push(`lane item "${name}" shows under a lane name`);
      if (!node.classList.contains('ln-node')) continue;
      if (box.width < 200) problems.push(`lane node "${name}" is ${Math.round(box.width)}px wide`);
      const title = node.querySelector<HTMLElement>('.ln-t')!;
      if (title.scrollHeight > title.clientHeight + 1 || title.clientHeight > 2.5 * parseFloat(getComputedStyle(title).lineHeight)) problems.push(`lane node "${name}" needs more than 2 lines`);
    }
    const current = document.querySelector<HTMLElement>('.ln-node.current, .ln-diamond.current');
    if (current !== null) {
      const box = current.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      if (box.left < view.left - 1 || box.right > view.right + 1) problems.push(`the current beat "${current.textContent?.slice(0, 40)}" is outside the visible lanes`);
    }
  }
  return problems;
}

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(450);
}

async function walkView(page: Page, url: string, view: string, width: number, findings: Finding[]): Promise<number> {
  const where = (beat: string) => `${url} ${view} @${width} ${beat}`;
  await page.goto(`${base}${url}`);
  await page.waitForSelector('.story');
  await page.getByRole('tab', { name: view }).click();
  await settle(page);
  let options = 1;
  let walked = 0;
  for (let option = 0; option < options; option++) {
    await page.goto(`${base}${url}`);
    await page.waitForSelector('.story');
    await settle(page);
    for (let guard = 0; guard < 40; guard++) {
      const title = await page.locator('.read .bt').innerText();
      for (const problem of await page.evaluate(audit)) findings.push({ where: where(title), problem });
      if (width >= 1440) {
        const card = await page.evaluate(() => ({ title: document.querySelector('.read .bt')!.getBoundingClientRect().bottom + scrollY, fold: innerHeight }));
        if (card.title > card.fold) findings.push({ where: where(title), problem: `the reading card's title ends at ${Math.round(card.title)}px, below the ${card.fold}px fold` });
      }
      walked++;
      ends.add(`${url} ${view} @${width}: ${await page.evaluate(() => document.querySelector('.read .end-row')?.textContent ?? '')}`);
      const fork = page.locator('.read .fork-option');
      if ((await fork.count()) > 0 && guard < 39) {
        options = Math.max(options, await fork.count());
        const target = fork.nth(Math.min(option, (await fork.count()) - 1));
        if ((await target.getAttribute('aria-pressed')) !== 'true') {
          await target.click();
          await settle(page);
          continue;
        }
      }
      const next = page.locator('.read .btn.primary');
      if ((await next.count()) === 0) break;
      await page.keyboard.press('ArrowRight');
      await settle(page);
    }
  }
  return walked;
}

const browser = await chromium.launch();
const findings: Finding[] = [];
let beats = 0;
const ends = new Set<string>();
for (const size of SIZES) {
  const context = await browser.newContext({ viewport: size });
  const page = await context.newPage();
  page.on('console', (message) => message.type() === 'error' && findings.push({ where: `${page.url()} @${size.width}`, problem: `console: ${message.text()}` }));
  page.on('pageerror', (error) => findings.push({ where: `${page.url()} @${size.width}`, problem: `page error: ${error.message}` }));
  for (const url of pages) for (const view of ['Sequence', 'Swim lane']) beats += await walkView(page, url, view, size.width, findings);
  await context.close();
}
await browser.close();
for (const end of [...ends].filter((line) => !line.endsWith(': ')).sort()) console.log(end);
for (const finding of findings) console.log(`${finding.where}\n  ${finding.problem}`);
console.log(`walk: ${pages.length} page(s), 2 views, ${SIZES.length} sizes, ${beats} beat visits, ${findings.length} problem(s)`);
process.exitCode = findings.length === 0 ? 0 : 1;
