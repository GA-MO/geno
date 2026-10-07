import type { PreviewRow, WorkflowPreview } from '@g-code/core';
import { h, icon, type Child } from './dom.js';
import { formatCost as formatUsd } from './format.js';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What one step may spend: its estimate, then its caps, which are the most it can. */
function rowCost(row: PreviewRow): string {
  if (row.caps === undefined) return row.kind === 'check' ? "Runs the project's check" : 'Free: reads an earlier step';
  const about = row.estimateUsd === null ? 'Price unknown' : `About ${formatUsd(row.estimateUsd)}`;
  return `${about} · up to ${formatUsd(row.caps.maxCostUsd)} and ${plural(row.caps.maxTurns, 'model call')}`;
}

function rowWhat(row: PreviewRow): string {
  if (row.kind !== 'agent') return row.kind === 'check' ? 'Gate' : 'Gate on a field';
  return [row.role, row.model, row.readOnly ? 'read-only' : 'can edit', ...(row.lane === undefined ? [] : [`lane ${row.lane}`])].join(' · ');
}

const stepItem = (row: PreviewRow): HTMLElement =>
  h(
    'li',
    { class: `workflow-step workflow-step-${row.kind}`, 'data-step': row.id },
    h('span', { class: 'workflow-step-name' }, row.label),
    h('span', { class: 'workflow-step-what' }, rowWhat(row)),
    h('span', { class: 'workflow-step-cost' }, rowCost(row)),
  );

/** The total in words: the estimate, the most every step together can spend, and the cap that stops the run. */
export function previewTotal(preview: WorkflowPreview): string {
  const about = preview.estimateUsd === null ? 'Cost unknown' : `About ${formatUsd(preview.estimateUsd)}`;
  const most = Math.min(preview.worstUsd, preview.capUsd);
  return `${about}, at most ${formatUsd(most)}. The run stops cleanly at its total cap of ${formatUsd(preview.capUsd)}.`;
}

/** The workflow card's body: what runs, step by step, and what it may spend. Every text is a text node. */
export function workflowCardBody(preview: WorkflowPreview): Child[] {
  return [
    h('p', { class: 'workflow-name' }, h('code', {}, preview.name), ' ', preview.description),
    preview.input !== '' && h('p', { class: 'workflow-input' }, h('span', { class: 'workflow-label' }, 'Input'), ' ', preview.input),
    h('ol', { class: 'workflow-steps', 'aria-label': 'Steps' }, ...preview.rows.map(stepItem)),
    h('p', { class: 'workflow-total' }, icon('credit-card'), h('span', {}, previewTotal(preview))),
    preview.stopsBefore !== undefined &&
      h('p', { class: 'permission-reason workflow-note' }, `If every step spent its whole cap, the total cap would stop the run before ${preview.stopsBefore}.`),
    preview.unpriced.length > 0 && h('p', { class: 'permission-reason workflow-note' }, `No price is known for ${preview.unpriced.join(', ')}, so its cost caps cannot hold.`),
    h('p', { class: 'permission-reason' }, 'Each step runs as a subagent in the background, listed in Tasks.'),
    h('p', { class: 'permission-reason workflow-path' }, 'From ', h('code', {}, preview.path)),
  ];
}
