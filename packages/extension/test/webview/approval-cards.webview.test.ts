import { afterAll, describe, expect, it } from 'vitest';
import { overflowing } from '../gallery/checks.js';
import { fixtureOf, playFixture } from './gallery-stage.js';
import { closeBrowser, type Panel } from './harness.js';

afterAll(closeBrowser);

const CARD = '.permission-open';
const buttons = (panel: Panel) => panel.eval<string[]>(`[...doc.querySelectorAll('${CARD} .permission-actions button')].map((b) => b.textContent)`);
const overflow = (panel: Panel) => panel.page.evaluate(overflowing as () => string[]);

describe('the approval cards at 300px', () => {
  it.each([
    ['approve-path', ['Allow', 'Allow this directory for the session', 'Deny', 'No, and tell the agent…']],
    ['approve-mcp', ['Allow', 'Allow this tool for the session', 'Deny', 'Always allow in this workspace', 'No, and tell the agent…']],
    ['approve-rule', ['Allow', 'Deny', 'Always allow in this workspace', 'No, and tell the agent…']],
  ])('%s names each option by what it does', async (id, labels) => {
    const panel = await playFixture(fixtureOf(id));
    expect(await buttons(panel)).toEqual(labels);
    expect(await overflow(panel)).toEqual([]);
    await panel.close();
  });
});
