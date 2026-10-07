import { afterAll, describe, expect, it } from 'vitest';
import type { Action } from '../../src/chat/messages.js';
import { closeBrowser, openPanel, type Panel } from './harness.js';
import { toolEnd, toolStart, turnStart, usageOf } from './turns.js';

const DIAGRAM = 'flowchart LR\n  A[Request] --> B[Cache]';
const ANSWER = `## Where the time goes\n\nMostly type checking.\n\n\`\`\`mermaid\n${DIAGRAM}\n\`\`\`\n\n- [x] measured\n- [ ] fixed`;
const WIDGET = { state: 'ready', title: 'Build time', sha256: 'ab12', html: '<p style="color: var(--fg)">bars</p>' } as const;

/** A finished turn: a read, a widget, then the answer with a diagram, as the extension posts the engine's updates. */
async function playTurn(panel: Panel): Promise<void> {
  const widget: Action = { type: 'tool', id: 'tu_w', at: Date.now(), name: 'show_widget', target: WIDGET.title, toolKind: 'other', status: 'completed', output: 'drawn', widget: WIDGET };
  await panel.host.act({ ...turnStart('t1', 'Why is the build slow?'), seq: 1 } as Action, toolStart('tu_r', { name: 'read', input: { path: 'tsconfig.json' } }), toolEnd('tu_r', 'completed', '{}'));
  await panel.host.act({ type: 'text', text: 'Here is the split.' }, widget, { type: 'text', text: ANSWER }, { type: 'turn-end', at: Date.now(), status: 'done', usage: usageOf('qwen3.8-flash'), seq: 2 });
}

const shown = (panel: Panel, selector: string) => panel.eval<boolean>(`(() => { const e = doc.querySelector(${JSON.stringify(selector)}); return !!e && !e.hidden; })()`);

afterAll(closeBrowser);

describe('Save as page', () => {
  it('saves an answer from the message menu, with the diagrams the panel drew, and a widget from its own menu', async () => {
    const panel = await openPanel();
    await playTurn(panel);
    await panel.waitFor('the diagram to be drawn', async () => (await panel.count('[data-turn="t1"] .diagram[data-state="rendered"]')) === 1, 20_000);
    await panel.waitFor('the widget', async () => (await panel.count('.widget[data-state="ready"] iframe')) === 1);
    expect(await panel.eval<string[]>(`[...doc.querySelectorAll('[data-turn="t1"] .task')].map((e) => e.parentElement.textContent.trim())`), 'a task item shows its box as an icon, not as [x]').toEqual(['measured', 'fixed']);

    await panel.click('[data-turn="t1"] .rewind-button');
    await panel.waitFor('the message menu', () => shown(panel, '[data-turn="t1"] .rewind-menu'));
    const items = await panel.eval<string[]>(`[...doc.querySelectorAll('[data-turn="t1"] .rewind-menu .model-option-name')].map((e) => e.textContent)`);
    expect(items.at(-1), 'the message menu ends with Save as page').toBe('Save as page');
    await panel.screenshot('message-menu-dark');
    await panel.click('[data-turn="t1"] .rewind-menu [data-action="save-page"]');
    const answer = await panel.host.next('save-page');
    expect(answer.page.kind).toBe('answer');
    if (answer.page.kind !== 'answer') return;
    expect(answer.page.turnId).toBe('t1');
    expect(answer.page.diagrams.map(({ source, scheme }) => ({ source, scheme }))).toEqual([{ source: DIAGRAM, scheme: 'dark' }]);
    expect(answer.page.diagrams[0]!.svg).toMatch(/^<svg[\s\S]*Cache[\s\S]*<\/svg>$/);
    expect(await shown(panel, '[data-turn="t1"] .rewind-menu'), 'choosing closes the menu').toBe(false);

    const drawing = () => panel.eval<string>(`doc.querySelector('.diagram svg style')?.textContent ?? ''`);
    const dark = await drawing();
    await panel.theme('light');
    await panel.waitFor('the diagram drawn again for light', async () => (await drawing()) !== dark && (await drawing()) !== '');
    await panel.click('[data-turn="t1"] .rewind-button');
    await panel.click('[data-turn="t1"] .rewind-menu [data-action="save-page"]');
    const light = await panel.host.next('save-page');
    expect(light.page.kind === 'answer' && light.page.diagrams.map((d) => d.scheme)).toEqual(['light']);
    await panel.theme('dark');

    await panel.click('.widget[data-widget="tu_w"] .widget-more');
    await panel.waitFor('the widget menu', () => shown(panel, '.widget[data-widget="tu_w"] .widget-menu'));
    expect(await panel.eval<string[]>(`[...doc.querySelectorAll('.widget-menu-item')].map((e) => e.textContent)`)).toEqual(['Copy as Image', 'Save as Page', 'Open in Editor']);
    await panel.click('.widget[data-widget="tu_w"] [data-action="save-page"]');
    expect((await panel.host.next('save-page')).page).toEqual({ kind: 'widget', toolId: 'tu_w' });
    await panel.close();
  });

  it('offers no Save as page on a message whose answer has nothing to show', async () => {
    const panel = await openPanel();
    await panel.host.act({ ...turnStart('t1', 'Read it'), seq: 1 } as Action, toolStart('tu_r', { name: 'read', input: { path: 'a.ts' } }), toolEnd('tu_r', 'completed', 'x'), {
      type: 'turn-end',
      at: Date.now(),
      status: 'done',
      usage: usageOf('qwen3.8-flash'),
      seq: 2,
    });
    await panel.waitFor('the message menu button', async () => (await panel.count('[data-turn="t1"] .rewind-button')) === 1);
    await panel.click('[data-turn="t1"] .rewind-button');
    await panel.waitFor('the message menu', () => shown(panel, '[data-turn="t1"] .rewind-menu'));
    expect(await panel.count('[data-turn="t1"] [data-action="save-page"]')).toBe(0);
    await panel.close();
  });
});
