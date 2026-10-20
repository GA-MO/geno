import { afterAll, describe, expect, it } from 'vitest';
import { overflowing, overlapping } from '../gallery/checks.js';
import { FIXTURES } from '../gallery/fixtures.js';
import { playFixture } from './gallery-stage.js';
import { closeBrowser } from './harness.js';
import { THEME_SLUGS } from './theme.js';

/** DOMPurify's parse of a diagram reports the style element it refuses, in VS Code too; only a page with a diagram may log it. */
const DIAGRAM_REFUSAL = /(Refused to apply|Applying) inline style .*violates the following Content Security Policy directive 'style-src /;

afterAll(closeBrowser);

/** VS Code lets a side bar shrink well below 300px; a wait's Stop once fell off the panel at 240. Overflow does not change with the theme. */
const NARROW = 240;

/** The composer row's container queries give way at 600, 520, 460, 440 and 360px; a row at 870 once drew the pill over the cost. */
const WIDER = [420, 600, 870] as const;

describe(`every gallery state at ${NARROW}px`, () => {
  it.each(FIXTURES.map((fixture) => [fixture.id, fixture] as const))('%s has nothing past the panel edge, and no composer item over another up to 870px', async (_id, fixture) => {
    const panel = await playFixture(fixture, 'dark', NARROW);
    await panel.screenshot(`gallery-${fixture.id}-${NARROW}`);
    expect(await panel.page.evaluate(overflowing as () => string[]), `nothing runs past the ${NARROW}px panel`).toEqual([]);
    expect(await panel.page.evaluate(overlapping as () => string[]), `no composer item covers another at ${NARROW}px`).toEqual([]);
    for (const width of WIDER) {
      await panel.page.setViewportSize({ width, height: panel.page.viewportSize()!.height });
      await panel.frame();
      expect(await panel.page.evaluate(overlapping as () => string[]), `no composer item covers another at ${width}px`).toEqual([]);
    }
    await panel.close();
  });
});

describe.each(THEME_SLUGS)('every gallery state in %s', (theme) => {
  it.each(FIXTURES.map((fixture) => [fixture.id, fixture] as const))('%s draws at 300px with no error, nothing past the panel edge and no composer item over another', async (_id, fixture) => {
    const panel = await playFixture(fixture, theme);
    await panel.screenshot(`gallery-${fixture.id}-${theme}`);
    expect(await panel.page.evaluate(overflowing as () => string[]), 'nothing runs past the 300px panel').toEqual([]);
    expect(await panel.page.evaluate(overlapping as () => string[]), 'no composer item covers another at 300px').toEqual([]);
    const diagrams = (await panel.count('.diagram')) > 0;
    expect(panel.consoleErrors.filter((text) => !(diagrams && DIAGRAM_REFUSAL.test(text))), 'the page logs no error').toEqual([]);
    await panel.close();
  });
});
