import { afterAll, describe, expect, it } from 'vitest';
import { overflowing } from '../gallery/checks.js';
import { fixtureOf, stageOf } from './gallery-stage.js';
import { closeBrowser, DEFAULT_LOOK, openPanel, type Panel } from './harness.js';
import { THEME_SLUGS, type ThemeSlug } from './theme.js';

afterAll(closeBrowser);

const STATES = ['show-files-pair', 'show-files-five', 'show-files-single', 'show-files-mixed', 'show-files-refused'] as const;

/** A show_files state played at `width`, with every image it draws loaded. */
async function played(id: string, width: number, theme: ThemeSlug = 'dark'): Promise<Panel> {
  const fixture = fixtureOf(id);
  const panel = await openPanel({ theme, look: { ...DEFAULT_LOOK, ...fixture.look }, width });
  await fixture.play(stageOf(panel));
  await panel.host.settled();
  await panel.waitFor('every image to load', () => panel.eval<boolean>(`[...doc.querySelectorAll('.show-files img')].every((img) => img.complete && img.naturalWidth > 0)`));
  await panel.frame();
  return panel;
}

type Tile = { readonly name: string; readonly top: number; readonly left: number; readonly width: number };

const tilesOf = (panel: Panel) =>
  panel.eval<Tile[]>(`[...doc.querySelectorAll('.show-files .shown-image')].map((tile) => {
    const box = tile.getBoundingClientRect();
    return { name: tile.querySelector('figcaption').textContent, top: Math.round(box.top), left: Math.round(box.left), width: Math.round(box.width) };
  })`);

const rowsOf = (panel: Panel) => panel.eval<string[]>(`[...doc.querySelectorAll('.show-files .shown-file')].map((row) => row.textContent)`);

describe('the show_files card', () => {
  it('draws the caption, then a pair side by side at 300px, and opens an image full size on a click', async () => {
    const panel = await played('show-files-pair', 300);
    expect(await panel.eval<string>(`doc.querySelector('.show-files-caption').textContent`)).toBe('The sign-in page before and after the fix: the button now sits inside the card.');
    const [before, after] = await tilesOf(panel);
    expect([before!.name, after!.name]).toEqual(['before.png', 'after.png']);
    expect(after!.top, 'two in one row').toBe(before!.top);
    expect(after!.left).toBeGreaterThan(before!.left);
    await panel.click('.shown-image .shown-frame');
    expect(await panel.host.next('open')).toEqual({ type: 'open', target: { kind: 'path', path: '/gallery-media/before.png' } });
    await panel.close();
  });

  it('wraps five images two to a row at 300px and fits three or more to a row at 600px', async () => {
    const narrow = await played('show-files-five', 300);
    const firstRow = (tiles: readonly Tile[]) => tiles.filter((tile) => tile.top === tiles[0]!.top).length;
    const tiles = await tilesOf(narrow);
    expect(new Set(tiles.map((tile) => tile.top)).size, 'three rows of two, two and one').toBe(3);
    expect(firstRow(tiles)).toBe(2);
    await narrow.close();
    const wide = await played('show-files-five', 600);
    expect(firstRow(await tilesOf(wide))).toBeGreaterThanOrEqual(3);
    await wide.close();
  });

  it('draws each image across the panel in the single layout', async () => {
    const panel = await played('show-files-single', 300);
    const tiles = await tilesOf(panel);
    expect(tiles).toHaveLength(2);
    expect(tiles[1]!.top).toBeGreaterThan(tiles[0]!.top);
    const card = await panel.eval<number>(`Math.round(doc.querySelector('.show-files').getBoundingClientRect().width)`);
    expect(tiles[0]!.width).toBe(card);
    await panel.close();
  });

  it('shows a PDF, Markdown, SVG, CSV and HTML file as rows with Open, and never draws the SVG or the HTML', async () => {
    const panel = await played('show-files-mixed', 300);
    expect(await tilesOf(panel)).toEqual([expect.objectContaining({ name: 'after.png' })]);
    expect(await rowsOf(panel)).toEqual(['audit-report-october.pdf793 KBOpen', 'notes.md3 KBOpen', 'sizes.svg10 KBOpen', 'sizes.csv1 KBOpen', 'report.html22 KBOpen']);
    expect(await panel.count('.show-files img[src$=".svg"], .show-files iframe, .show-files object, .show-files embed')).toBe(0);
    await panel.click('.shown-file:nth-child(5) .button');
    expect(await panel.host.next('open')).toEqual({ type: 'open', target: { kind: 'path', path: '/gallery-media/report.html' } });
    await panel.close();
  });

  it('lists each refused file with why, beside the image it did show', async () => {
    const panel = await played('show-files-refused', 300);
    expect(await panel.eval<string[]>(`[...doc.querySelectorAll('.shown-refused-name')].map((name) => name.textContent)`)).toEqual(['.env', '/Users/me/Downloads/old-shot.png']);
    expect(await panel.eval<string>(`doc.querySelector('.shown-refused-reason').textContent`)).toContain("matches Geno's built-in rule for credentials files");
    expect(await tilesOf(panel)).toHaveLength(1);
    await panel.close();
  });

  it('falls back to a row with Open for an image it cannot load, and for one outside the folders it may load from', async () => {
    const panel = await played('show-files-pair', 300);
    await panel.page.route('**/gallery-media/gone.png', (route) => route.fulfill({ status: 404 }));
    await panel.host.act({ type: 'turn-start', id: 't1', at: Date.now(), prompt: 'And the old ones?', mode: 'ask' });
    await panel.host.act({
      type: 'tool',
      id: 'tu_more',
      at: Date.now(),
      name: 'show_files',
      target: 'gone.png',
      toolKind: 'other',
      status: 'completed',
      output: '',
      shown: {
        layout: 'grid',
        files: [
          { kind: 'shown', given: 'gone.png', path: '/gallery-media/gone.png', name: 'gone.png', bytes: 10, show: 'image' },
          { kind: 'shown', given: '/Users/me/Downloads/old.png', path: '/Users/me/Downloads/old.png', name: 'old.png', bytes: 20, show: 'image' },
        ],
      },
    });
    await panel.waitFor('the missing image to become a row', async () => (await panel.count('.turn:last-child .shown-file')) === 2);
    expect(await panel.count('.turn:last-child .shown-image')).toBe(0);
    await panel.close();
  });

  it('shows a show_files call that has not finished as an ordinary step', async () => {
    const panel = await openPanel({ width: 300 });
    await panel.host.act({ type: 'turn-start', id: 't0', at: Date.now(), prompt: 'Show me', mode: 'ask' });
    await panel.host.act({ type: 'tool', id: 'tu_show', at: Date.now(), name: 'show_files', target: 'shot.png', toolKind: 'other', status: 'running' });
    await panel.waitFor('the step', async () => (await panel.count('[data-step="show_files"]')) === 1);
    expect(await panel.count('.show-files')).toBe(0);
    await panel.close();
  });
});

describe.each(THEME_SLUGS)('the show_files states in %s', (theme) => {
  it.each(STATES.flatMap((id) => [240, 300].map((width) => [id, width] as const)))('%s draws at %ipx with no error and nothing past the panel edge', async (id, width) => {
    const panel = await played(id, width, theme);
    await panel.screenshot(`show-files-${id}-${width}-${theme}`);
    expect(await panel.page.evaluate(overflowing as () => string[]), `nothing runs past the ${width}px panel`).toEqual([]);
    expect(panel.consoleErrors, 'the page logs no error').toEqual([]);
    await panel.close();
  });
});
