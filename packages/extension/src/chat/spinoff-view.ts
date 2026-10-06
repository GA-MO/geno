/// <reference lib="dom" />
import { h, icon } from './dom.js';
import type { SpinoffCard, SpinoffFromView } from './spinoff-model.js';

export type SpinoffUi = { readonly post: (message: SpinoffFromView) => void; readonly start: (id: string) => void };

/**
 * A suggested task. Open, it shows what the agent noticed and why, the prompt the task would start with behind a
 * fold, and Start and Dismiss. Started, it folds to one row that opens the task. `where` keeps the focus keys of
 * the transcript's card and the Tasks pane's apart.
 */
export function spinoffCard(card: Exclude<SpinoffCard, { kind: 'hidden' }>, ui: SpinoffUi, where: 'turn' | 'pane'): HTMLElement {
  const { spinoff } = card;
  const focus = (action: string) => `spinoff-${action}:${where}:${spinoff.id}`;
  if (card.kind === 'started') {
    return h(
      'section',
      { class: 'spinoff', 'data-state': 'started', 'data-spinoff': spinoff.id, 'aria-label': `Started task: ${spinoff.title}` },
      h(
        'div',
        { class: 'spinoff-started' },
        icon('git-branch', 'spinoff-icon'),
        h(
          'span',
          { class: 'spinoff-started-body' },
          h('span', { class: 'spinoff-started-text' }, h('span', { class: 'spinoff-verb' }, 'Started'), ' ', spinoff.title),
          h('span', { class: 'spinoff-where', title: `Runs in lane ${card.lane}` }, 'in lane ', h('code', { class: 'spinoff-lane' }, card.lane)),
        ),
        h('button', { type: 'button', class: 'button small secondary', 'data-action': 'open', 'data-focus': focus('open'), title: 'Open the task in the panel', onclick: () => ui.post({ type: 'spinoff-open', id: spinoff.id }) }, 'Open'),
      ),
    );
  }
  const body = `spinoff-prompt-${where}-${spinoff.id}`;
  return h(
    'section',
    { class: 'spinoff', 'data-state': 'offered', 'data-spinoff': spinoff.id, 'aria-label': `Suggested task: ${spinoff.title}` },
    h('p', { class: 'spinoff-eyebrow' }, icon('lightbulb', 'spinoff-icon'), h('span', {}, 'Suggested task')),
    h('h4', { class: 'spinoff-title' }, spinoff.title),
    h('p', { class: 'spinoff-tldr' }, spinoff.tldr),
    h(
      'details',
      { class: 'spinoff-prompt' },
      h('summary', { 'aria-controls': body }, 'Prompt it starts with'),
      h('p', { class: 'spinoff-prompt-text', id: body }, spinoff.prompt),
    ),
    card.problem !== undefined && h('p', { class: 'spinoff-problem', role: 'alert' }, icon('warning'), h('span', {}, card.problem)),
    h(
      'div',
      { class: 'spinoff-actions' },
      h(
        'button',
        { type: 'button', class: 'button small', 'data-action': 'start', 'data-focus': focus('start'), disabled: card.starting, title: 'Start it as a new task in its own lane', onclick: () => ui.start(spinoff.id) },
        card.starting ? 'Starting…' : 'Start',
      ),
      h('button', { type: 'button', class: 'button small ghost', 'data-action': 'dismiss', 'data-focus': focus('dismiss'), disabled: card.starting, onclick: () => ui.post({ type: 'spinoff-dismiss', id: spinoff.id }) }, 'Dismiss'),
      h('span', { class: 'spinoff-hint' }, 'Runs in its own lane'),
    ),
  );
}
