import { afterAll, describe, expect, it } from 'vitest';
import { closeBrowser, openPanel, type Panel } from './harness.js';
import { PERMISSION_OPTIONS, toolStart, turnStart } from './turns.js';

const OPTIONS = [...PERMISSION_OPTIONS, { optionId: 'reject-with-comment', name: 'No, and tell the agent…', kind: 'reject_once' }] as const;
const CARD = '.permission-open';

afterAll(closeBrowser);

async function askToPush(panel: Panel): Promise<void> {
  await panel.host.act(turnStart('t0', 'Ship it'), toolStart('tu_push', { name: 'bash', input: { command: 'git push origin main' } }));
  await panel.host.act({ type: 'permission', id: '0', command: 'git push origin main', reason: 'git push', options: OPTIONS, toolId: 'tu_push' });
  await panel.waitFor('the card', async () => (await panel.count(CARD)) === 1);
}

const buttons = (panel: Panel) => panel.eval<string[]>(`[...doc.querySelectorAll('${CARD} .permission-actions button')].map((b) => b.textContent)`);

describe('B/B-71 "No, and tell the agent…" on a permission card', () => {
  it('opens a field, sends what the user typed with the no, and shows it once the card settles', async () => {
    const panel = await openPanel();
    await askToPush(panel);
    expect(await buttons(panel)).toEqual(['Allow', 'Deny', 'No, and tell the agent…']);
    await panel.click(`${CARD} .permission-actions button`, 'No, and tell the agent…');
    await panel.waitFor('the comment field', async () => (await panel.count(`${CARD} textarea.permission-comment`)) === 1);
    expect(await panel.eval(`doc.activeElement?.classList.contains('permission-comment')`), 'the field takes the focus').toBe(true);
    expect(await panel.eval(`doc.querySelector('${CARD} .permission-actions .button').disabled`), 'Send waits for a comment').toBe(true);

    await panel.type('Push to my fork instead.');
    await panel.press('Enter');
    expect(await panel.host.next('permission')).toEqual({ type: 'permission', id: '0', optionId: 'reject-with-comment', comment: 'Push to my fork instead.' });
    await panel.host.act({ type: 'permission-done', id: '0', optionId: 'reject-with-comment', comment: 'Push to my fork instead.' });
    await panel.waitFor('the card to settle', async () => (await panel.count('.permission-chosen')) === 1);
    expect(await panel.eval(`doc.querySelector('.permission-chosen .permission-outcome').textContent`)).toBe('Denied, and told the agent');
    expect(await panel.eval(`doc.querySelector('.permission-chosen .permission-comment-sent').textContent`)).toBe('Push to my fork instead.');
    await panel.close();
  });

  it('goes back to the choices on Esc, sending nothing', async () => {
    const panel = await openPanel();
    await askToPush(panel);
    await panel.click(`${CARD} .permission-actions button`, 'No, and tell the agent…');
    await panel.waitFor('the comment field', async () => (await panel.count(`${CARD} textarea.permission-comment`)) === 1);
    await panel.type('never mind');
    await panel.press('Escape');
    await panel.waitFor('the choices', async () => (await panel.count(`${CARD} textarea`)) === 0);
    expect(await buttons(panel)).toEqual(['Allow', 'Deny', 'No, and tell the agent…']);
    expect(panel.host.received.filter((m) => m.type === 'permission')).toEqual([]);
    await panel.click(`${CARD} .permission-actions button`, 'Deny');
    expect(await panel.host.next('permission')).toEqual({ type: 'permission', id: '0', optionId: 'reject' });
    await panel.close();
  });
});
