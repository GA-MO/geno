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

  it.each([
    ['approve-mcp', 'Use github tool create_issue?', '{\n  "title": "Login fails with a trailing space",\n  "labels": [\n    "bug"\n  ]\n}', 'Geno asks about a tool of an MCP server, which runs outside the sandbox.'],
    ['approve-mcp-read-only', 'Use thai-baht tool baht_text?', '{\n  "amountSatang": 125050\n}', 'Geno asks about a tool its MCP server calls read-only, which Geno cannot check.'],
  ])('%s shows the arguments the server gets, not a shell line', async (id, title, args, reason) => {
    const panel = await playFixture(fixtureOf(id));
    expect(
      await panel.eval(
        `(() => { const card = doc.querySelector('${CARD}'); return [card.getAttribute('aria-label'), card.querySelector('.permission-title').textContent, card.querySelector('.permission-arguments')?.textContent, card.querySelector('.permission-command'), card.querySelector('.permission-reason').textContent]; })()`,
      ),
    ).toEqual(['Geno asks to use an MCP tool', title, args, null, reason]);
    expect(await overflow(panel)).toEqual([]);
    await panel.close();
  });

  it('draws "Allow this tool for the session" as a button, filled like Deny', async () => {
    const panel = await playFixture(fixtureOf('approve-mcp-read-only'));
    const look = (label: string) =>
      panel.eval<[string, string, string]>(
        `(() => { const b = [...doc.querySelectorAll('${CARD} .permission-actions button')].find((b) => b.textContent === ${JSON.stringify(label)}); const s = getComputedStyle(b); return [b.tagName, s.backgroundColor, s.color]; })()`,
      );
    const [tag, background] = await look('Allow this tool for the session');
    expect(tag).toBe('BUTTON');
    expect(background).not.toBe('rgba(0, 0, 0, 0)');
    expect(await look('Allow this tool for the session')).toEqual(await look('Deny'));
    await panel.close();
  });

  it('shows the whole line one yes runs, and names the part that needs it', async () => {
    const panel = await playFixture(fixtureOf('approve-compound'));
    expect(
      await panel.eval(
        `(() => { const card = doc.querySelector('${CARD}'); return [card.querySelector('.permission-command').textContent, card.querySelector('.permission-part').textContent, card.querySelector('.permission-rule').textContent]; })()`,
      ),
    ).toEqual([
      'for f in server.js lib/*.js; do node --check $f; done && npm test 2>&1 | tail -12',
      'Needs approval: node --check $f',
      'Always allow saves the rule node --check for this workspace. Settings lists its rules.',
    ]);
    expect(await overflow(panel)).toEqual([]);
    await panel.close();
  });
});
