import { afterAll, describe, expect, it } from 'vitest';
import { overflowing } from '../gallery/checks.js';
import { fixtureOf, playFixture } from './gallery-stage.js';
import { closeBrowser } from './harness.js';

afterAll(closeBrowser);

describe('a diff line longer than its card at 300px', () => {
  it('scrolls sideways inside its hunk, to its last character, and the card stays inside the panel', async () => {
    const panel = await playFixture(fixtureOf('edit-multi-hunk'));
    const seen = await panel.eval<{ card: number; panel: number; scrolls: boolean; lineEnd: number; hunkEnd: number }>(`(() => {
      const hunk = [...doc.querySelectorAll('.hunk-lines')].find((e) => e.scrollWidth > e.clientWidth);
      const card = doc.querySelector('.edit-card').getBoundingClientRect().right;
      if (hunk === undefined) return { card, panel: doc.documentElement.clientWidth, scrolls: false, lineEnd: 0, hunkEnd: 0 };
      hunk.scrollLeft = hunk.scrollWidth;
      const code = [...hunk.querySelectorAll('.code')].sort((a, b) => b.scrollWidth - a.scrollWidth)[0];
      return { card, panel: doc.documentElement.clientWidth, scrolls: true, lineEnd: code.getBoundingClientRect().right, hunkEnd: hunk.getBoundingClientRect().right };
    })()`);
    expect(seen.scrolls, 'the hunk scrolls sideways').toBe(true);
    expect(seen.card).toBeLessThanOrEqual(seen.panel);
    expect(seen.lineEnd, 'the longest line ends inside the hunk once scrolled').toBeLessThanOrEqual(seen.hunkEnd);
    expect(await panel.page.evaluate(overflowing as () => string[])).toEqual([]);
    await panel.close();
  });
});
