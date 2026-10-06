/// <reference lib="dom" />
import type { ChildStatus } from '@g-code/core';
import { formatElapsed } from './composer-model.js';
import { h, icon } from './dom.js';
import { formatCost, formatDuration } from './format.js';
import type { Child, ToolBlock } from './messages.js';
import { callsStep, type Ui } from './render.js';

/** How each end of a child reads: its icon and the words beside or under it. */
const LOOKS: { readonly [K in ChildStatus['kind']]: (status: Extract<ChildStatus, { kind: K }>) => { readonly icon: string; readonly label: string } } = {
  running: () => ({ icon: 'loading codicon-modifier-spin', label: 'Running' }),
  done: () => ({ icon: 'check', label: 'Done' }),
  failed: ({ reason }) => ({ icon: 'error', label: `Failed: ${reason}` }),
  cancelled: () => ({ icon: 'circle-slash', label: 'Cancelled' }),
  capped: ({ cap }) => ({ icon: 'warning', label: `Stopped at its ${cap === 'turns' ? 'turn' : 'cost'} cap` }),
};

export const childLook = (status: ChildStatus) => (LOOKS[status.kind] as (s: ChildStatus) => { readonly icon: string; readonly label: string })(status);

/**
 * How long the child has run, as the composer's clock reads, then how long it took. A running clock carries its
 * start, and `tickClocks` moves it each second without rebuilding the row, which would take the keyboard from it.
 */
function childTime(child: Child, now: number, ...before: HTMLElement[]): HTMLElement {
  if (child.endedAt !== undefined) return h('span', { class: 'child-time' }, ...before, formatDuration(child.endedAt - child.startedAt));
  return h('span', { class: 'child-time' }, ...before, h('span', { 'data-since': child.startedAt }, formatElapsed(now - child.startedAt)));
}

export function tickClocks(root: ParentNode, now: number): void {
  for (const clock of root.querySelectorAll<HTMLElement>('[data-since]')) clock.textContent = formatElapsed(now - Number(clock.dataset['since']));
}

/** A child's cost is known once it ends. */
export const childCost = (child: Child): string | undefined => (child.costUsd === undefined || child.costUsd === null ? undefined : formatCost(child.costUsd));

const isRunning = (child: Child): boolean => child.status.kind === 'running';

const cancelButton = (child: Child, ui: Ui): HTMLElement =>
  h(
    'button',
    { type: 'button', class: 'button ghost small child-cancel', 'data-focus': `cancel:${child.id}`, title: `Stop ${child.role}; the turn goes on with what it found`, onclick: () => ui.post({ type: 'cancel-child', id: child.id }) },
    'Cancel',
  );

/**
 * One child under its `agent` call: role, model, how long, and the cost once known. A running child's leading slot
 * holds its helper dino, which the view puts there after each render.
 */
function childRow(child: Child, ui: Ui, now: number): HTMLElement {
  const look = childLook(child.status);
  const cost = childCost(child);
  return h(
    'li',
    { class: `child-row child-${child.status.kind}`, 'data-child': child.id },
    h(
      'button',
      { type: 'button', class: 'child-open', 'data-focus': `child:${child.id}`, title: `${child.role}: ${look.label}. Open its transcript.`, onclick: () => ui.openChild(child.id) },
      isRunning(child) ? h('span', { class: 'helper-slot', 'data-helper': child.id }) : icon(look.icon, `child-status status-${child.status.kind}`),
      h('span', { class: 'child-role' }, child.role),
      h('span', { class: 'child-model' }, child.model),
      h('span', { class: 'spacer' }),
      childTime(child, now),
      cost !== undefined && h('span', { class: 'child-cost' }, cost),
      icon('chevron-right', 'chevron'),
    ),
    isRunning(child) && cancelButton(child, ui),
  );
}

/** An `agent` call as a step: the call itself, then the children it started, each opening its own transcript. */
export function agentStep(key: string, tool: ToolBlock, children: readonly Child[], ui: Ui, quiet: boolean, now: number): HTMLElement {
  const step = callsStep(key, tool.name, [tool], ui, quiet);
  if (children.length === 0) return step;
  step.append(h('ul', { class: 'child-list', 'aria-label': 'Subagents' }, ...children.map((child) => childRow(child, ui, now))));
  return step;
}

/** The side view's head: Back, then the child's role, model, status, time and cost, with Cancel while it runs. */
export function childHead(child: Child, ui: Ui, now: number, back: () => void): HTMLElement {
  const look = childLook(child.status);
  const cost = childCost(child);
  return h(
    'div',
    { class: 'child-head' },
    h('div', { class: 'child-bar' },
      h('button', { type: 'button', class: 'button ghost small child-back', 'data-focus': 'child-back', title: 'Back to the chat (Escape)', onclick: back }, icon('arrow-left'), 'Back'),
      h('span', { class: 'spacer' }),
      isRunning(child) && cancelButton(child, ui),
    ),
    h(
      'div',
      { class: 'child-title' },
      h('span', { class: 'child-role' }, child.role),
      h('span', { class: 'child-model' }, child.model),
    ),
    h(
      'div',
      { class: 'child-meta' },
      h('span', { class: `child-state status-${child.status.kind}` }, icon(look.icon), look.label),
      childTime(child, now, icon('clock')),
      cost !== undefined && h('span', { class: 'child-cost' }, cost),
      child.turns > 0 && h('span', { class: 'child-turns' }, `${child.turns} model ${child.turns === 1 ? 'call' : 'calls'}`),
    ),
    h('div', { class: 'child-task' }, child.turn.prompt),
  );
}
