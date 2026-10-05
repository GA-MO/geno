/// <reference lib="dom" />
import { diagramBlock } from './diagram-view.js';
import { h, icon, type Child } from './dom.js';
import { formatCost, formatDuration, formatTokens } from './format.js';
import { renderMarkdown } from './markdown.js';
import type { AskUserRequest } from '@g-code/core';
import type { AutoDecision, DiffHunk, ErrorBlock, FileDiff, FromView, PermissionAsk, PermissionBlock, PermissionOutcome, ToolBlock, ToolKind, ToolStatus, Turn, TurnStatus } from './messages.js';
import { answerWords, settledLine } from './question-model.js';
import { questionCard } from './question-view.js';
import type { ChangedFile } from './fold.js';
import { headerOf, type EditTool, type Step } from './rail.js';
import type { AttachmentView } from './attachment-model.js';
import { markdownImage, sentAttachments, toolImages } from './images.js';
import { commandContent } from './slash-view.js';
import type { SentCommand } from './slash.js';
import { mcpCall } from './mcp-model.js';

/** What a block needs from the panel around it: the extension, and the view's own fold state. */
export type Ui = {
  readonly post: (message: FromView) => void;
  readonly isOpen: (id: string) => boolean;
  readonly toggle: (id: string) => void;
  readonly isUnfolded: (id: string) => boolean;
  readonly unfold: (id: string) => void;
};

/** The avatar's markup, baked in by the build from the one dino named in src/dino.ts. */
declare const DINO_AVATAR: string;

/** The dinosaur as inline SVG, so the page can style its eyelid; the markup is the build's own, never the model's. */
export function dino(className: string): HTMLElement {
  const svg = new DOMParser().parseFromString(DINO_AVATAR, 'image/svg+xml').documentElement;
  svg.setAttribute('aria-hidden', 'true');
  return h('span', { class: `dino ${className}` }, document.importNode(svg, true));
}

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

/** An MCP call reads as its tool's own name, with its server beside it. */
const verbOf = (name: string, running: boolean): string => VERBS[name]?.[running ? 0 : 1] ?? mcpCall(name)?.tool ?? name;

const mcpServerChip = (name: string): HTMLElement | undefined => {
  const call = mcpCall(name);
  return call === undefined ? undefined : h('span', { class: 'mcp-call-server', title: `MCP server ${call.server}` }, icon('mcp'), call.server);
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

/** One call inside an opened step: its status, what it did, and its duration in a column aligned with the others. */
export function toolRow(tool: ToolBlock, ui: Ui): HTMLElement {
  const output = tool.output?.replace(/\n+$/, '');
  const expandable = output !== undefined && output !== '';
  const open = expandable && ui.isOpen(tool.id);
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
    statusIcon(tool.status),
    h('span', { class: 'tool-label' }, verbOf(tool.name, tool.status === 'running')),
    h('code', { class: 'tool-target' }, tool.target),
    h('span', { class: 'tool-duration' }, durationOf(tool) ?? ''),
    icon(open ? 'chevron-down' : 'chevron-right', expandable ? 'chevron' : 'chevron hidden'),
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

const basename = (file: string): string => file.slice(file.lastIndexOf('/') + 1);

const lineCounts = ({ added, removed }: { readonly added: number; readonly removed: number }): HTMLElement =>
  h('span', { class: 'line-counts' }, h('span', { class: 'lines-added' }, `+${added}`), h('span', { class: 'lines-removed' }, `−${removed}`));

/** A file a read or an edit touched, with an edit's line counts. */
function fileChip(tool: ToolBlock): HTMLElement {
  const file = tool.diff?.path ?? tool.target;
  return h(
    'span',
    { class: `file-chip chip-${tool.status}`, title: file },
    icon('file-code'),
    h('span', { class: 'chip-name' }, basename(file) || tool.name),
    tool.diff !== undefined && lineCounts(counts(tool.diff)),
  );
}

/** `quiet` badges show only with every step drawn, not on a compact turn's recent steps. */
const AUTO_BADGES: Readonly<Record<AutoDecision['verdict'], { readonly label: string; readonly icon: string; readonly quiet: boolean }>> = {
  allow: { label: 'Auto-approved', icon: 'zap', quiet: true },
  deny: { label: 'Auto-denied', icon: 'circle-slash', quiet: false },
};

/** What Auto decided about a command without asking, and the classifier's reason, shown on the step even while it is folded. */
function autoNote(tool: ToolBlock & { readonly auto: AutoDecision }): HTMLElement {
  const badge = AUTO_BADGES[tool.auto.verdict];
  return h(
    'div',
    { class: `auto-note auto-${tool.auto.verdict}`, 'data-auto': tool.id },
    h('span', { class: 'auto-badge' }, icon(badge.icon), badge.label),
    h('span', { class: 'auto-reason' }, tool.auto.reason),
  );
}

const isAuto = (tool: ToolBlock): tool is ToolBlock & { readonly auto: AutoDecision } => tool.auto !== undefined;

/** Tools whose runs show as file chips rather than a target. */
const FILE_TOOLS: ReadonlySet<string> = new Set(['read', 'edit']);

/**
 * A run of calls as one step on the rail: reads and edits as file chips, any other call with its target.
 * Opening the step lists each call with its duration, and each call opens to its output. A `quiet` step, one of a
 * compact turn's recent steps, leaves out an MCP call's arguments and the quiet Auto badges.
 */
export function callsStep(key: string, name: string, tools: readonly ToolBlock[], ui: Ui, quiet = false): HTMLElement {
  const first = tools[0]!;
  const target = first.target !== '' && !(quiet && mcpCall(name) !== undefined);
  const running = tools.some((t) => t.status === 'running');
  const failed = tools.filter((t) => t.status === 'failed').length;
  const open = ui.isOpen(key);
  return h(
    'div',
    { class: 'calls', 'data-step': name },
    h(
      'button',
      { class: 'step-row', 'aria-expanded': String(open), 'data-focus': `step:${key}`, onclick: () => ui.toggle(key) },
      icon(KIND_ICONS[first.toolKind], 'kind'),
      mcpServerChip(name),
      h('span', { class: 'step-verb' }, verbOf(name, running)),
      FILE_TOOLS.has(name) ? h('span', { class: 'chips' }, ...tools.map(fileChip)) : target && h('code', { class: 'step-target' }, first.target),
      h('span', { class: 'spacer' }),
      running && icon('loading', 'codicon-modifier-spin step-status'),
      failed > 0 && h('span', { class: 'step-failed' }, icon('error'), failed === tools.length ? 'Failed' : `${failed} failed`),
      icon(open ? 'chevron-down' : 'chevron-right', 'chevron'),
    ),
    ...tools.filter(isAuto).filter((tool) => !(quiet && AUTO_BADGES[tool.auto.verdict].quiet)).map(autoNote),
    toolImages(tools, (target) => ui.post({ type: 'open', target })),
    open && h('div', { class: 'call-list' }, ...tools.map((tool) => toolRow(tool, ui))),
  );
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
    h('button', { class: 'button ghost small', 'data-focus': `undo:${hunk.id}`, onclick: () => ui.post({ type: 'undo', hunks: [hunk.id] }) }, 'Undo'),
    h('button', { class: 'button secondary small', 'data-focus': `keep:${hunk.id}`, onclick: () => ui.post({ type: 'keep', hunks: [hunk.id] }) }, 'Keep'),
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

function editCard(tool: EditTool, ui: Ui): HTMLElement {
  const { diff } = tool;
  const slash = diff.path.lastIndexOf('/');
  const dir = slash === -1 ? '' : diff.path.slice(0, slash);
  const first = diff.hunks.find((hunk) => hunk.status === 'pending') ?? diff.hunks[0];
  return h(
    'section',
    { class: 'edit-card', 'data-edit': tool.id, 'aria-label': `Edit to ${diff.path}` },
    h(
      'div',
      { class: 'edit-head' },
      h(
        'button',
        { class: 'link-button file-name', title: `Open ${diff.path}`, 'data-focus': `open:${tool.id}`, onclick: () => first !== undefined && ui.post({ type: 'reveal', hunk: first.id }) },
        basename(diff.path),
      ),
      dir !== '' && h('span', { class: 'file-dir' }, dir),
      lineCounts(counts(diff)),
      h('span', { class: 'spacer' }),
      tool.status !== 'completed' && statusIcon(tool.status),
    ),
    ...diff.hunks.map((hunk) => hunkView(hunk, ui)),
  );
}

/** Every edit of a turn in one card at the end of its rail, with Keep all and Undo all while any hunk waits. */
export function changesCard(edits: readonly EditTool[], ui: Ui): HTMLElement {
  const files = new Set(edits.map((tool) => tool.diff.path)).size;
  const total = edits.map((tool) => counts(tool.diff)).reduce((a, b) => ({ added: a.added + b.added, removed: a.removed + b.removed }), { added: 0, removed: 0 });
  const pending = edits.flatMap((tool) => tool.diff.hunks.filter((hunk) => hunk.status === 'pending').map((hunk) => hunk.id));
  return h(
    'section',
    { class: 'changes', 'aria-label': 'Changes in this turn' },
    h(
      'div',
      { class: 'changes-head' },
      icon('diff-multiple', 'kind'),
      h('span', { class: 'changes-title' }, files === 1 ? '1 file changed' : `${files} files changed`),
      lineCounts(total),
      h('span', { class: 'spacer' }),
      pending.length > 0 &&
        h(
          'span',
          { class: 'changes-actions' },
          h('button', { class: 'button ghost small', 'data-focus': 'undo-all', onclick: () => ui.post({ type: 'undo', hunks: pending }) }, 'Undo all'),
          h('button', { class: 'button small', 'data-focus': 'keep-all', onclick: () => ui.post({ type: 'keep', hunks: pending }) }, 'Keep all'),
        ),
    ),
    ...edits.map((tool) => editCard(tool, ui)),
  );
}

/** The fold state's id for a turn, in the same list as the steps the user opened. */
export const foldId = (turn: string): string => `turn:${turn}`;

/** The line a compact turn's work folds behind: the summary of a finished turn, or a running turn's earlier steps. */
export const foldRow = (step: Extract<Step, { readonly kind: 'fold' }>, ui: Ui): HTMLElement =>
  h(
    'button',
    { type: 'button', class: 'turn-fold', 'aria-expanded': String(step.open), 'data-focus': `fold:${step.turn}`, onclick: () => ui.toggle(foldId(step.turn)) },
    h('span', { class: 'fold-label' }, step.label),
    icon(step.open ? 'chevron-down' : 'chevron-right', 'chevron'),
  );

/** The files a turn changed, one chip each that opens the file at its first hunk, with Keep all and Undo all while any hunk waits. */
export function filesRow(files: readonly ChangedFile[], ui: Ui): HTMLElement {
  const pending = files.flatMap((file) => file.pending);
  return h(
    'div',
    { class: 'changed-files', role: 'group', 'aria-label': 'Files changed in this turn' },
    ...files.map((file) =>
      h(
        'button',
        { type: 'button', class: 'file-chip changed-file', title: `Open ${file.path}`, 'data-focus': `file:${file.first}`, onclick: () => ui.post({ type: 'reveal', hunk: file.first }) },
        icon('file-code'),
        h('span', { class: 'chip-name' }, basename(file.path)),
        lineCounts(file),
      ),
    ),
    pending.length > 0 &&
      h(
        'span',
        { class: 'changes-actions' },
        h('button', { class: 'button ghost small', 'data-focus': 'undo-all', onclick: () => ui.post({ type: 'undo', hunks: pending }) }, 'Undo all'),
        h('button', { class: 'button small', 'data-focus': 'keep-all', onclick: () => ui.post({ type: 'keep', hunks: pending }) }, 'Keep all'),
      ),
  );
}

/** Option kinds as the panel names their buttons; the first allow is the default the card focuses. */
const CHOICE_LABELS: Readonly<Record<string, string>> = {
  allow_once: 'Allow',
  allow_always: 'Always Allow',
  reject_once: 'Deny',
  reject_always: 'Always Deny',
};

const CHOICE_STYLES: Readonly<Record<string, string>> = {
  allow_once: 'button',
  allow_always: 'button ghost',
  reject_once: 'button secondary',
  reject_always: 'button ghost',
};

/** The buttons of a card that waits: one per option the engine offered. */
const choiceButtons = (block: PermissionBlock, ui: Ui, labels: Readonly<Record<string, string>>): HTMLElement =>
  h(
    'div',
    { class: 'permission-actions' },
    ...block.options.map((option) =>
      h(
        'button',
        {
          class: CHOICE_STYLES[option.kind] ?? 'button secondary',
          'data-focus': `choose:${block.id}:${option.optionId}`,
          onclick: () => ui.post({ type: 'permission', id: block.id, optionId: option.optionId }),
        },
        labels[option.kind] ?? option.name,
      ),
    ),
  );

const outcomeLine = (allowed: boolean, glyph: string, text: string): HTMLElement =>
  h('div', { class: `permission-outcome ${allowed ? 'allowed' : 'denied'}` }, icon(glyph), text);

const allowedOf = (block: PermissionBlock): boolean => {
  const { outcome } = block;
  return outcome.kind === 'chosen' && block.options.find((o) => o.optionId === outcome.optionId)?.kind.startsWith('allow') === true;
};

type CardFace = {
  readonly label: string;
  readonly glyph: string;
  readonly title: string;
  readonly body: (block: PermissionBlock) => readonly Child[];
  readonly actions: (block: PermissionBlock, ui: Ui) => HTMLElement;
  readonly settled: (block: PermissionBlock, quiet: boolean) => readonly Child[];
};

const SCOPE_TEXT = {
  project: 'Geno will follow this note in every later chat in this project.',
  global: 'Geno will follow this note in every later chat, in every project.',
} as const;

const MEMORY_LABELS: Readonly<Record<string, string>> = { allow_once: 'Remember', reject_once: "Don't remember" };

/** How each kind of waiting card reads: a command to run, a note to keep, or a question to answer. */
const FACES: Readonly<Record<PermissionAsk['kind'] | 'command', CardFace>> = {
  command: {
    label: 'Geno asks to run a command',
    glyph: 'shield',
    title: 'Run this command?',
    body: (block) => [
      h('pre', { class: 'permission-command' }, h('code', {}, block.command)),
      h('p', { class: 'permission-reason' }, `Geno asks because it uses ${block.reason}.`),
      block.classifier !== undefined && h('p', { class: 'permission-classifier' }, icon('zap'), `Auto could not decide: ${block.classifier}.`),
    ],
    actions: (block, ui) => choiceButtons(block, ui, CHOICE_LABELS),
    settled: (block) => [
      block.outcome.kind === 'cancelled' ? outcomeLine(false, 'circle-slash', 'Cancelled') : allowedOf(block) ? outcomeLine(true, 'check', 'Allowed') : outcomeLine(false, 'close', 'Denied'),
    ],
  },
  memory: {
    label: 'Geno asks to remember a note',
    glyph: 'bookmark',
    title: 'Remember this?',
    body: (block) => [
      h('blockquote', { class: 'memory-text' }, block.command),
      h('p', { class: 'permission-reason' }, block.ask?.kind === 'memory' ? `${SCOPE_TEXT[block.ask.scope]} You can change or delete it in /memory.` : ''),
    ],
    actions: (block, ui) => choiceButtons(block, ui, MEMORY_LABELS),
    settled: (block) => [
      block.outcome.kind === 'cancelled' ? outcomeLine(false, 'circle-slash', 'Cancelled') : allowedOf(block) ? outcomeLine(true, 'check', 'Remembered') : outcomeLine(false, 'close', 'Not remembered'),
    ],
  },
  question: {
    label: 'Geno asks you a question',
    glyph: 'question',
    title: 'Geno asks',
    body: () => [],
    actions: (block, ui) => questionCard(block.id, requestOf(block), { post: ui.post, markdown: (text) => textBlock(text, false, ui) }),
    settled: (block, quiet) => settledQuestion(requestOf(block), block.outcome, quiet),
  },
};

/**
 * A card that waits on the user. Every kind goes through here, so whatever shows a waiting permission shows them all.
 * A `quiet` card is one a compact turn keeps in view while its work is folded: an answered question shows only its line.
 */
export function permissionCard(block: PermissionBlock, ui: Ui, quiet = false): HTMLElement {
  const face = FACES[block.ask?.kind ?? 'command'];
  const folded = quiet && block.ask?.kind === 'question' && block.outcome.kind !== 'open';
  return h(
    'section',
    {
      class: `permission permission-${block.outcome.kind}${block.ask === undefined ? '' : ` permission-ask-${block.ask.kind}`}${folded ? ' permission-folded' : ''}`,
      role: 'group',
      'aria-label': face.label,
      'data-permission': block.id,
    },
    !folded && h('div', { class: 'permission-title' }, icon(face.glyph), h('span', {}, face.title)),
    ...(folded ? [] : face.body(block)),
    ...(block.outcome.kind === 'open' ? [face.actions(block, ui)] : face.settled(block, folded)),
  );
}

const requestOf = (block: PermissionBlock): AskUserRequest => (block.ask?.kind === 'question' ? block.ask.request : { questions: [] });

/** An answered card: one line, and unless folded, the question and each answer under it. */
function settledQuestion(request: AskUserRequest, outcome: PermissionOutcome, folded: boolean): Child[] {
  if (outcome.kind !== 'answered') return [outcomeLine(false, outcome.kind === 'cancelled' ? 'circle-slash' : 'close', outcome.kind === 'cancelled' ? 'Cancelled' : 'Skipped')];
  const line = outcomeLine(true, 'check', settledLine(request, outcome.answers));
  if (folded) return [line];
  const [only] = request.questions;
  if (request.questions.length === 1) return [h('p', { class: 'question-text' }, only!.question), line];
  return [
    line,
    h(
      'dl',
      { class: 'question-answers' },
      ...request.questions.flatMap((q) => [h('dt', {}, h('span', { class: 'question-answer-header' }, q.header), ' ', q.question), h('dd', {}, answerWords(outcome.answers[q.id]))]),
    ),
  ];
}

export const errorBlock = (block: ErrorBlock): HTMLElement =>
  h('div', { class: 'turn-error', role: 'alert' }, icon('error'), h('span', {}, block.message));

/** Assistant text, revealed up to `shown` characters, with a caret while more is coming. */
export function textBlock(text: string, caret: boolean, ui: Ui): HTMLElement {
  const element = h('div', { class: 'markdown' });
  const actions = { copy: (code: string) => ui.post({ type: 'copy', text: code }), open: (source: string) => ui.post({ type: 'open-diagram', source }) };
  element.append(
    renderMarkdown(text, {
      copy: actions.copy,
      diagram: (diagram) => diagramBlock(diagram, actions),
      image: (href, alt) => markdownImage(href, alt, (target) => ui.post({ type: 'open', target })),
    }),
  );
  if (caret) {
    const last = element.lastElementChild;
    // The caret follows the last word, inside the paragraph or list item it ends.
    const host = last === null || last.matches('.code-block, .diagram') ? element : (last.matches('ul, ol') ? last.lastElementChild ?? last : last);
    host.append(h('span', { class: 'caret', 'aria-hidden': 'true' }));
  }
  return element;
}

/** The model is working out its next move: a running turn with nothing else under way. */
export const thinkingRow = (): HTMLElement => h('div', { class: 'thinking', role: 'status' }, icon('lightbulb'), h('span', { class: 'shimmer' }, 'Thinking'));

/** A turn's model, tokens and cost, as one line. */
const usageLine = ({ model, inputTokens, outputTokens, costUsd }: NonNullable<Turn['usage']>): string =>
  [model, `${formatTokens(inputTokens)} in`, `${formatTokens(outputTokens)} out`, ...(costUsd === null ? [] : [formatCost(costUsd)])].join(' · ');

/** The avatar, the name, and what the turn is doing or how long it worked, with its model, tokens and cost as the tooltip. */
export function turnHead(turn: Turn): HTMLElement {
  return h(
    'div',
    { class: 'turn-head' },
    dino('avatar'),
    h('span', { class: 'turn-name' }, 'Geno'),
    h(
      'span',
      { class: turn.status === 'streaming' ? 'turn-meta shimmer' : 'turn-meta', title: turn.usage === undefined ? undefined : usageLine(turn.usage) },
      headerOf(turn, formatDuration),
    ),
    turn.mode === 'plan' && h('span', { class: 'turn-mode', title: 'This turn ran in Plan mode, which changes nothing' }, icon('checklist'), 'Plan'),
  );
}

/** Under a finished Plan turn while the session is still in Plan: carry the plan out. */
export const startBuilding = (ui: Ui): HTMLElement =>
  h(
    'div',
    { class: 'start-building' },
    h('button', { type: 'button', class: 'button', 'data-focus': 'start-building', onclick: () => ui.post({ type: 'start-building' }) }, icon('play'), 'Start building'),
  );

const ENDINGS: Readonly<Record<Exclude<TurnStatus, 'streaming' | 'done'>, { readonly icon: string; readonly label: string }>> = {
  stopped: { icon: 'debug-stop', label: 'Stopped' },
  failed: { icon: 'error', label: 'Failed' },
};

/** How the turn ended, if not as it should, then its model, tokens and cost when `usage`. */
export function turnFooter(turn: Turn, usage: boolean): HTMLElement {
  const parts: Child[] = [];
  if (turn.status === 'stopped' || turn.status === 'failed') {
    const ending = ENDINGS[turn.status];
    parts.push(h('span', { class: `ending ending-${turn.status}` }, icon(ending.icon), ending.label));
  }
  if (usage && turn.usage !== undefined) {
    const { model, inputTokens, outputTokens, costUsd } = turn.usage;
    parts.push(
      h('span', { class: 'model' }, model),
      h('span', { title: `${inputTokens} input tokens` }, `${formatTokens(inputTokens)} in`),
      h('span', { title: `${outputTokens} output tokens` }, `${formatTokens(outputTokens)} out`),
      costUsd !== null && h('span', { title: `$${costUsd} estimated` }, formatCost(costUsd)),
    );
  }
  return h('div', { class: 'turn-footer' }, ...parts);
}

/** A passing status in a running turn, such as a retry. */
export const turnNotice = (text: string): HTMLElement => h('div', { class: 'turn-notice', role: 'status' }, icon('loading', 'codicon-modifier-spin'), h('span', {}, text));

export const userMessage = (prompt: string, attachments: readonly AttachmentView[] = [], ui?: Ui, command?: SentCommand): HTMLElement =>
  h(
    'div',
    { class: 'request' },
    ui !== undefined && sentAttachments(attachments, (target) => ui.post({ type: 'open', target })),
    prompt !== '' && h('div', { class: 'request-bubble' }, ...(command === undefined ? [prompt] : commandContent(command))),
  );
