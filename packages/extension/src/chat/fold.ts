import type { CheckpointRef } from '@g-code/core';
import { TOOL_KINDS, type Block, type ChatDetail, type PermissionBlock, type ToolBlock, type ToolKind, type Turn } from './messages.js';
import { isEdit, nodeOf, railOf, type EditTool, type Step } from './rail.js';

/** What a turn did, as its summary line counts it: calls by tool kind, then the calls that failed and those denied. */
export type Summary = { readonly kinds: Readonly<Record<ToolKind, number>>; readonly failed: number; readonly denied: number };

/**
 * A file the turn changed, as its chip shows it: its line counts, the hunk it opens at, the hunks still to review,
 * and the checkpoint before its turn, which auto review diffs it against.
 */
export type ChangedFile = {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  readonly first: string;
  readonly pending: readonly string[];
  readonly checkpoint: CheckpointRef;
};

export type TextStep = Extract<Step, { readonly kind: 'text' }>;

/**
 * A turn as compact detail sees it. The user's message is not here: it always shows, above the rail.
 */
export type TurnView = {
  /** Every step, as full detail draws them; the fold hides them behind one line. */
  readonly trail: readonly Step[];
  readonly summary: Summary;
  /** The final answer: the text after the turn's last call. Empty when the turn ended on a call. */
  readonly answer: readonly TextStep[];
  readonly files: readonly ChangedFile[];
  /** Steps that need the user, whatever their kind: one waiting on them, or an error that ended the turn. */
  readonly attention: readonly Step[];
};

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * How the summary counts and says each tool kind. `key` names what one counts: a file for reads and edits, so
 * reading a file twice reads one file, and the call itself for the rest. A new kind adds a row here.
 */
const KINDS: { readonly [K in ToolKind]: { readonly key: (tool: ToolBlock) => string; readonly says: (n: number) => string } } = {
  read: { key: (tool) => tool.target, says: (n) => `read ${plural(n, 'file')}` },
  search: { key: (tool) => tool.id, says: (n) => `searched ${n === 1 ? 'once' : `${n} times`}` },
  edit: { key: (tool) => tool.diff?.path ?? tool.target, says: (n) => `edited ${plural(n, 'file')}` },
  execute: { key: (tool) => tool.id, says: (n) => `ran ${plural(n, 'command')}` },
  other: { key: (tool) => tool.id, says: (n) => `used ${plural(n, 'tool')}` },
};

const ENDINGS: readonly { readonly of: 'failed' | 'denied'; readonly says: (n: number) => string }[] = [
  { of: 'failed', says: (n) => `${n} failed` },
  { of: 'denied', says: (n) => `${n} denied` },
];

const rejected = ({ outcome, options }: PermissionBlock): boolean =>
  outcome.kind === 'chosen' && options.find((option) => option.optionId === outcome.optionId)?.kind.startsWith('reject') === true;

/** The calls Auto denied, or whose permission the user rejected. */
function deniedCalls(blocks: readonly Block[]): ReadonlySet<string> {
  return new Set(
    blocks.flatMap((block) => {
      if (block.kind === 'tool') return block.auto?.verdict === 'deny' ? [block.id] : [];
      return block.kind === 'permission' && block.toolId !== undefined && rejected(block) ? [block.toolId] : [];
    }),
  );
}

export function summaryOf(turn: Turn): Summary {
  const tools = turn.blocks.filter((block): block is ToolBlock => block.kind === 'tool');
  const denied = deniedCalls(turn.blocks);
  const kinds = Object.fromEntries(TOOL_KINDS.map((kind) => [kind, new Set(tools.filter((t) => t.toolKind === kind).map(KINDS[kind].key)).size])) as Record<ToolKind, number>;
  return { kinds, failed: tools.filter((t) => t.status === 'failed' && !denied.has(t.id)).length, denied: denied.size };
}

/** "Read 8 files · searched 3 times · ran 4 commands · 1 failed", naming only what the turn did. */
export function summaryLine(summary: Summary): string {
  const parts = [
    ...TOOL_KINDS.filter((kind) => summary.kinds[kind] > 0).map((kind) => KINDS[kind].says(summary.kinds[kind])),
    ...ENDINGS.filter(({ of }) => summary[of] > 0).map(({ of, says }) => says(summary[of])),
  ];
  const line = parts.join(' · ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

export function changedFiles(edits: readonly EditTool[]): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  const checkpoint = { before: edits[0]?.diff.change ?? '' };
  for (const { diff } of edits) {
    const was = files.get(diff.path) ?? { path: diff.path, added: 0, removed: 0, first: diff.hunks[0]?.id ?? '', pending: [], checkpoint };
    files.set(diff.path, {
      ...was,
      added: was.added + diff.hunks.reduce((n, hunk) => n + hunk.added.length, 0),
      removed: was.removed + diff.hunks.reduce((n, hunk) => n + hunk.removed.length, 0),
      pending: [...was.pending, ...diff.hunks.filter((hunk) => hunk.status === 'pending').map((hunk) => hunk.id)],
    });
  }
  return [...files.values()];
}

/**
 * Whether a step needs the user: it waits on them, or it is an error, which only ever ends a turn. Any step kind
 * whose node waits on the user, a card added later included, stays in view without being named here.
 */
const needsUser = (step: Step): boolean => nodeOf(step) === 'wait' || step.kind === 'error';

/** An answered or skipped question stays in view as one line: what the user decided shapes the answer below it. */
const decided = (step: Step): boolean =>
  step.kind === 'permission' && step.block.ask?.kind === 'question' && (step.block.outcome.kind === 'answered' || step.block.outcome.kind === 'skipped');

export function turnView(turn: Turn): TurnView {
  const trail = railOf(turn);
  const lastCall = turn.blocks.findLastIndex((block) => block.kind === 'tool');
  const after = new Set(turn.blocks.slice(lastCall + 1).map((block) => block.id));
  const edits = turn.blocks.flatMap((block) => (block.kind === 'tool' && isEdit(block) ? [block] : []));
  return {
    trail,
    summary: summaryOf(turn),
    answer: trail.filter((step): step is TextStep => step.kind === 'text' && after.has(step.block.id)),
    files: changedFiles(edits),
    attention: trail.filter(needsUser),
  };
}

/** A running turn shows its current step and the three before it. */
const RECENT = 4;

type Folded = { readonly shown: readonly Step[]; readonly label: ((open: boolean) => string) | undefined };

/** What a compact turn keeps in view while folded, widgets included, and its fold line's label; undefined when nothing folds. */
function folded(turn: Turn, view: TurnView): Folded | undefined {
  const work = view.trail.filter((step) => step.kind !== 'changes');
  // What the user said mid-turn shapes the answer below it, as a decided question does.
  const kept = (keep: (step: Step) => boolean) => work.filter((step) => keep(step) || view.attention.includes(step) || decided(step) || step.kind === 'widget' || step.kind === 'steer');
  if (turn.status === 'streaming') {
    const narration = work.findLast((step) => step.kind === 'text');
    const recent = new Set<Step>(work.filter((step) => step.kind !== 'text' || step === narration).slice(-RECENT));
    const shown = kept((step) => recent.has(step));
    const hidden = work.length - shown.length;
    return { shown, label: hidden === 0 ? undefined : (open) => (open ? `Hide ${hidden} earlier steps` : `+${hidden} earlier steps`) };
  }
  const answer = new Set<Step>(view.answer);
  const shown = kept((step) => answer.has(step));
  return shown.length === work.length ? undefined : { shown, label: () => summaryLine(view.summary) };
}

/** What the rail draws of a turn: every step in full detail; in compact, the fold line and what stays in view. */
export function shownSteps(turn: Turn, detail: ChatDetail, open: boolean): Step[] {
  const view = turnView(turn);
  const fold = detail === 'full' ? undefined : folded(turn, view);
  if (fold === undefined) return [...view.trail];
  const files: Step[] = view.files.length === 0 ? [] : [{ kind: 'files', key: 'files', files: view.files }];
  if (fold.label === undefined) return [...fold.shown, ...files];
  const line: Step = { kind: 'fold', key: 'fold', turn: turn.id, label: fold.label(open), open };
  return open ? [line, ...view.trail] : [line, ...fold.shown, ...files];
}
