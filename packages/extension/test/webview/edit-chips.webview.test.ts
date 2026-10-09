import { afterAll, describe, expect, it } from 'vitest';
import { overflowing } from '../gallery/checks.js';
import { fixtureOf, playFixture } from './gallery-stage.js';
import { closeBrowser, type Panel } from './harness.js';

afterAll(closeBrowser);

const STEP = '.calls[data-step="edit"]';
const textsOf = (panel: Panel, selector: string) => panel.eval<string[]>(`[...doc.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent)`);

describe('a step that edits one file five times and another once', () => {
  it('shows one chip per file with the summed counts and how many edits, and lists every edit when opened', async () => {
    const panel = await playFixture(fixtureOf('edit-same-file'));
    expect(await textsOf(panel, `${STEP} .file-chip`), 'one chip per file').toEqual(['game.js+10−17· 5 edits', 'style.css+1−1']);
    expect(await panel.page.evaluate(overflowing as () => string[]), 'nothing runs past the panel at 300px').toEqual([]);
    expect(await panel.page.getAttribute(`${STEP} .step-toggle`, 'aria-label'), 'the toggle names the step and its files for a screen reader').toBe('Edited src/game.js src/style.css');

    await panel.click(`${STEP} .step-toggle`);
    await panel.waitFor('the step to open', async () => (await panel.count(`${STEP} .tool-row`)) > 0);
    expect(await textsOf(panel, `${STEP} .tool-target`), 'the opened step keeps one row per edit').toEqual([...Array<string>(5).fill('src/game.js'), 'src/style.css']);
    expect(await panel.count(`${STEP} .tool-duration`)).toBe(6);
    expect(await panel.page.evaluate(overflowing as () => string[]), 'nothing runs past the panel with the step open').toEqual([]);
    await panel.close();
  });

  it('opens the file’s change across all its edits from the chip, without opening the step', async () => {
    const panel = await playFixture(fixtureOf('edit-same-file'));
    await panel.look({ review: 'auto' });
    await panel.click(`${STEP} .file-chip`, 'game.js+10−17· 5 edits');
    expect(await panel.host.next('open-change'), 'auto review diffs the file against the checkpoint before its first edit').toEqual({ type: 'open-change', path: 'src/game.js', checkpoint: { before: 'g1-change' } });
    await panel.frame();
    expect(await panel.count(`${STEP} .tool-row`), 'the chip opens the change, not the step').toBe(0);

    await panel.look({ review: 'review' });
    await panel.click(`${STEP} .file-chip`, 'style.css+1−1');
    expect(await panel.host.next('reveal'), 'review opens the file at its first hunk').toEqual({ type: 'reveal', hunk: 's1-h0' });
    await panel.close();
  });

  it('gathers each file’s edits in one section of the changes card, every hunk kept', async () => {
    const panel = await playFixture(fixtureOf('edit-same-file'));
    expect(await textsOf(panel, '.changes .edit-head'), 'one section per file').toEqual(['game.jssrc+10−17· 5 edits', 'style.csssrc+1−1']);
    expect(await panel.count('.changes .edit-card:first-of-type .hunk'), 'the game.js section holds all five hunks').toBe(5);
    await panel.close();
  });
});
