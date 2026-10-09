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

  it.each([
    ['approve-command', 'Geno asks to run a command', 'Run this command?', 'git push origin main', 'Geno asks because it uses git push.'],
    ['approve-path', 'Geno asks to read outside the workspace', 'Read outside the workspace?', 'read /Users/me/notes/release-plan.md', 'Geno asks about a path outside the workspace.'],
    ['approve-domain', 'Geno asks to fetch a page', 'Fetch from docs.stripe.com?', 'fetch https://docs.stripe.com/api/charges (host docs.stripe.com)', 'Geno asks about fetching a page from another host.'],
    ['approve-browse', 'Geno asks to open a page', 'Open a page on dashboard.stripe.com?', 'open https://dashboard.stripe.com/test/payments (host dashboard.stripe.com)', 'Geno asks about opening a page on another host.'],
    ['approve-mcp', 'Geno asks to use an MCP tool', 'Use github tool create_issue?', 'mcp__github__create_issue', 'Geno asks about an MCP tool.'],
  ])('%s asks its own question', async (id, label, title, command, reason) => {
    const panel = await playFixture(fixtureOf(id));
    expect(
      await panel.eval(
        `(() => { const card = doc.querySelector('${CARD}'); return [card.getAttribute('aria-label'), card.querySelector('.permission-title').textContent, card.querySelector('.permission-command').textContent, card.querySelector('.permission-reason').textContent]; })()`,
      ),
    ).toEqual([label, title, command, reason]);
    expect(await overflow(panel)).toEqual([]);
    await panel.close();
  });
});
