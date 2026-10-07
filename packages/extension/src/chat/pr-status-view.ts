/// <reference lib="dom" />
import { h, icon } from './dom.js';
import type { FromView } from './messages.js';
import type { PrStatusLine } from './pr-status-model.js';

const COUNTS: readonly { readonly key: 'fail' | 'pending' | 'pass'; readonly icon: string; readonly word: string }[] = [
  { key: 'fail', icon: 'error', word: 'failed' },
  { key: 'pending', icon: 'circle-large-outline', word: 'pending' },
  { key: 'pass', icon: 'pass', word: 'passed' },
];

function prRow(line: Extract<PrStatusLine, { kind: 'pr' }>, post: (message: FromView) => void): HTMLElement {
  const counts = COUNTS.filter(({ key }) => line.checks[key] > 0);
  const checks = counts.length === 0 ? 'no checks' : `checks ${counts.map(({ key, word }) => `${line.checks[key]} ${word}`).join(', ')}`;
  const label = `${[`Pull request #${line.number}`, line.title, ...(line.state === '' ? [] : [line.state]), checks].join(', ')}. Opens on GitHub.`;
  return h(
    'button',
    { type: 'button', class: `pr-status pr-${line.tone}`, title: line.tooltip, 'aria-label': label, onclick: () => post({ type: 'open-pr' }) },
    icon(line.tone === 'merged' ? 'git-merge' : line.tone === 'closed' ? 'git-pull-request-closed' : line.tone === 'draft' ? 'git-pull-request-draft' : 'git-pull-request', 'pr-icon'),
    h('span', { class: 'pr-number' }, `#${line.number}`),
    h('span', { class: 'pr-title' }, line.title),
    line.state !== '' && h('span', { class: 'pr-state' }, line.state),
    h('span', { class: 'pr-checks', 'aria-hidden': 'true' }, ...counts.map(({ key, icon: name }) => h('span', { class: `pr-count pr-${key}` }, icon(name), String(line.checks[key])))),
  );
}

function helpRow(line: Extract<PrStatusLine, { kind: 'help' }>, post: (message: FromView) => void): HTMLElement {
  return h(
    'div',
    { class: 'pr-status pr-help' },
    icon('github', 'pr-icon'),
    h('button', { type: 'button', class: 'pr-help-text', title: 'Open cli.github.com', onclick: () => post({ type: 'open-pr' }) }, line.text),
    h('button', { type: 'button', class: 'pr-help-close', title: 'Hide', 'aria-label': 'Hide this hint', onclick: () => post({ type: 'hide-pr-help' }) }, icon('close')),
  );
}

/** The status line above the composer: the branch's PR and its checks, a hint to get gh, or nothing. */
export function prStatusBar(post: (message: FromView) => void): { readonly element: HTMLElement; show(line: PrStatusLine | undefined): void } {
  const element = h('div', { class: 'pr-status-slot', hidden: true });
  let shown = '';
  return {
    element,
    show(line) {
      const key = JSON.stringify(line ?? null);
      if (key === shown) return;
      shown = key;
      element.hidden = line === undefined;
      element.replaceChildren(...(line === undefined ? [] : [line.kind === 'pr' ? prRow(line, post) : helpRow(line, post)]));
    },
  };
}
