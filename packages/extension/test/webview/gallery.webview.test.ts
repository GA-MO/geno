import { afterAll, describe, expect, it } from 'vitest';
import { overflowing } from '../gallery/checks.js';
import { FIXTURES } from '../gallery/fixtures.js';
import { playFixture } from './gallery-stage.js';
import { closeBrowser } from './harness.js';
import { THEME_SLUGS } from './theme.js';

/** DOMPurify's parse of a diagram reports the style element it refuses, in VS Code too; only a page with a diagram may log it. */
const DIAGRAM_REFUSAL = /(Refused to apply|Applying) inline style .*violates the following Content Security Policy directive 'style-src /;

afterAll(closeBrowser);

describe.each(THEME_SLUGS)('every gallery state in %s', (theme) => {
  it.each(FIXTURES.map((fixture) => [fixture.id, fixture] as const))('%s draws at 300px with no error and nothing past the panel edge', async (_id, fixture) => {
    const panel = await playFixture(fixture, theme);
    await panel.screenshot(`gallery-${fixture.id}-${theme}`);
    expect(await panel.page.evaluate(overflowing as () => string[]), 'nothing runs past the 300px panel').toEqual([]);
    const diagrams = (await panel.count('.diagram')) > 0;
    expect(panel.consoleErrors.filter((text) => !(diagrams && DIAGRAM_REFUSAL.test(text))), 'the page logs no error').toEqual([]);
    await panel.close();
  });
});
