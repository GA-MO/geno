import { afterAll, describe, expect, it } from 'vitest';
import { overflowing } from '../gallery/checks.js';
import { fixtureOf, playFixture } from './gallery-stage.js';
import { closeBrowser, type Panel } from './harness.js';

afterAll(closeBrowser);

type Card = { readonly place: string | undefined; readonly open: boolean; readonly line: string; readonly spins: number; readonly lineColor: string; readonly foreground: string; readonly border: string };

/** The todo card on the running turn, as the user sees it. */
const cardOf = (panel: Panel) =>
  panel.eval<Card>(`(() => {
    const todo = doc.querySelector('.transcript .turn:last-child .todo');
    return {
      place: todo.dataset.place,
      open: todo.querySelector('.todo-head').getAttribute('aria-expanded') === 'true',
      line: todo.querySelector('.todo-line').textContent,
      spins: todo.querySelectorAll('.codicon-modifier-spin').length,
      lineColor: getComputedStyle(todo.querySelector('.todo-line')).color,
      foreground: getComputedStyle(todo.querySelector('.todo-head')).color,
      border: getComputedStyle(todo).borderTopStyle,
    };
  })()`);

describe("an earlier turn's unfinished list on a new turn", () => {
  it('shows as carried: one muted line that says where it came from, nothing spinning, even opened', async () => {
    const panel = await playFixture(fixtureOf('todo-carried'));
    const card = await cardOf(panel);
    expect(card).toMatchObject({ place: 'carried', open: false, line: '1 of 3 done · from an earlier turn', spins: 0, border: 'dashed' });
    expect(card.lineColor, 'the line is muted').not.toBe(card.foreground);
    expect(await panel.page.evaluate(overflowing as () => string[]), 'nothing runs past the panel at 300px').toEqual([]);

    await panel.click('.transcript .turn:last-child .todo-head');
    await panel.waitFor('the carried list to open', async () => (await cardOf(panel)).open);
    expect((await cardOf(panel)).spins, 'the item that was in progress does not spin').toBe(0);
    expect(await panel.eval<string | null>(`doc.querySelector('.transcript .turn:last-child .todo-item[data-status="in_progress"] .todo-mark').getAttribute('aria-label')`)).toBe('Was in progress');
    await panel.close();
  });

  it('becomes the live card, open with its item spinning, once the turn updates it', async () => {
    const panel = await playFixture(fixtureOf('todo-carried-updated'));
    const card = await cardOf(panel);
    expect(card).toMatchObject({ place: 'live', open: true, line: '2 of 3 done · update the tests', spins: 1, border: 'solid' });
    expect(card.lineColor).toBe(card.foreground);
    expect(await panel.count('.transcript .turn:last-child .todo'), 'one card on the turn').toBe(1);
    await panel.close();
  });
});
