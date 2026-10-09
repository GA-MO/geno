import { afterAll, describe, expect, it } from 'vitest';
import type { ComposerFacts } from '../../src/chat/composer-model.js';
import { BUILTIN_OPTIONS } from '../../src/chat/slash-route.js';
import { fixtureOf, playFixture } from './gallery-stage.js';
import { closeBrowser, openPanel, type Panel } from './harness.js';
import { turnStart } from './turns.js';

afterAll(closeBrowser);

/** A composer whose context is nearly full, so the row also carries the Compact offer. */
const NEARLY_FULL: ComposerFacts = {
  provider: 'modelstudio',
  effort: { current: 'medium', options: ['low', 'medium', 'high'].map((value) => ({ value, name: value })) },
  models: [{ provider: 'modelstudio', providerLabel: 'Alibaba Model Studio', model: 'qwen3.8-flash' }],
  backends: [],
  agentModels: undefined,
  context: { used: 240_000, window: 262_144 },
  turnCostUsd: undefined,
  bahtPerUsd: 0,
};

type Row = {
  readonly chevron: { readonly width: number; readonly height: number; readonly hitsLeft: boolean; readonly hitsRight: boolean };
  readonly outside: readonly string[];
  readonly overlaps: readonly string[];
  readonly squeezed: boolean;
  /** How much of the model name the chevron costs: its width with the chevron hidden, less its width with it shown. */
  readonly modelCost: number;
};

/** What the 16px chevron cost the model name: its 10px of row and one 8px gap. */
const OLD_CHEVRON_COST = 18;

/** The toolbar's visible controls: each one's box against the row, against its neighbours, and what a click at the chevron's edges lands on. */
const rowOf = (panel: Panel) =>
  panel.eval<Row>(`(() => {
    const row = doc.querySelector('.input-toolbar');
    const edge = row.getBoundingClientRect();
    const controls = [...row.querySelectorAll('.toolbar-left > *, .toolbar-right > *')].filter((e) => e.getClientRects().length > 0);
    const boxes = controls.map((e) => ({ name: e.className, box: e.getBoundingClientRect() }));
    const chevron = doc.querySelector('.send-more');
    const c = chevron.getBoundingClientRect();
    const hits = (x) => chevron.contains(doc.elementFromPoint(x, c.top + c.height / 2));
    const name = doc.querySelector('.composer-model .model-name');
    const shown = name.clientWidth;
    chevron.hidden = true;
    const modelCost = name.clientWidth - shown;
    chevron.hidden = false;
    return {
      modelCost,
      chevron: { width: c.width, height: c.height, hitsLeft: hits(c.left + 0.5), hitsRight: hits(c.right - 0.5) },
      outside: boxes.filter(({ box }) => box.left < edge.left - 0.5 || box.right > edge.right + 0.5).map(({ name }) => name),
      overlaps: boxes.slice(1).filter(({ box }, i) => box.left < boxes[i].box.right - 0.5).map(({ name }, i) => boxes[i].name + ' / ' + name),
      squeezed: [...row.children].some((side) => side.scrollWidth > side.clientWidth),
    };
  })()`);

describe('the send menu chevron', () => {
  it('hits at 24px, as the other composer icons do, and the 300px row keeps every control', async () => {
    const panel = await playFixture(fixtureOf('peek'));
    for (const facts of [undefined, NEARLY_FULL]) {
      if (facts !== undefined) {
        await panel.host.post({ type: 'composer', facts });
        await panel.waitFor('the Compact offer', async () => (await panel.count('.compact-offer:not([hidden])')) > 0);
      }
      const row = await rowOf(panel);
      expect(row.chevron.width, 'the chevron is 24px wide').toBeGreaterThanOrEqual(24);
      expect(row.chevron.height, 'and 24px tall').toBeGreaterThanOrEqual(24);
      expect(row.chevron.hitsLeft && row.chevron.hitsRight, 'a click anywhere across the 24px lands on the chevron').toBe(true);
      expect(row.outside, 'no control runs past the row').toEqual([]);
      expect(row.overlaps, 'no control covers another').toEqual([]);
      expect(row.squeezed, 'neither side of the row is cut off').toBe(false);
      expect(row.modelCost, 'the chevron takes no more of the model name than the 16px one did').toBeLessThanOrEqual(OLD_CHEVRON_COST);
    }
    await panel.close();
  });
});

const laneKeyOf = (panel: Panel) => panel.eval<string>(`/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘⇧Enter' : 'Ctrl+Shift+Enter'`);
const lanesSent = (panel: Panel) => panel.host.received.flatMap((m) => (m.type === 'lane-new' ? [m.text] : []));
const viewOf = (panel: Panel) => panel.eval<string>('doc.body.dataset.view');
const draftOf = (panel: Panel) => panel.eval<string>('doc.querySelector("textarea").value');

async function typeDraft(panel: Panel, text: string): Promise<void> {
  await panel.click('textarea');
  await panel.type(text);
}

describe('the run-in-a-lane shortcut', () => {
  it('runs the draft in a new lane and opens the Lanes pane', async () => {
    const panel = await openPanel({ width: 300 });
    await typeDraft(panel, '  fix the flaky test  ');
    await panel.press('ControlOrMeta+Shift+Enter');
    await panel.waitFor('the Lanes pane', async () => (await viewOf(panel)) === 'lanes');
    expect(lanesSent(panel), 'the trimmed draft went to one new lane').toEqual(['fix the flaky test']);
    expect(await draftOf(panel), 'the draft is cleared').toBe('');
    expect(panel.host.received.filter((m) => m.type === 'send'), 'nothing went to the chat').toEqual([]);
    await panel.close();
  });

  it('does nothing without a draft', async () => {
    const panel = await openPanel({ width: 300 });
    await typeDraft(panel, '   ');
    await panel.press('ControlOrMeta+Shift+Enter');
    await panel.host.settled();
    await panel.frame();
    expect(lanesSent(panel), 'no lane').toEqual([]);
    expect(await viewOf(panel), 'the chat stays').toBe('chat');
    await panel.close();
  });

  it('shows in the menu item and on the chevron', async () => {
    const panel = await playFixture(fixtureOf('composer-send-menu'));
    const key = await laneKeyOf(panel);
    expect(await panel.eval<string | null>(`doc.querySelector('#send-menu [data-action="lane"] .model-option-detail')?.textContent ?? null`), 'the item names the shortcut').toBe(key);
    expect(await panel.eval<string>(`doc.querySelector('.send-more').title`), 'the chevron names it').toBe(`More ways to send (${key} runs in a new lane)`);
    await panel.close();
  });
});

const usageShown = (panel: Panel) => panel.eval<string | null>(`(() => { const note = doc.querySelector('.lane-usage'); return note && !note.hidden ? note.textContent : null; })()`);

describe('/lane', () => {
  it('runs its task in a new lane, as the menu item does, even while a turn runs', async () => {
    const panel = await openPanel({ width: 300 });
    await panel.host.act(turnStart('t0', 'Refactor the settings page'));
    await typeDraft(panel, '/lane fix the flaky test');
    await panel.press('Enter');
    await panel.waitFor('the Lanes pane', async () => (await viewOf(panel)) === 'lanes');
    expect(lanesSent(panel), 'the task alone went to one new lane').toEqual(['fix the flaky test']);
    expect(await draftOf(panel), 'the draft is cleared').toBe('');
    expect(await panel.count('.queued-chip:not([hidden])'), 'nothing waits as a follow-up').toBe(0);
    expect(panel.host.received.filter((m) => m.type === 'send'), 'nothing went to the chat').toEqual([]);
    await panel.close();
  });

  it('alone shows its usage and runs nothing', async () => {
    const panel = await openPanel({ width: 300 });
    await typeDraft(panel, '/lane');
    await panel.press('Escape');
    await panel.press('Enter');
    await panel.waitFor('the usage', async () => (await usageShown(panel)) !== null);
    expect(await usageShown(panel)).toBe('Type the task after /lane, such as /lane fix the flaky test.');
    expect(lanesSent(panel), 'no lane').toEqual([]);
    expect(panel.host.received.filter((m) => m.type === 'send'), 'nothing went to the chat').toEqual([]);
    expect(await draftOf(panel), 'the draft stays to finish').toBe('/lane');
    await panel.screenshot('lane-usage');
    await panel.type(' x');
    await panel.waitFor('the usage to go once the draft changes', async () => (await usageShown(panel)) === null);
    await panel.close();
  });

  it('is in the slash menu with its hint', async () => {
    const panel = await openPanel({ width: 300 });
    await panel.host.post({ type: 'commands', commands: BUILTIN_OPTIONS });
    await typeDraft(panel, '/la');
    await panel.waitFor('the slash menu', async () => (await panel.count('#commands:not([hidden])')) > 0);
    const row = await panel.eval<string | null>(`doc.querySelector('#commands [data-command="lane"]')?.textContent ?? null`);
    expect(row).toBe('/lane<task>Run a task in a new lane, in the background');
    await panel.close();
  });
});
