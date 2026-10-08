import type { CallProgress } from '@g-code/core';
import { afterAll, describe, expect, it } from 'vitest';
import { closeBrowser, openPanel, type Panel } from './harness.js';
import { turnStart } from './turns.js';

afterAll(closeBrowser);

const workingRow = (panel: Panel) => panel.eval<string | null>(`doc.querySelector('[data-turn="t0"] .thinking')?.textContent ?? null`);
const noticeRow = (panel: Panel) => panel.eval<string | null>(`doc.querySelector('[data-turn="t0"] .turn-notice')?.textContent ?? null`);

const tryOf = (fields: Partial<CallProgress>): CallProgress => ({ requestAt: Date.now(), lastByteAt: null, limitMs: 180_000, writing: null, tokens: 0, ...fields });

describe('the working row while a model call streams', () => {
  it('counts what the model writes, says when it has sent nothing for a while, and gives way to a retry', async () => {
    const panel = await openPanel();
    const { host } = panel;
    await panel.waitFor('the panel to render', async () => (await panel.count('.transcript')) === 1);
    await host.act(turnStart('t0', 'Build the pacman game'));
    await panel.waitFor('the working row', async () => (await workingRow(panel)) === 'Thinking');

    await host.act({ type: 'progress', progress: tryOf({ lastByteAt: Date.now(), writing: { kind: 'thinking' }, tokens: 640 }) });
    await panel.waitFor('thinking with a count', async () => (await workingRow(panel)) === 'Thinking · ↓ 640 tokens');

    await host.act({ type: 'progress', progress: tryOf({ lastByteAt: Date.now(), writing: { kind: 'tool', name: 'edit', target: 'src/game.ts' }, tokens: 7851 }) });
    await panel.waitFor('the tool call being written', async () => (await workingRow(panel)) === 'Writing edit src/game.ts · ↓ 7.9k tokens');
    await panel.screenshot('progress-streaming');

    await host.act({ type: 'progress', progress: tryOf({ requestAt: Date.now() - 42_000 }) });
    await panel.waitFor('no response yet', async () => /^No response from the model after 4\ds · waiting up to 3m$/.test((await workingRow(panel)) ?? ''));
    await panel.screenshot('progress-no-response');

    await host.act({ type: 'progress', progress: tryOf({ requestAt: Date.now() - 100_000, lastByteAt: Date.now() - 95_000, writing: { kind: 'thinking' }, tokens: 3200 }) });
    await panel.waitFor('gone quiet', async () => /^The model went quiet 1m 3\ds ago · waiting up to 3m$/.test((await workingRow(panel)) ?? ''));

    await host.act({ type: 'notice', text: 'Retrying in 1s (the model went quiet)' });
    await panel.waitFor('the retry notice', async () => (await noticeRow(panel)) === 'Retrying in 1s (the model went quiet)');
    expect(await workingRow(panel), 'the retry notice stands in for the working row').toBeNull();
    await panel.screenshot('progress-retrying');

    await host.act({ type: 'progress', progress: tryOf({}) });
    await panel.waitFor('the next try', async () => (await workingRow(panel)) === 'Thinking');
    expect(await noticeRow(panel), 'the next try going out clears the retry notice').toBeNull();

    await host.act({ type: 'text', text: 'Here is the maze.' });
    await panel.waitFor('the answer', async () => (await panel.count('[data-turn="t0"] .step-text')) === 1);
    expect(await workingRow(panel), 'the answer replaces the working row').toBeNull();
  });
});
