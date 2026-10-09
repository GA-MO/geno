import { afterAll, describe, expect, it } from 'vitest';
import type { ComposerFacts } from '../../src/chat/composer-model.js';
import { fixtureOf, playFixture } from './gallery-stage.js';
import { closeBrowser, type Panel } from './harness.js';

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
