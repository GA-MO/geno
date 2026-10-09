/**
 * Screenshots of a running gallery for docs/ui-gallery.md: `pnpm ui` in one terminal, then
 * `pnpm exec tsx packages/extension/test/gallery/screenshots.mts [gallery URL] [output folder]`. It also prints each frame's
 * problems, as the gallery's badges show them. With `--groups`, it also shoots every group's grid in dark and light.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright-core';

const [url = 'http://127.0.0.1:5390/', folder = 'docs/ui-gallery'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const out = path.resolve(folder);

type Saved = Record<string, unknown>;

async function open(page: Page, controls: Saved): Promise<void> {
  await page.evaluate((saved) => localStorage.setItem('geno-ui-gallery', JSON.stringify(saved)), controls);
  await page.reload();
  await page.waitForSelector('.card iframe, .single iframe, .design-frame');
  // Each frame boots the panel, then its fixture plays; the badges settle once every visible one has.
  await page.waitForTimeout(3500);
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => document.querySelector('.stage')?.scrollTo(0, 0));
  await page.screenshot({ path: path.join(out, name) });
}

async function problems(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.badge:not([hidden])')].map((b) => `${b.closest('[data-fixture]')?.getAttribute('data-fixture') ?? 'single'}: ${b.title}`));
}

const browser = await chromium.launch(process.env['GCODE_CHROMIUM'] ? { executablePath: process.env['GCODE_CHROMIUM'] } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 780 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => console.log(`gallery error: ${error.message}`));
  await page.goto(url);
  await page.waitForSelector('.toolbar select');
  await mkdir(out, { recursive: true });
  const base = { view: 'states', mode: 'grid', group: 'Turns', width: 300, style: 'glass', detail: 'compact', review: 'auto', tokensOpen: false, tokens: {} };

  await open(page, { ...base, theme: 'dark' });
  console.log(`dark grid: ${JSON.stringify(await problems(page))}`);
  await shoot(page, 'grid-dark.png');

  await open(page, { ...base, theme: 'light' });
  console.log(`light grid: ${JSON.stringify(await problems(page))}`);
  await shoot(page, 'grid-light.png');

  await open(page, { ...base, theme: 'dark', group: 'Approval cards', tokensOpen: true, tokens: { dark: { '--glass-base': '#101826', '--warn': '#ff9f43', '--bubble-fill': 'rgb(80 140 255 / 22%)' } } });
  await shoot(page, 'tokens-dark.png');

  await open(page, { ...base, theme: 'dark', view: 'design', width: 900 });
  await shoot(page, 'design-dark.png');

  if (process.argv.includes('--groups')) {
    const groups = await page.evaluate(() => [...document.querySelectorAll('.group .group-name')].map((b) => b.firstChild?.textContent ?? ''));
    for (const group of groups)
      for (const theme of ['dark', 'light']) {
        await open(page, { ...base, theme, group, width: 420 });
        console.log(`${group} in ${theme}: ${JSON.stringify(await problems(page))}`);
        await shoot(page, `group-${group.toLowerCase().replace(/[^a-z]+/g, '-')}-${theme}.png`);
      }
  }
} finally {
  await browser.close();
}
