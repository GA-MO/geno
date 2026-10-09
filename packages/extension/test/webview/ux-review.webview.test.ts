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
    const tallest = await panel.eval<number>(`Math.max(0, ...[...doc.querySelectorAll('.command-title, .step-verb')].map((e) => e.getBoundingClientRect().height))`);
    expect(tallest, 'no step title is squeezed into a column').toBeLessThan(100);
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
      await panel.click('[data-denial="d_rm"] .details-toggle', 'Show details');
      await panel.waitFor('the details', async () => (await panel.count('.model-details')) === 1);
      expect(await texts(panel, '.model-details')).toEqual(['The user rejected `rm -rf build`, so it did not run. STOP what you are doing and wait for the user to tell you how to proceed.']);
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

  it('a turn at its limit and a command with notes for the model show plain words, an exit badge, and the notes behind Show details', () =>
    at('turn-limit', width, async (panel) => {
      const shown = await visibleText(panel);
      for (const harness of ['[exit code', '[Geno]', '[max-turns]', '--max-turns']) expect(shown, `no "${harness}" in view`).not.toContain(harness);
      expect(await texts(panel, '.turn-limit')).toEqual(['Reached the turn limit (6)']);
      expect(await texts(panel, '.command-exit')).toEqual(['exit 2']);
      expect(await texts(panel, '.command-output')).toEqual(['src/login.ts:4:  return raw.trim();', 'ERR_PNPM_NO_SCRIPT  Missing script: test']);
      await panel.click('[data-tool="h_grep"] .details-toggle', 'Show details');
      await panel.waitFor('the note', async () => (await texts(panel, '.model-details')).length === 1);
      expect(await texts(panel, '.model-details')).toEqual(['[Geno] Next time, search file contents with the grep tool, not grep -r or rg.']);
    }));

  it('a turn the user stopped says so in plain words', () =>
    at('stopped', width, async (panel) => {
      expect(await texts(panel, '.turn-footer .ending')).toEqual(['Stopped by you']);
    }));

  it('every step names what it did and what it acted on, with no raw tool name', () =>
    at('tools-deferred', width, async (panel) => {
      const lines = await panel.eval<string[]>(`[...doc.querySelectorAll('.calls')].map((s) => [s.querySelector('.step-verb')?.textContent, s.querySelector('.step-target')?.textContent].filter(Boolean).join(' '))`);
      expect(lines).toEqual(['Loaded tools: web_fetch, monitor', 'Used skill poteto-mode', 'Fetched docs.stripe.com', 'Stopped bg-1', 'Remembered', 'Delegated to explore: find callers of getUser']);
    }));

  it('a fetch in the steps of each kind names its host', () =>
    at('tools-each-kind', width, async (panel) => {
      expect(await texts(panel, '[data-step="web_fetch"] .step-verb, [data-step="web_fetch"] .step-target')).toEqual(['Fetched', 'example.com']);
    }));

  it('a turn that ends with no reply says so, and Continue and Retry send a follow-up and the prompt again', () =>
    at('no-reply', width, async (panel) => {
      expect(await texts(panel, '.no-reply-title, .no-reply-reason')).toEqual(['Geno stopped without a reply', 'Its last reply had no text.']);
      const continued = panel.host.next('send');
      await panel.click('.no-reply-actions button', 'Continue');
      expect((await continued).text).toBe('Continue where you stopped, and finish with your answer.');
      const retried = panel.host.next('send');
      await panel.click('.no-reply-actions button', 'Retry');
      expect((await retried).text).toBe('สร้างเกม pacman ในไฟล์ game.html');
    }));

  it('a capped turn with nothing said gives the limit as the reason', () =>
    at('turn-limit', width, async (panel) => {
      expect(await texts(panel, '.no-reply-reason')).toEqual(['It reached its limit before it answered.']);
    }));

  it.each(['rate-limited', 'offline'])('a turn waiting %s keeps Stop and Retry now inside the panel, the wait text giving way first', (id) =>
    at(id, width, async (panel) => {
      const inside = await panel.eval<Record<string, boolean>>(`(() => {
        const right = doc.documentElement.clientWidth;
        const fits = (selector) => { const box = doc.querySelector(selector).getBoundingClientRect(); return box.width > 0 && box.left >= 0 && box.right <= right; };
        return { stop: fits('.round-button.stop'), retry: fits('.retry-now') };
      })()`);
      expect(inside).toEqual({ stop: true, retry: true });
      expect(await panel.eval<number>(`doc.querySelector('.round-button.stop').getBoundingClientRect().width`), 'Stop keeps its full size').toBeGreaterThanOrEqual(24);
    }));

  it('a command Auto refused reads as denied by Auto, not failed', () =>
    at('auto-decision', width, async (panel) => {
      expect(await texts(panel, '.step-denied')).toEqual(['Denied by Auto']);
      expect(await texts(panel, '.denial-reason')).toEqual(['A force push rewrites the shared branch.']);
      expect(await panel.count('.step-failed')).toBe(0);
    }));
});
