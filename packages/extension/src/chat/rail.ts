import type { ChangedFile } from './fold.js';
import type { ErrorBlock, PermissionBlock, TextBlock, ToolBlock, Turn } from './messages.js';

/**
 * A turn as the panel draws it: one rail of steps from the prompt to the answer. Runs of reads or edits fold
 * into one step of file chips, every edit's diff gathers in one changes card at the rail's end, and a running
 * turn that waits on the model ends in a thinking step. A pure view of the turn, so the rules live here once.
 */
export type Step =
  | { readonly kind: 'text'; readonly key: string; readonly block: TextBlock }
  | { readonly kind: 'calls'; readonly key: string; readonly name: string; readonly tools: readonly ToolBlock[] }
  | { readonly kind: 'permission'; readonly key: string; readonly block: PermissionBlock }
  | { readonly kind: 'error'; readonly key: string; readonly block: ErrorBlock }
  /** A show_widget call: the widget itself, never folded into a run of calls. */
  | { readonly kind: 'widget'; readonly key: string; readonly tool: WidgetTool }
  | { readonly kind: 'notice'; readonly key: 'notice'; readonly text: string }
  | { readonly kind: 'thinking'; readonly key: 'thinking' }
  | { readonly kind: 'changes'; readonly key: 'changes'; readonly edits: readonly EditTool[] }
  /** Compact detail only: the line the turn's work folds behind, which opens and closes the whole trail. */
  | { readonly kind: 'fold'; readonly key: 'fold'; readonly turn: string; readonly label: string; readonly open: boolean }
  /** Compact detail only: the changed files as one row of chips, in the changes card's place. */
  | { readonly kind: 'files'; readonly key: 'files'; readonly files: readonly ChangedFile[] };

export type EditTool = ToolBlock & { readonly diff: NonNullable<ToolBlock['diff']> };
export type WidgetTool = ToolBlock & { readonly widget: NonNullable<ToolBlock['widget']> };

/** How a step's node on the rail reads: done, under way, waiting on the user, failed, or text. */
export type NodeState = 'done' | 'live' | 'wait' | 'failed' | 'text';

/** Tools whose consecutive calls fold into one step, each call a file chip. */
const FILE_TOOLS: ReadonlySet<string> = new Set(['read', 'edit']);

export const isEdit = (tool: ToolBlock): tool is EditTool => tool.diff !== undefined;

export function railOf(turn: Turn): Step[] {
  const steps: Step[] = [];
  for (const block of turn.blocks) {
    const last = steps.at(-1);
    if (block.kind === 'text') steps.push({ kind: 'text', key: block.id, block });
    else if (block.kind === 'permission') steps.push({ kind: 'permission', key: `permission:${block.id}`, block });
    else if (block.kind === 'error') steps.push({ kind: 'error', key: block.id, block });
    else if (block.widget !== undefined) steps.push({ kind: 'widget', key: `widget:${block.id}`, tool: block as WidgetTool });
    else if (last?.kind === 'calls' && last.name === block.name && FILE_TOOLS.has(block.name)) steps[steps.length - 1] = { ...last, tools: [...last.tools, block] };
    else steps.push({ kind: 'calls', key: `calls:${block.id}`, name: block.name, tools: [block] });
  }
  if (turn.notice !== undefined) steps.push({ kind: 'notice', key: 'notice', text: turn.notice });
  else if (isThinking(turn)) steps.push({ kind: 'thinking', key: 'thinking' });
  const edits = turn.blocks.flatMap((b) => (b.kind === 'tool' && isEdit(b) ? [b] : []));
  if (edits.length > 0) steps.push({ kind: 'changes', key: 'changes', edits });
  return steps;
}

/** A running turn whose last word was not text and that runs and asks nothing is waiting on the model. */
function isThinking(turn: Turn): boolean {
  if (turn.status !== 'streaming') return false;
  const busy = turn.blocks.some((b) => (b.kind === 'tool' && b.status === 'running') || (b.kind === 'permission' && b.outcome.kind === 'open'));
  return !busy && turn.blocks.at(-1)?.kind !== 'text';
}

export const isWaiting = (turn: Turn): boolean => turn.blocks.some((b) => b.kind === 'permission' && b.outcome.kind === 'open');

export function nodeOf(step: Step): NodeState {
  switch (step.kind) {
    case 'text':
      return 'text';
    case 'calls':
      if (step.tools.some((t) => t.status === 'running')) return 'live';
      return step.tools.some((t) => t.status === 'failed') ? 'failed' : 'done';
    case 'permission':
      return step.block.outcome.kind === 'open' ? 'wait' : 'done';
    case 'error':
      return 'failed';
    case 'widget':
      return step.tool.status === 'running' ? 'live' : step.tool.status === 'failed' ? 'failed' : 'done';
    case 'notice':
    case 'thinking':
      return 'live';
    case 'changes':
    case 'fold':
    case 'files':
      return 'done';
  }
}

/** The line beside the avatar: what the turn is doing now, or how long it worked. */
export function headerOf(turn: Turn, format: (ms: number) => string): string {
  if (turn.status === 'streaming') return isWaiting(turn) ? 'waiting for you' : 'working';
  const took = turn.endedAt === undefined ? '' : ` ${turn.status === 'done' ? 'for' : 'after'} ${format(turn.endedAt - turn.startedAt)}`;
  return { done: `worked${took}`, stopped: `stopped${took}`, failed: `failed${took}` }[turn.status];
}
