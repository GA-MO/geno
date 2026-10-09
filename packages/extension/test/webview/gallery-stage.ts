import { FIXTURES } from '../gallery/fixtures.js';
import type { Fixture, Stage } from '../gallery/stage.js';
import { DEFAULT_LOOK, openPanel, type Panel } from './harness.js';
import type { ThemeSlug } from './theme.js';

export const stageOf = (panel: Panel): Stage => ({
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

export const fixtureOf = (id: string): Fixture => {
  const fixture = FIXTURES.find((f) => f.id === id);
  if (fixture === undefined) throw new Error(`no gallery fixture ${id}`);
  return fixture;
};

/** The panel at `width` with `fixture` played and drawn, as the gallery test opens it. */
export async function playFixture(fixture: Fixture, theme: ThemeSlug = 'dark', width = 300): Promise<Panel> {
  const panel = await openPanel({ theme, look: { ...DEFAULT_LOOK, ...fixture.look }, focused: fixture.focused ?? true, width });
  await fixture.play(stageOf(panel));
  await panel.host.settled();
  await panel.frame();
  await panel.frame();
  return panel;
}
