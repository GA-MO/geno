/// <reference lib="dom" />
import type { BreakdownView, CostText, SpendRow } from '@g-code/core';
import { h, icon } from './dom.js';
import type { UsageCard, UsageTab } from './usage-model.js';

const TABS: readonly { readonly tab: UsageTab; readonly label: string }[] = [
  { tab: 'turn', label: 'This turn' },
  { tab: 'session', label: 'Session' },
];

const cost = (c: CostText): HTMLElement => h('span', { class: 'usage-cost' }, h('span', { class: 'usage-baht' }, c.baht), h('span', { class: 'usage-usd' }, c.usd));

/** The share drawn through CSSOM, which the webview's CSP allows where a style attribute is not. */
function bar(share: number): HTMLElement {
  const fill = h('span', { class: 'usage-bar-fill' });
  fill.style.width = `${Math.max(0, Math.min(1, share)) * 100}%`;
  return h('span', { class: 'usage-bar', 'aria-hidden': 'true' }, fill);
}

const row = (r: SpendRow): HTMLElement =>
  h(
    'li',
    { class: r.driver ? 'usage-row driver' : 'usage-row', 'data-part': r.key },
    h('span', { class: 'usage-label' }, r.label),
    h('span', { class: 'usage-tokens' }, r.tokens),
    h('span', { class: 'usage-percent' }, r.percent),
    bar(r.share),
    cost(r.cost),
  );

function breakdown(view: BreakdownView, total: Node): HTMLElement[] {
  return [
    ...(view.driver === undefined ? [] : [h('p', { class: 'usage-driver' }, icon('flame'), h('span', {}, view.driver))]),
    h('ul', { class: 'usage-rows', 'aria-label': 'Parts' }, ...view.rows.map(row)),
    h('p', { class: 'usage-total' }, total),
    h('p', { class: 'usage-meta usage-cache' }, view.cache),
    h('p', { class: view.basis === 'estimated' ? 'usage-meta usage-note estimated' : 'usage-meta usage-note' }, view.note),
  ];
}

const totalLine = (...parts: readonly (string | Node)[]): HTMLElement => h('span', { class: 'usage-total-text' }, ...parts.flatMap((p, i) => (i === 0 ? [p] : [' · ', p])));

function body(card: UsageCard): HTMLElement[] {
  switch (card.kind) {
    case 'loading':
      return [h('p', { class: 'usage-meta' }, icon('loading', 'codicon-modifier-spin'), ' Reading the session log…')];
    case 'failed':
      return [h('p', { class: 'usage-meta failed' }, card.message)];
    case 'turn': {
      const { view } = card;
      if (view.kind === 'external') return [h('p', { class: 'usage-external' }, view.text), ...(view.cost === undefined ? [] : [h('p', { class: 'usage-total' }, totalLine('Reported', cost(view.cost)))])];
      return breakdown(view, totalLine(view.requests, `${view.tokens} tokens`, cost(view.cost)));
    }
    case 'session': {
      const { view } = card;
      return [
        h('p', { class: 'usage-total usage-session-total' }, totalLine(view.turns, cost(view.cost))),
        ...(view.external === undefined ? [] : [h('p', { class: 'usage-external' }, view.external)]),
        ...(view.top.length === 0
          ? []
          : [
              h('p', { class: 'usage-heading' }, 'Costliest turns'),
              h(
                'ol',
                { class: 'usage-top' },
                ...view.top.map((t) =>
                  h(
                    'li',
                    { class: 'usage-top-turn', 'data-seq': t.seq },
                    h('span', { class: 'usage-top-prompt', title: t.prompt }, t.prompt),
                    cost(t.cost),
                    t.driver !== undefined && h('span', { class: 'usage-top-driver' }, t.driver),
                  ),
                ),
              ),
            ]),
        ...(view.children === undefined ? [] : [h('p', { class: 'usage-children' }, icon('organization'), h('span', {}, `${view.children.count}`), cost(view.children.cost))]),
        ...(view.breakdown === undefined ? [] : [h('p', { class: 'usage-heading' }, 'By part'), ...breakdown(view.breakdown, totalLine(view.breakdown.requests, `${view.breakdown.tokens} tokens`, cost(view.breakdown.cost)))]),
      ];
    }
  }
}

/** The breakdown card under a turn: its tabs, its close button, and the open tab's numbers. */
export function usageCardView(turn: string, tab: UsageTab, card: UsageCard, onTab: (tab: UsageTab) => void, onClose: () => void): HTMLElement {
  const tabs = h(
    'div',
    { class: 'usage-tabs', role: 'tablist', 'aria-label': 'Where the tokens went' },
    ...TABS.map((t) =>
      h('button', { type: 'button', role: 'tab', class: t.tab === tab ? 'usage-tab selected' : 'usage-tab', 'aria-selected': String(t.tab === tab), 'data-tab': t.tab, 'data-focus': `usage-tab:${turn}:${t.tab}`, onclick: () => onTab(t.tab) }, t.label),
    ),
    h('button', { type: 'button', class: 'icon-button usage-close', title: 'Close', 'aria-label': 'Close the breakdown', 'data-focus': `usage-close:${turn}`, onclick: onClose }, icon('close')),
  );
  const section = h('section', { class: 'usage-card', 'aria-label': 'Where the tokens went', role: 'tabpanel' }, tabs, ...body(card));
  section.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    onClose();
  });
  return section;
}
