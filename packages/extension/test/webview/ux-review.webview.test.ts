import { afterAll, describe, expect, it } from 'vitest';
import { overflowing } from '../gallery/checks.js';
import { fixtureOf, playFixture } from './gallery-stage.js';
import { closeBrowser, type Panel } from './harness.js';

/** The widths VS Code's side bar reaches in use: the narrowest the review measured, and the gallery's own. */
const WIDTHS = [240, 300] as const;

afterAll(closeBrowser);

const texts = (panel: Panel, selector: string) => panel.eval<string[]>(`[...doc.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent.trim())`);
const visibleText = (panel: Panel) => panel.eval<string>('doc.body.innerText');

/** Plays a gallery state at `width`, checks nothing runs past the panel edge, then hands the panel to `check`. */
async function at(id: string, width: number, check: (panel: Panel) => Promise<void>): Promise<void> {
  const panel = await playFixture(fixtureOf(id), 'dark', width);
  try {
    await panel.screenshot(`ux-${id}-${width}`);
    expect(await panel.page.evaluate(overflowing as () => string[]), `nothing runs past the ${width}px panel`).toEqual([]);
    const narrowest = await panel.eval<number>(`Math.min(Infinity, ...[...doc.querySelectorAll('.command-title, .step-verb')].map((e) => e.getBoundingClientRect().width))`);
    expect(narrowest, 'no step title is squeezed into a column').toBeGreaterThan(40);
    await check(panel);
  } finally {
    await panel.close();
  }
}

describe.each(WIDTHS)('at %ipx', (width) => {
  it('a refused call reads as denied, says who refused it in plain words, and keeps the model text behind Show details', () =>
    at('tool-denied', width, async (panel) => {
      expect(await texts(panel, '.step-denied')).toEqual(['Denied by you', 'Denied by a rule', 'Denied by a rule (Bash(git push --force:*))']);
      expect(await texts(panel, '.denial-reason')).toEqual([
        'It did not run, and Geno waits for you.',
        'Fetching a page from another host needs your approval, and nobody could answer.',
        'Your rule in .g-code/settings.json blocks it.',
      ]);
      expect(await panel.count('.step-failed'), 'nothing reads as failed').toBe(0);
      expect(await panel.count('.node-failed'), 'no red node on the rail').toBe(0);
      expect(await visibleText(panel)).not.toContain('STOP what you are doing');
      await panel.click('[data-denial="d_rm"] .denial-toggle', 'Show details');
      await panel.waitFor('the details', async () => (await panel.count('.denial-details')) === 1);
      expect(await texts(panel, '.denial-details')).toEqual(['The user rejected `rm -rf build`, so it did not run. STOP what you are doing and wait for the user to tell you how to proceed.']);
      expect(await panel.page.evaluate(overflowing as () => string[]), 'the details fit too').toEqual([]);
    }));

  it('a command Auto refused reads as denied by Auto, not failed', () =>
    at('auto-decision', width, async (panel) => {
      expect(await texts(panel, '.step-denied')).toEqual(['Denied by Auto']);
      expect(await texts(panel, '.denial-reason')).toEqual(['A force push rewrites the shared branch.']);
      expect(await panel.count('.step-failed')).toBe(0);
    }));
});
