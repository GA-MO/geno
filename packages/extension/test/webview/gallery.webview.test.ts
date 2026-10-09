import { afterAll, describe, expect, it } from 'vitest';
import { overflowing } from '../gallery/checks.js';
import { FIXTURES } from '../gallery/fixtures.js';
import type { Stage } from '../gallery/stage.js';
import { closeBrowser, DEFAULT_LOOK, openPanel, type Panel } from './harness.js';
import { THEME_SLUGS } from './theme.js';

/** Known: a diff line longer than its card is cut at the card's edge; Open shows it whole in the editor. */
const KNOWN_CUTS = /^span\.code \d+px past the right$/;

/** DOMPurify's parse of a diagram reports the style element it refuses, in VS Code too; only a page with a diagram may log it. */
const DIAGRAM_REFUSAL = /(Refused to apply|Applying) inline style .*violates the following Content Security Policy directive 'style-src /;

const stageOf = (panel: Panel): Stage => ({
  host: panel.host,
  shows: (selector) => panel.waitFor(`the panel to show ${selector}`, async () => (await panel.count(selector)) > 0),
  click: (selector) => panel.click(selector),
  fill: (selector, text) => panel.page.locator(selector).first().fill(text, { timeout: 5000 }),
  reveal: async (selector) => {
    await panel.waitFor(`the panel to show ${selector}`, async () => (await panel.count(selector)) > 0);
    await panel.frame();
    await panel.eval(`(doc.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: 'start' }), 1)`);
  },
});

afterAll(closeBrowser);

describe.each(THEME_SLUGS)('every gallery state in %s', (theme) => {
  it.each(FIXTURES.map((fixture) => [fixture.id, fixture] as const))('%s draws at 300px with no error and nothing past the panel edge', async (_id, fixture) => {
    const panel = await openPanel({ theme, look: { ...DEFAULT_LOOK, ...fixture.look }, focused: fixture.focused ?? true, width: 300 });
    await fixture.play(stageOf(panel));
    await panel.host.settled();
    await panel.frame();
    await panel.frame();
    await panel.screenshot(`gallery-${fixture.id}-${theme}`);
    expect((await panel.page.evaluate(overflowing as () => string[])).filter((line) => !KNOWN_CUTS.test(line)), 'nothing runs past the 300px panel').toEqual([]);
    const diagrams = (await panel.count('.diagram')) > 0;
    expect(panel.consoleErrors.filter((text) => !(diagrams && DIAGRAM_REFUSAL.test(text))), 'the page logs no error').toEqual([]);
    await panel.close();
  });
});
