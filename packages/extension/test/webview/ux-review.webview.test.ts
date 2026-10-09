import { afterAll, describe, expect, it } from 'vitest';
import { overflowing } from '../gallery/checks.js';
import { fixtureOf, playFixture } from './gallery-stage.js';
import { closeBrowser, type Panel } from './harness.js';

/** The widths VS Code's side bar reaches in use: the narrowest the review measured, and the gallery's own. */
const WIDTHS = [240, 300] as const;

afterAll(closeBrowser);

const texts = (panel: Panel, selector: string) => panel.eval<string[]>(`[...doc.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent.trim())`);
const visibleText = (panel: Panel) => panel.eval<string>("doc.querySelector('.transcript').innerText");

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

  it.each(['approve-command', 'real-approval'])('a call that waits on its card %s says it waits for you, with no spinner and the command only in the card', (id) =>
    at(id, width, async (panel) => {
      const command = await panel.eval<string>(`doc.querySelector('.permission-open .permission-command').textContent`);
      expect(await texts(panel, '.step-asking .step-verb')).toEqual(['Waiting for you']);
      expect(await panel.count('.step-asking .codicon-modifier-spin, .step-asking .command-in'), 'no spinner and no IN box on the waiting step').toBe(0);
      expect(await panel.count('.node-wait > .step-asking'), 'its node waits on the user').toBe(1);
      expect((await visibleText(panel)).split(command).length - 1, 'the command shows once, in the card').toBe(1);
      await panel.host.act({ type: 'permission-done', id: '0', optionId: 'allow' });
      await panel.waitFor('the allowed step to show its command', async () => (await panel.count('.step-asking')) === 0 && (await texts(panel, '.command-in, .step-target')).includes(command));
    }));

  it('a failed command previews its last lines, where the error is, with the first ones behind Show all', () =>
    at('tool-failed', width, async (panel) => {
      const output = await panel.eval<string>(`doc.querySelector('.command-output').textContent`);
      expect(output).toContain("AssertionError: expected 'a@b.c ' to be 'a@b.c'");
      expect(output).not.toContain('RUN  v3.2.4');
      expect(await panel.count('.command-output.truncated.from-end'), 'the fade sits at the top').toBe(1);
      expect((await texts(panel, '.command-step .show-all'))[0]).toMatch(/^Show all \d+ lines$/);
      await panel.click('.command-step .show-all');
      await panel.waitFor('every line', async () => (await panel.eval<string>(`doc.querySelector('.command-output').textContent`)).includes('RUN  v3.2.4'));
    }));

  it('a command Auto refused reads as denied by Auto, not failed', () =>
    at('auto-decision', width, async (panel) => {
      expect(await texts(panel, '.step-denied')).toEqual(['Denied by Auto']);
      expect(await texts(panel, '.denial-reason')).toEqual(['A force push rewrites the shared branch.']);
      expect(await panel.count('.step-failed')).toBe(0);
    }));
});
