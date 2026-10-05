/// <reference lib="dom" />
import { diagramBlock } from './diagram-view.js';
import { h, icon, type Child } from './dom.js';
import { formatCost, formatDuration, formatTokens } from './format.js';
import { renderMarkdown } from './markdown.js';
import type { DiffHunk, ErrorBlock, FileDiff, FromView, PermissionBlock, ToolBlock, ToolKind, ToolStatus, Turn, TurnStatus } from './messages.js';

/** What a block needs from the panel around it: the extension, and the view's own fold state. */
export type Ui = {
  readonly post: (message: FromView) => void;
  readonly isOpen: (id: string) => boolean;
  readonly toggle: (id: string) => void;
  readonly isUnfolded: (id: string) => boolean;
  readonly unfold: (id: string) => void;
};

/** Output and hunks longer than this fold behind a "Show all" button. */
const FOLD_LINES = 12;

const KIND_ICONS: Readonly<Record<ToolKind, string>> = { read: 'file', search: 'search', edit: 'edit', execute: 'terminal', other: 'tools' };

const STATUS_ICONS: Readonly<Record<ToolStatus, { readonly name: string; readonly label: string }>> = {
  running: { name: 'loading codicon-modifier-spin', label: 'Running' },
  completed: { name: 'check', label: 'Done' },
  failed: { name: 'error', label: 'Failed' },
  cancelled: { name: 'circle-slash', label: 'Cancelled' },
};

/** What each engine tool is doing, and did. */
const VERBS: Readonly<Record<string, readonly [running: string, finished: string]>> = {
  read: ['Reading', 'Read'],
  grep: ['Searching for', 'Searched for'],
  glob: ['Finding', 'Found'],
  list: ['Listing', 'Listed'],
  edit: ['Editing', 'Edited'],
  bash: ['Running', 'Ran'],
  check: ['Checking for problems', 'Checked for problems'],
};

const verbOf = (tool: ToolBlock): string => {
  const verbs = VERBS[tool.name];
  if (verbs === undefined) return tool.name;
  return tool.status === 'running' ? verbs[0] : verbs[1];
};

const durationOf = (tool: ToolBlock): string | undefined => (tool.endedAt === undefined ? undefined : formatDuration(tool.endedAt - tool.startedAt));

const statusIcon = (status: ToolStatus): HTMLElement => {
  const { name, label } = STATUS_ICONS[status];
  return h('span', { class: `codicon codicon-${name} status status-${status}`, role: 'img', 'aria-label': label, title: label });
};

/** Lines past FOLD_LINES stay hidden until the user asks for them. */
function folded(id: string, lines: readonly string[], ui: Ui, line: (text: string, i: number) => HTMLElement): Child[] {
  const all = ui.isUnfolded(id) || lines.length <= FOLD_LINES;
  const shown = all ? lines : lines.slice(0, FOLD_LINES);
  return [
    ...shown.map(line),
    !all &&
      h(
        'button',
        { class: 'link-button show-all', 'data-focus': `unfold:${id}`, onclick: () => ui.unfold(id) },
        `Show all ${lines.length} lines`,
      ),
  ];
}

export function toolRow(tool: ToolBlock, ui: Ui): HTMLElement {
  if (tool.diff !== undefined) return editCard(tool, tool.diff, ui);
  const output = tool.output?.replace(/\n+$/, '');
  const expandable = output !== undefined && output !== '';
  const open = expandable && ui.isOpen(tool.id);
  const duration = durationOf(tool);
  const row = h(
    'button',
    {
      class: 'tool-row',
      'aria-expanded': expandable ? String(open) : undefined,
      'aria-disabled': expandable ? undefined : 'true',
      'data-focus': `tool:${tool.id}`,
      title: tool.target === '' ? tool.name : `${tool.name} ${tool.target}`,
      onclick: () => expandable && ui.toggle(tool.id),
    },
    icon(open ? 'chevron-down' : 'chevron-right', expandable ? 'chevron' : 'chevron hidden'),
    icon(KIND_ICONS[tool.toolKind], 'kind'),
    h('span', { class: 'tool-label' }, verbOf(tool)),
    tool.target !== '' && h('code', { class: 'tool-target' }, tool.target),
    h('span', { class: 'spacer' }),
    duration !== undefined && h('span', { class: 'tool-duration' }, duration),
    statusIcon(tool.status),
  );
  const body =
    open &&
    h(
      'div',
      { class: 'tool-output' },
      h('pre', {}, ...folded(`out:${tool.id}`, output.split('\n'), ui, (text) => h('div', { class: 'out-line' }, text || ' '))),
    );
  return h('div', { class: `tool tool-${tool.status}`, 'data-tool': tool.id }, row, body);
}

function counts(diff: FileDiff): { readonly added: number; readonly removed: number } {
  return {
    added: diff.hunks.reduce((n, hunk) => n + hunk.added.length, 0),
    removed: diff.hunks.reduce((n, hunk) => n + hunk.removed.length, 0),
  };
}

const DECISIONS: Readonly<Record<Exclude<DiffHunk['status'], 'pending'>, { readonly icon: string; readonly label: string }>> = {
  kept: { icon: 'check', label: 'Kept' },
  undone: { icon: 'discard', label: 'Undone' },
};

function hunkControls(hunk: DiffHunk, ui: Ui): HTMLElement {
  if (hunk.status !== 'pending') {
    const decision = DECISIONS[hunk.status];
    return h('span', { class: `decision decision-${hunk.status}` }, icon(decision.icon), decision.label);
  }
  return h(
    'span',
    { class: 'hunk-actions' },
    h('button', { class: 'button secondary small', 'data-focus': `undo:${hunk.id}`, onclick: () => ui.post({ type: 'undo', hunk: hunk.id }) }, 'Undo'),
    h('button', { class: 'button small', 'data-focus': `keep:${hunk.id}`, onclick: () => ui.post({ type: 'keep', hunk: hunk.id }) }, 'Keep'),
  );
}

function hunkView(hunk: DiffHunk, ui: Ui): HTMLElement {
  const lines = [...hunk.removed.map((text) => ['removed', text] as const), ...hunk.added.map((text) => ['added', text] as const)];
  return h(
    'div',
    { class: `hunk hunk-${hunk.status}`, 'data-hunk': hunk.id },
    h('div', { class: 'hunk-head' }, h('span', { class: 'hunk-line' }, `Line ${hunk.line}`), h('span', { class: 'spacer' }), hunkControls(hunk, ui)),
    h(
      'div',
      { class: 'hunk-lines' },
      ...folded(`hunk:${hunk.id}`, lines.map(([, text]) => text), ui, (text, i) =>
        h('div', { class: `diff-line ${lines[i]![0]}` }, h('span', { class: 'sign', 'aria-label': lines[i]![0] === 'added' ? 'added' : 'removed' }, lines[i]![0] === 'added' ? '+' : '-'), h('span', { class: 'code' }, text || ' ')),
      ),
    ),
  );
}

function editCard(tool: ToolBlock, diff: FileDiff, ui: Ui): HTMLElement {
  const { added, removed } = counts(diff);
  const slash = diff.path.lastIndexOf('/');
  const name = diff.path.slice(slash + 1);
  const dir = slash === -1 ? '' : diff.path.slice(0, slash);
  const first = diff.hunks.find((hunk) => hunk.status === 'pending') ?? diff.hunks[0];
  return h(
    'section',
    { class: 'edit-card', 'data-tool': tool.id, 'aria-label': `Edit to ${diff.path}` },
    h(
      'div',
      { class: 'edit-head' },
      icon('diff', 'kind'),
      h(
        'button',
        { class: 'link-button file-name', title: `Open ${diff.path}`, 'data-focus': `open:${tool.id}`, onclick: () => first !== undefined && ui.post({ type: 'reveal', hunk: first.id }) },
        name,
      ),
      dir !== '' && h('span', { class: 'file-dir' }, dir),
      h('span', { class: 'line-counts' }, h('span', { class: 'lines-added' }, `+${added}`), h('span', { class: 'lines-removed' }, `−${removed}`)),
      h('span', { class: 'spacer' }),
      tool.status !== 'completed' && statusIcon(tool.status),
    ),
    ...diff.hunks.map((hunk) => hunkView(hunk, ui)),
  );
}

/** Option kinds as the panel names their buttons; the first allow is the default the card focuses. */
const CHOICE_LABELS: Readonly<Record<string, string>> = {
  allow_once: 'Allow',
  allow_always: 'Always Allow',
  reject_once: 'Deny',
  reject_always: 'Always Deny',
};

export function permissionCard(block: PermissionBlock, ui: Ui): HTMLElement {
  const { outcome } = block;
  const chosen = outcome.kind === 'chosen' ? block.options.find((o) => o.optionId === outcome.optionId) : undefined;
  const allowed = chosen?.kind.startsWith('allow') === true;
  const result =
    outcome.kind === 'open'
      ? h(
          'div',
          { class: 'permission-actions' },
          ...block.options.map((option) =>
            h(
              'button',
              {
                class: option.kind.startsWith('allow') ? 'button' : 'button secondary',
                'data-focus': `choose:${block.id}:${option.optionId}`,
                onclick: () => ui.post({ type: 'permission', id: block.id, optionId: option.optionId }),
              },
              CHOICE_LABELS[option.kind] ?? option.name,
            ),
          ),
        )
      : h(
          'div',
          { class: `permission-outcome ${allowed ? 'allowed' : 'denied'}` },
          icon(outcome.kind === 'cancelled' ? 'circle-slash' : allowed ? 'check' : 'close'),
          outcome.kind === 'cancelled' ? 'Cancelled' : allowed ? 'Allowed' : 'Denied',
        );
  return h(
    'section',
    { class: `permission permission-${outcome.kind}`, role: 'group', 'aria-label': 'g-code asks to run a command', 'data-permission': block.id },
    h('div', { class: 'permission-title' }, icon('shield'), h('span', {}, 'Run this command?')),
    h('pre', { class: 'permission-command' }, h('code', {}, block.command)),
    h('p', { class: 'permission-reason' }, `g-code asks because it uses ${block.reason}.`),
    result,
  );
}

export const errorBlock = (block: ErrorBlock): HTMLElement =>
  h('div', { class: 'turn-error', role: 'alert' }, icon('error'), h('span', {}, block.message));

/** Assistant text, revealed up to `shown` characters, with a caret while more is coming. */
export function textBlock(text: string, caret: boolean, ui: Ui): HTMLElement {
  const element = h('div', { class: 'markdown' });
  const actions = { copy: (code: string) => ui.post({ type: 'copy', text: code }), open: (source: string) => ui.post({ type: 'open-diagram', source }) };
  element.append(renderMarkdown(text, { copy: actions.copy, diagram: (diagram) => diagramBlock(diagram, actions) }));
  if (caret) {
    const last = element.lastElementChild;
    // The caret follows the last word, inside the paragraph or list item it ends.
    const host = last === null || last.matches('.code-block, .diagram') ? element : (last.matches('ul, ol') ? last.lastElementChild ?? last : last);
    host.append(h('span', { class: 'caret', 'aria-hidden': 'true' }));
  }
  return element;
}

const ENDINGS: Readonly<Record<Exclude<TurnStatus, 'streaming' | 'done'>, { readonly icon: string; readonly label: string }>> = {
  stopped: { icon: 'debug-stop', label: 'Stopped' },
  failed: { icon: 'error', label: 'Failed' },
};

export function turnFooter(turn: Turn): HTMLElement {
  const parts: Child[] = [];
  if (turn.status === 'stopped' || turn.status === 'failed') {
    const ending = ENDINGS[turn.status];
    parts.push(h('span', { class: `ending ending-${turn.status}` }, icon(ending.icon), ending.label));
  }
  if (turn.usage !== undefined) {
    const { model, inputTokens, outputTokens, costUsd } = turn.usage;
    parts.push(
      h('span', { class: 'model' }, model),
      h('span', { title: `${inputTokens} input tokens` }, `${formatTokens(inputTokens)} in`),
      h('span', { title: `${outputTokens} output tokens` }, `${formatTokens(outputTokens)} out`),
      costUsd !== null && h('span', { title: `$${costUsd} estimated` }, formatCost(costUsd)),
    );
  }
  return h('div', { class: 'turn-footer' }, ...parts.flatMap((part, i) => (i === 0 ? [part] : [h('span', { class: 'sep', 'aria-hidden': 'true' }, '·'), part])));
}

/** A passing status in a running turn, such as a retry. */
export const turnNotice = (text: string): HTMLElement => h('div', { class: 'turn-notice', role: 'status' }, icon('loading', 'codicon-modifier-spin'), h('span', {}, text));

export const userMessage = (prompt: string): HTMLElement => h('div', { class: 'request' }, h('div', { class: 'request-bubble' }, prompt));

/** What a new panel suggests: each fills the composer for the user to edit or send. */
export const EXAMPLE_PROMPTS: readonly { readonly icon: string; readonly text: string }[] = [
  { icon: 'book', text: 'Explain how this project is organized' },
  { icon: 'checklist', text: 'Find the TODO comments and fix the simplest one' },
  { icon: 'beaker', text: 'Run the tests and fix whatever fails' },
];

export function emptyState(model: string, fill: (text: string) => void): HTMLElement {
  return h(
    'div',
    { class: 'empty-state' },
    h('div', { class: 'empty-icon' }, icon('comment-discussion')),
    h('h2', { class: 'empty-title' }, 'Ask g-code'),
    h('p', { class: 'empty-model' }, model === '' ? 'Edits your workspace and asks before risky commands.' : `${model} edits your workspace and asks before risky commands.`),
    h(
      'div',
      { class: 'examples' },
      ...EXAMPLE_PROMPTS.map((example) =>
        h('button', { class: 'example', 'data-focus': `example:${example.text}`, onclick: () => fill(example.text) }, icon(example.icon), h('span', {}, example.text)),
      ),
    ),
  );
}
