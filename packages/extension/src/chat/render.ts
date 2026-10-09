/// <reference lib="dom" />
import { diagramBlock } from './diagram-view.js';
import { h, icon, type Child } from './dom.js';
import { formatDuration, formatTokens } from './format.js';
import { renderMarkdown } from './markdown.js';
import type { ApprovalSubject, AskUserRequest, BackendShown } from '@g-code/core';
import { COMMENT_OPTION } from '@g-code/core/permission-comment';
import { showsTokens, turnCost } from './backend-model.js';
import type { AutoDecision, DiffHunk, ErrorBlock, FileDiff, FromView, PermissionAsk, PermissionBlock, PermissionOutcome, ToolBlock, ToolKind, ToolStatus, Turn, TurnStatus } from './messages.js';
import { answerWords, settledLine } from './question-model.js';
import { questionCard } from './question-view.js';
import { workflowCardBody } from './workflow-view.js';
import { changedFiles, type ChangedFile } from './fold.js';
import { byFile, headerOf, isEdit, type EditTool, type FileCalls, type Step } from './rail.js';
import type { AttachmentView } from './attachment-model.js';
import { markdownImage, sentAttachments, toolImages } from './images.js';
import { commandContent } from './slash-view.js';
import type { SentCommand } from './slash.js';
import { mcpCall } from './mcp-model.js';
import { verbOf } from './verbs.js';
import { commandStepOf, type CommandJob } from './command-step.js';
import type { ReviewMode } from '../review/mode.js';
import { changesLine, type TurnChanges } from '../review/summary.js';

/** What a block needs from the panel around it: the extension, and the view's own fold state. */
export type Ui = {
  readonly post: (message: FromView) => void;
  readonly isOpen: (id: string) => boolean;
  readonly toggle: (id: string) => void;
  readonly isUnfolded: (id: string) => boolean;
  readonly unfold: (id: string) => void;
  /** Opens a subagent's transcript in the side view. */
  readonly openChild: (id: string) => void;
  readonly review: () => ReviewMode;
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

/** A file's calls read as the first status here any of them has: one that still runs shows the file as running. */
const CHIP_STATUSES: readonly ToolStatus[] = ['running', 'completed', 'failed', 'cancelled'];

const statusOf = (tools: readonly ToolBlock[]): ToolStatus => CHIP_STATUSES.find((status) => tools.some((tool) => tool.status === status)) ?? 'completed';

const callCount = (n: number, noun: string): Child => n > 1 && h('span', { class: 'call-count' }, `· ${n} ${noun}`);

/** A file a step read or edited, once however many calls touched it: the edits' summed line counts, and the file's combined change on click. */
function fileChip(name: string, { path, tools }: FileCalls, ui: Ui): HTMLElement {
  const [changed] = changedFiles(tools.filter(isEdit));
  const parts = [icon('file-code'), h('span', { class: 'chip-name' }, basename(path) || name), changed !== undefined && lineCounts(changed), callCount(tools.length, FILE_TOOLS[name] ?? 'calls')];
  const look = `file-chip chip-${statusOf(tools)}`;
  if (changed === undefined) return h('span', { class: look, title: path }, ...parts);
  return h(
    'button',
    {
      type: 'button',
      class: look,
      title: `Open ${path}`,
      'data-focus': `chip:${changed.first}`,
      onclick: (event) => {
        event.stopPropagation();
        ui.post(controls(ui).open(changed));
      },
    },
    ...parts,
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

/** Tools whose runs show as file chips rather than a target, with what a chip counts when calls repeat a file. */
const FILE_TOOLS: Readonly<Record<string, string | undefined>> = { read: 'reads', edit: 'edits' };

/**
 * A run of calls as one step on the rail: reads and edits as one chip per file, any other call with its target.
 * Opening the step lists each call with its duration, and each call opens to its output. A `quiet` step, one of a
 * compact turn's recent steps, leaves out an MCP call's arguments and the quiet Auto badges. The row is not one
 * button because an edit's chip is its own: the toggle carries the keyboard and the row takes the rest of the clicks.
 */
export function callsStep(key: string, name: string, tools: readonly ToolBlock[], ui: Ui, quiet = false): HTMLElement {
  const first = tools[0]!;
  if (name === 'bash' || (name === 'preview_start' && first.background !== undefined)) return commandStep(first, ui, quiet);
  const target = first.target !== '' && !(quiet && mcpCall(name) !== undefined);
  const running = tools.some((t) => t.status === 'running');
  const failed = tools.filter((t) => t.status === 'failed').length;
  const open = ui.isOpen(key);
  return h(
    'div',
    { class: 'calls', 'data-step': name },
    h(
      'div',
      { class: 'step-row', onclick: () => ui.toggle(key) },
      h(
        'button',
        {
          type: 'button',
          class: 'step-toggle',
          'aria-expanded': String(open),
          'data-focus': `step:${key}`,
          'aria-label': [verbOf(name, running), ...(FILE_TOOLS[name] !== undefined ? byFile(tools).map((file) => file.path) : target ? [first.target] : [])].join(' '),
        },
        icon(KIND_ICONS[first.toolKind], 'kind'),
        mcpServerChip(name),
        h('span', { class: 'step-verb' }, verbOf(name, running)),
      ),
      FILE_TOOLS[name] !== undefined ? h('span', { class: 'chips' }, ...byFile(tools).map((file) => fileChip(name, file, ui))) : target && h('code', { class: 'step-target' }, first.target),
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

/** A bash call as one step: its title in plain words, then one box with the command in full and the first lines of its output. */
function commandStep(tool: ToolBlock, ui: Ui, quiet: boolean): HTMLElement {
  const unfold = `out:${tool.id}`;
  const step = commandStepOf(tool, ui.isUnfolded(unfold));
  return h(
    'div',
    { class: 'calls command-step', 'data-step': 'bash', 'data-tool': tool.id },
    h(
      'div',
      { class: 'command-head' },
      icon(KIND_ICONS.execute, 'kind'),
      h('span', { class: 'command-title', title: step.title }, step.title),
      step.status === 'running' && icon('loading', 'codicon-modifier-spin step-status'),
      step.status === 'failed' && h('span', { class: 'step-failed' }, icon('error'), 'Failed'),
    ),
    ...(isAuto(tool) && !(quiet && AUTO_BADGES[tool.auto.verdict].quiet) ? [autoNote(tool)] : []),
    h(
      'div',
      { class: 'command-box' },
      h('span', { class: 'command-label' }, 'IN'),
      h('pre', { class: 'command-in' }, h('code', {}, step.command)),
      step.output !== undefined && h('span', { class: 'command-label' }, 'OUT'),
      step.output !== undefined &&
        h(
          'div',
          { class: 'command-out' },
          h(
            'pre',
            { class: `command-output${step.truncated ? ' truncated' : ''}${step.job === undefined ? '' : ' from-end'}` },
            step.output.length === 0 ? h('span', { class: 'command-empty' }, step.job?.running === true ? 'No output yet' : 'No output') : step.output.join('\n'),
          ),
          step.truncated &&
            h('button', { class: 'link-button show-all', 'data-focus': `unfold:${unfold}`, onclick: () => ui.unfold(unfold) }, `Show all ${step.lines} lines`),
        ),
    ),
    step.job !== undefined && jobRow(step.job, ui),
  );
}

const JOB_ICONS: Readonly<Record<CommandJob['tone'], string>> = { running: 'circle-filled', ended: 'pass', failed: 'error', stopped: 'circle-slash' };

/** Under a background command's box: that it runs, with Stop, or how it ended, which is the notice the model gets. */
function jobRow(job: CommandJob, ui: Ui): HTMLElement {
  return h(
    'div',
    { class: `command-job job-${job.tone}`, 'data-job': job.id, role: 'status' },
    icon(JOB_ICONS[job.tone], 'job-icon'),
    h('span', { class: 'job-line' }, job.line),
    job.running &&
      h(
        'button',
        { class: 'button secondary small job-stop', 'data-focus': `stop-job:${job.id}`, title: `Stop ${job.id}: SIGTERM, then SIGKILL`, onclick: () => ui.post({ type: 'stop-background', id: job.id }) },
        'Stop',
      ),
  );
}

const DECISIONS: Readonly<Record<Exclude<DiffHunk['status'], 'pending'>, { readonly icon: string; readonly label: string }>> = {
  kept: { icon: 'check', label: 'Kept' },
  undone: { icon: 'discard', label: 'Undone' },
};

function decision(status: Exclude<DiffHunk['status'], 'pending'>): HTMLElement {
  const { icon: glyph, label } = DECISIONS[status];
  return h('span', { class: `decision decision-${status}` }, icon(glyph), label);
}

/** Where a file the chat names opens: `first` is its first hunk, `checkpoint` the one before its turn. */
type OpenedFile = Pick<ChangedFile, 'path' | 'first' | 'checkpoint'>;

/**
 * What the chat offers for edits in each review mode. Review asks Keep or Undo of each hunk and of the turn's
 * pending ones, and opens a file at its hunk. Auto has nothing to decide, and opens a file in a diff against the
 * checkpoint before its turn; its Undo is the turn's, under the turn.
 */
type EditControls = {
  readonly hunk: (hunk: DiffHunk, ui: Ui) => Child;
  readonly pending: (hunks: readonly string[], ui: Ui) => Child;
  readonly open: (file: OpenedFile) => FromView;
};

const CONTROLS: Readonly<Record<ReviewMode, EditControls>> = {
  review: {
    hunk: (hunk, ui) =>
      hunk.status !== 'pending'
        ? decision(hunk.status)
        : h(
            'span',
            { class: 'hunk-actions' },
            h('button', { class: 'button ghost small', 'data-focus': `undo:${hunk.id}`, onclick: () => ui.post({ type: 'undo', hunks: [hunk.id] }) }, 'Undo'),
            h('button', { class: 'button secondary small', 'data-focus': `keep:${hunk.id}`, onclick: () => ui.post({ type: 'keep', hunks: [hunk.id] }) }, 'Keep'),
          ),
    pending: (hunks, ui) =>
      hunks.length > 0 &&
      h(
        'span',
        { class: 'changes-actions' },
        h('button', { class: 'button ghost small', 'data-focus': 'undo-all', onclick: () => ui.post({ type: 'undo', hunks }) }, 'Undo all'),
        h('button', { class: 'button small', 'data-focus': 'keep-all', onclick: () => ui.post({ type: 'keep', hunks }) }, 'Keep all'),
      ),
    open: (file) => ({ type: 'reveal', hunk: file.first }),
  },
  auto: {
    hunk: (hunk) => hunk.status !== 'pending' && decision(hunk.status),
    pending: () => false,
    open: (file) => ({ type: 'open-change', path: file.path, checkpoint: file.checkpoint }),
  },
};

const controls = (ui: Ui): EditControls => CONTROLS[ui.review()];

function hunkView(hunk: DiffHunk, ui: Ui): HTMLElement {
  const lines = [...hunk.removed.map((text) => ['removed', text] as const), ...hunk.added.map((text) => ['added', text] as const)];
  return h(
    'div',
    { class: `hunk hunk-${hunk.status}`, 'data-hunk': hunk.id },
    h('div', { class: 'hunk-head' }, h('span', { class: 'hunk-line' }, `Line ${hunk.line}`), h('span', { class: 'spacer' }), controls(ui).hunk(hunk, ui)),
    h(
      'div',
      { class: 'hunk-lines' },
      ...folded(`hunk:${hunk.id}`, lines.map(([, text]) => text), ui, (text, i) =>
        h('div', { class: `diff-line ${lines[i]![0]}` }, h('span', { class: 'sign', 'aria-label': lines[i]![0] === 'added' ? 'added' : 'removed' }, lines[i]![0] === 'added' ? '+' : '-'), h('span', { class: 'code' }, text || ' ')),
      ),
    ),
  );
}

/** Every edit the turn made to one file: their summed counts, then each edit's hunks in the order they were made. */
function editCard({ path, tools }: FileCalls<EditTool>, ui: Ui): HTMLElement {
  const slash = path.lastIndexOf('/');
  const dir = slash === -1 ? '' : path.slice(0, slash);
  const hunks = tools.flatMap((tool) => tool.diff.hunks);
  const first = hunks.find((hunk) => hunk.status === 'pending') ?? hunks[0];
  const file: OpenedFile = { path, first: first?.id ?? '', checkpoint: { before: tools[0]!.diff.change } };
  const status = statusOf(tools);
  return h(
    'section',
    { class: 'edit-card', 'data-edit': tools[0]!.id, 'aria-label': `Edits to ${path}` },
    h(
      'div',
      { class: 'edit-head' },
      h(
        'button',
        { class: 'link-button file-name', title: `Open ${path}`, 'data-focus': `open:${tools[0]!.id}`, onclick: () => first !== undefined && ui.post(controls(ui).open(file)) },
        basename(path),
      ),
      dir !== '' && h('span', { class: 'file-dir' }, dir),
      lineCounts(changedFiles(tools)[0]!),
      callCount(tools.length, 'edits'),
      h('span', { class: 'spacer' }),
      status !== 'completed' && statusIcon(status),
    ),
    ...hunks.map((hunk) => hunkView(hunk, ui)),
  );
}

/** Every edit of a turn in one card at the end of its rail, one section per file, with Keep all and Undo all while any hunk waits for review. */
export function changesCard(edits: readonly EditTool[], ui: Ui): HTMLElement {
  const groups = byFile(edits);
  const files = groups.length;
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
      controls(ui).pending(pending, ui),
    ),
    ...groups.map((file) => editCard(file, ui)),
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

/** The files a turn changed, one chip each that opens the file, with Keep all and Undo all while any hunk waits for review. */
export function filesRow(files: readonly ChangedFile[], ui: Ui): HTMLElement {
  const pending = files.flatMap((file) => file.pending);
  return h(
    'div',
    { class: 'changed-files', role: 'group', 'aria-label': 'Files changed in this turn' },
    ...files.map((file) =>
      h(
        'button',
        { type: 'button', class: 'file-chip changed-file', title: `Open ${file.path}`, 'data-focus': `file:${file.first}`, onclick: () => ui.post(controls(ui).open(file)) },
        icon('file-code'),
        h('span', { class: 'chip-name' }, basename(file.path)),
        lineCounts(file),
      ),
    ),
    controls(ui).pending(pending, ui),
  );
}

/** Auto review's line under a turn that edited files: how many, and Undo, which restores the checkpoint before the turn. */
export function turnChangesRow(changes: TurnChanges, later: boolean, ui: Ui): HTMLElement {
  const undo = changes.undone
    ? h('span', { class: 'turn-undone' }, 'Undone')
    : h(
        'button',
        { type: 'button', class: 'link-button turn-undo', 'data-focus': `undo-turn:${changes.checkpoint.before}`, title: 'Put back every file as it was before this turn', onclick: () => ui.post({ type: 'undo-turn', checkpoint: changes.checkpoint, later }) },
        'Undo',
      );
  return h('div', { class: 'turn-changes', role: 'group', 'aria-label': 'Files changed in this turn' }, icon('diff-multiple', 'kind'), h('span', { class: 'turn-changes-line' }, changesLine(changes), ' · ', undo));
}

/** The engine's option that saves the command's rule for the workspace. */
const WORKSPACE_OPTION = 'allow-workspace';

/** The comment each open card's "No, and tell the agent…" field holds, kept across a rebuild of the step that holds it. */
const comments = new Map<string, string>();

/**
 * The engine names every option by what it does; the panel shortens only its own once-only answers. Any other option
 * id, such as "Allow this directory for the session", reads as the engine names it.
 */
const CHOICE_LABELS: Readonly<Record<string, string>> = { allow: 'Allow', reject: 'Deny' };

const CHOICE_STYLES: Readonly<Record<string, string>> = {
  [WORKSPACE_OPTION]: 'button secondary',
  [COMMENT_OPTION]: 'button ghost',
  allow_once: 'button',
  allow_always: 'button ghost',
  reject_once: 'button secondary',
  reject_always: 'button ghost',
};

/** The buttons of a card that waits: one per option the engine offered. "No, and tell the agent…" opens its field. */
function choiceButtons(block: PermissionBlock, ui: Ui, labels: Readonly<Record<string, string>>): HTMLElement {
  if (comments.has(block.id)) return commentField(block, ui, labels);
  const actions = h(
    'div',
    { class: 'permission-actions' },
    ...block.options.map((option) =>
      h(
        'button',
        {
          class: CHOICE_STYLES[option.optionId] ?? CHOICE_STYLES[option.kind] ?? 'button secondary',
          'data-focus': `choose:${block.id}:${option.optionId}`,
          onclick: () => {
            if (option.optionId !== COMMENT_OPTION) return ui.post({ type: 'permission', id: block.id, optionId: option.optionId });
            comments.set(block.id, '');
            const field = commentField(block, ui, labels);
            actions.replaceWith(field);
            field.querySelector('textarea')?.focus();
          },
        },
        labels[option.optionId] ?? option.name,
      ),
    ),
  );
  return actions;
}

/** What the user tells the agent with their no: Enter or Send answers, Esc or Back returns to the choices. */
function commentField(block: PermissionBlock, ui: Ui, labels: Readonly<Record<string, string>>): HTMLElement {
  const field = h('textarea', { class: 'permission-comment', rows: 2, placeholder: 'Tell the agent what to do instead', 'aria-label': 'What to tell the agent', 'data-focus': `comment:${block.id}` });
  field.value = comments.get(block.id) ?? '';
  const send = (): void => {
    const comment = field.value.trim();
    if (comment === '') return;
    comments.delete(block.id);
    ui.post({ type: 'permission', id: block.id, optionId: COMMENT_OPTION, comment });
  };
  const back = (): void => {
    comments.delete(block.id);
    const actions = choiceButtons(block, ui, labels);
    root.replaceWith(actions);
    actions.querySelector<HTMLElement>(`[data-focus="${CSS.escape(`choose:${block.id}:${COMMENT_OPTION}`)}"]`)?.focus();
  };
  const sendButton = h('button', { class: 'button', 'data-focus': `comment-send:${block.id}`, onclick: send }, 'Send');
  sendButton.disabled = field.value.trim() === '';
  field.addEventListener('input', () => {
    comments.set(block.id, field.value);
    sendButton.disabled = field.value.trim() === '';
  });
  field.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      back();
    }
  });
  const root = h(
    'div',
    { class: 'permission-comment-form' },
    field,
    h('div', { class: 'permission-actions' }, sendButton, h('button', { class: 'button secondary', 'data-focus': `comment-back:${block.id}`, onclick: back }, 'Back')),
  );
  return root;
}

const outcomeLine = (allowed: boolean, glyph: string, text: string): HTMLElement =>
  h('div', { class: `permission-outcome ${allowed ? 'allowed' : 'denied'}` }, icon(glyph), text);

const allowedOf = (block: PermissionBlock): boolean => {
  const { outcome } = block;
  return outcome.kind === 'chosen' && block.options.find((o) => o.optionId === outcome.optionId)?.kind.startsWith('allow') === true;
};

type CardFace = {
  readonly label: string;
  readonly glyph: string;
  readonly title: (block: PermissionBlock) => string;
  readonly body: (block: PermissionBlock) => readonly Child[];
  readonly actions: (block: PermissionBlock, ui: Ui) => HTMLElement;
  readonly settled: (block: PermissionBlock, quiet: boolean) => readonly Child[];
};

const SCOPE_TEXT = {
  project: 'Geno will follow this note in every later chat in this project.',
  global: 'Geno will follow this note in every later chat, in every project.',
} as const;

/** How each kind of waiting card reads: a command to run, a path, host or MCP tool to reach, a note to keep, or a question to answer. */
const commandBody =
  (because: (reason: string) => string) =>
  (block: PermissionBlock): Child[] => [
    block.description !== undefined && h('p', { class: 'permission-description' }, block.description),
    h('pre', { class: 'permission-command' }, h('code', {}, block.command)),
    h('p', { class: 'permission-reason' }, because(block.reason)),
    block.classifier !== undefined && h('p', { class: 'permission-classifier' }, icon('zap'), `Auto could not decide: ${block.classifier}.`),
    block.rule !== undefined &&
      block.outcome.kind === 'open' &&
      h('p', { class: 'permission-reason permission-rule' }, 'Always allow saves the rule ', h('code', {}, block.rule), ' for this workspace. Settings lists its rules.'),
  ];

const COMMAND_FACE: CardFace = {
  label: 'Geno asks to run a command',
  glyph: 'shield',
  title: () => 'Run this command?',
  body: commandBody((reason) => `Geno asks because it uses ${reason}.`),
  actions: (block, ui) => choiceButtons(block, ui, CHOICE_LABELS),
  settled: (block) => {
    const { outcome } = block;
    if (outcome.kind === 'cancelled') return [outcomeLine(false, 'circle-slash', 'Cancelled')];
    if (outcome.kind === 'chosen' && outcome.optionId === WORKSPACE_OPTION) return [outcomeLine(true, 'check', 'Allowed, and saved as a rule for this workspace')];
    if (outcome.kind === 'chosen' && outcome.comment !== undefined) return [outcomeLine(false, 'close', 'Denied, and told the agent'), h('blockquote', { class: 'permission-comment-sent' }, outcome.comment)];
    return [allowedOf(block) ? outcomeLine(true, 'check', 'Allowed') : outcomeLine(false, 'close', 'Denied')];
  },
};

function subjectTitle(subject: ApprovalSubject): string {
  switch (subject.kind) {
    case 'read':
      return 'Read outside the workspace?';
    case 'fetch':
      return `Fetch from ${subject.host}?`;
    case 'browse':
      return `Open a page on ${subject.host}?`;
    case 'mcp':
      return `Use ${subject.server} tool ${subject.tool}?`;
  }
}

/** A question about what a call reaches rather than a command line: it reads as the command card, under its own title. */
const reachFace = (label: string, glyph: string): CardFace => ({
  ...COMMAND_FACE,
  label,
  glyph,
  title: (block) => (block.subject === undefined ? COMMAND_FACE.title(block) : subjectTitle(block.subject)),
  body: commandBody((reason) => `Geno asks about ${reason}.`),
});

const SUBJECT_FACES: Readonly<Record<ApprovalSubject['kind'], CardFace>> = {
  read: reachFace('Geno asks to read outside the workspace', 'folder-opened'),
  fetch: reachFace('Geno asks to fetch a page', 'globe'),
  browse: reachFace('Geno asks to open a page', 'globe'),
  mcp: reachFace('Geno asks to use an MCP tool', 'plug'),
};

const FACES: Readonly<Record<PermissionAsk['kind'] | 'command' | 'edit', CardFace>> = {
  edit: { ...COMMAND_FACE, label: 'Geno asks to change a file', glyph: 'edit', title: () => 'Change this file?' },
  command: COMMAND_FACE,
  memory: {
    label: 'Geno asks to remember a note',
    glyph: 'bookmark',
    title: () => 'Remember this?',
    body: (block) => [
      h('blockquote', { class: 'memory-text' }, block.command),
      h('p', { class: 'permission-reason' }, block.ask?.kind === 'memory' ? `${SCOPE_TEXT[block.ask.scope]} You can change or delete it in /memory.` : ''),
    ],
    actions: (block, ui) => choiceButtons(block, ui, {}),
    settled: (block) => [
      block.outcome.kind === 'cancelled' ? outcomeLine(false, 'circle-slash', 'Cancelled') : allowedOf(block) ? outcomeLine(true, 'check', 'Remembered') : outcomeLine(false, 'close', 'Not remembered'),
    ],
  },
  workflow: {
    label: 'Geno asks to run a workflow',
    glyph: 'run-all',
    title: () => 'Run this workflow?',
    body: (block) => (block.ask?.kind === 'workflow' ? workflowCardBody(block.ask.preview) : []),
    actions: (block, ui) => choiceButtons(block, ui, {}),
    settled: (block) => [
      block.outcome.kind === 'cancelled' ? outcomeLine(false, 'circle-slash', 'Cancelled') : allowedOf(block) ? outcomeLine(true, 'check', 'Started, in Tasks') : outcomeLine(false, 'close', 'Not run'),
    ],
  },
  question: {
    label: 'Geno asks you a question',
    glyph: 'question',
    title: () => 'Geno asks',
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
  const face = block.ask === undefined && block.subject !== undefined ? SUBJECT_FACES[block.subject.kind] : FACES[block.ask?.kind ?? (block.toolKind === 'edit' ? 'edit' : 'command')];
  const folded = quiet && block.ask?.kind === 'question' && block.outcome.kind !== 'open';
  return h(
    'section',
    {
      class: `permission permission-${block.outcome.kind}${block.ask === undefined ? '' : ` permission-ask-${block.ask.kind}`}${folded ? ' permission-folded' : ''}`,
      role: 'group',
      'aria-label': face.label,
      'data-permission': block.id,
    },
    !folded && h('div', { class: 'permission-title' }, icon(face.glyph), h('span', {}, face.title(block))),
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
export const thinkingRow = (label = 'Thinking'): HTMLElement => h('div', { class: 'thinking', role: 'status' }, icon('lightbulb'), h('span', { class: 'shimmer' }, label));

/** A turn's model, tokens and cost, as one line. */
function usageLine(usage: NonNullable<Turn['usage']>, backend: BackendShown | undefined): string {
  const cost = turnCost(usage.costUsd, backend);
  const tokens = showsTokens(usage, backend) ? [`${formatTokens(usage.inputTokens)} in`, `${formatTokens(usage.outputTokens)} out`] : [];
  return [usage.model, ...tokens, ...(cost === undefined ? [] : [cost.text])].join(' · ');
}

/**
 * The avatar, the name, and what the turn is doing or how long it worked, with its model, tokens and cost as the
 * tooltip. A turn of a session on an external agent names the agent beside Geno, which drives it.
 */
export function turnHead(turn: Turn, backend: BackendShown | undefined): HTMLElement {
  return h(
    'div',
    { class: 'turn-head' },
    dino('avatar'),
    icon('loading', 'turn-working codicon-modifier-spin'),
    h('span', { class: 'turn-name' }, 'Geno'),
    backend !== undefined && h('span', { class: 'turn-backend', title: `${backend.label} works this chat in its own lane; Geno asks your permission and brings its changes back` }, backend.label),
    h(
      'span',
      { class: turn.status === 'streaming' ? 'turn-meta shimmer' : 'turn-meta', title: turn.usage === undefined ? undefined : usageLine(turn.usage, backend) },
      headerOf(turn, formatDuration),
    ),
    turn.mode === 'plan' && h('span', { class: 'turn-mode', title: 'This turn ran in Plan mode, which changes nothing' }, icon('checklist'), 'Plan'),
    turn.wake !== undefined && h('span', { class: 'turn-wake', title: `Geno started this turn by itself: ${turn.wake.replace(/^woke: /, '')}` }, icon('bell'), h('span', { class: 'turn-wake-text' }, turn.wake)),
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

/** Under an external agent's turn that left changes in its lane: bring them into the main checkout. */
export const applyLaneButton = (lane: string, ui: Ui): HTMLElement =>
  h(
    'div',
    { class: 'apply-lane' },
    h(
      'button',
      { type: 'button', class: 'button secondary', 'data-focus': `apply-lane:${lane}`, title: `Apply changes from lane ${lane} to the main checkout`, onclick: () => ui.post({ type: 'lane-apply', name: lane }) },
      icon('git-pull-request-go-to-changes'),
      h('span', { class: 'apply-lane-label' }, `Apply changes from lane ${lane}`),
    ),
  );

/**
 * How the turn ended, if not as it should, then its model, tokens and cost when `usage`. With `breakdown`, the usage
 * line is a button that opens where the turn's tokens went.
 */
export function turnFooter(turn: Turn, usage: boolean, backend: BackendShown | undefined, breakdown?: { readonly open: boolean; readonly toggle: () => void }): HTMLElement {
  const parts: Child[] = [];
  if (turn.status === 'stopped' || turn.status === 'failed') {
    const ending = ENDINGS[turn.status];
    parts.push(h('span', { class: `ending ending-${turn.status}` }, icon(ending.icon), ending.label));
  }
  if (usage && turn.usage !== undefined) {
    const { model, inputTokens, outputTokens, costUsd } = turn.usage;
    const cost = turnCost(costUsd, backend);
    const tokens = showsTokens(turn.usage, backend);
    const line = [
      h('span', { class: 'model' }, model),
      tokens && h('span', { title: `${inputTokens} input tokens` }, `${formatTokens(inputTokens)} in`),
      tokens && h('span', { title: `${outputTokens} output tokens` }, `${formatTokens(outputTokens)} out`),
      cost !== undefined && h('span', { class: 'turn-cost', title: cost.title }, cost.text),
    ];
    if (breakdown === undefined) parts.push(...line);
    else {
      parts.push(
        h(
          'button',
          { type: 'button', class: 'turn-usage', title: 'Where the tokens went', 'aria-expanded': String(breakdown.open), 'data-focus': `usage:${turn.id}`, onclick: breakdown.toggle },
          ...line,
          icon(breakdown.open ? 'chevron-up' : 'chevron-down', 'turn-usage-chevron'),
        ),
      );
    }
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
