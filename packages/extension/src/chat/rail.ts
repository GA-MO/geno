import type { ChangedFile } from './fold.js';
import type { CallProgress, WaitKind } from '@g-code/core';
import { TODO_TOOL, type TodoList } from '@g-code/core/todo';
import { SPAWN_TASK_TOOL } from '@g-code/core/spinoff';
import type { Child, CompactBlock, ErrorBlock, PermissionBlock, SteerBlock, TextBlock, ToolBlock, Turn } from './messages.js';
import { workedMs } from './transcript.js';
import type { EditorTool } from './editor-step.js';
import { isChapterCall, type ChapterTool } from './chapter-model.js';

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
  /** A message that joined the turn while it ran, where it landed. */
  | { readonly kind: 'steer'; readonly key: string; readonly block: SteerBlock }
  /** Where the context was compacted: a divider that opens to the summary. */
  | { readonly kind: 'compact'; readonly key: string; readonly block: CompactBlock }
  /** An `agent` call, with the subagents it started nested under it. */
  | { readonly kind: 'agent'; readonly key: string; readonly tool: ToolBlock; readonly children: readonly Child[] }
  /** An open_file, reveal or show_diff call that ran: one row that shows its target again. */
  | { readonly kind: 'editor'; readonly key: string; readonly tool: EditorTool }
  /** A show_widget call: the widget itself, never folded into a run of calls. */
  | { readonly kind: 'widget'; readonly key: string; readonly tool: WidgetTool }
  /** A spawn_task call's suggestion, as a card: open, or started. Dismissed or withdrawn, it is gone. */
  | { readonly kind: 'spinoff'; readonly key: string; readonly tool: SpinoffTool }
  /** Where the agent started a chapter: a thin divider with its title. */
  | { readonly kind: 'chapter'; readonly key: string; readonly tool: ChapterTool }
  /** The todo list: above a running turn's latest step, and once the turn ends, where it last changed. */
  | { readonly kind: 'todo'; readonly key: 'todo'; readonly turn: string; readonly list: TodoList; readonly place: TodoPlace }
  | { readonly kind: 'notice'; readonly key: 'notice'; readonly text: string }
  | { readonly kind: 'thinking'; readonly key: 'thinking'; readonly progress: CallProgress | undefined }
  | { readonly kind: 'changes'; readonly key: 'changes'; readonly edits: readonly EditTool[] }
  /** Compact detail only: the line the turn's work folds behind, which opens and closes the whole trail. */
  | { readonly kind: 'fold'; readonly key: 'fold'; readonly turn: string; readonly label: string; readonly open: boolean }
  /** Compact detail only: the changed files as one row of chips, in the changes card's place. */
  | { readonly kind: 'files'; readonly key: 'files'; readonly files: readonly ChangedFile[] };

export type EditTool = ToolBlock & { readonly diff: NonNullable<ToolBlock['diff']> };
export type WidgetTool = ToolBlock & { readonly widget: NonNullable<ToolBlock['widget']> };
export type SpinoffTool = ToolBlock & { readonly spinoff: NonNullable<ToolBlock['spinoff']> };

/**
 * Where a list stands: `live`, the running turn's own, which it last set; `carried`, an earlier turn's unfinished list
 * on a running turn that has not touched it yet, which is history until it does; `kept`, a finished turn's list where it
 * last changed.
 */
export type TodoPlace = 'live' | 'carried' | 'kept';

/** How a step's node on the rail reads: done, under way, waiting on the user, failed, refused, or text. */
export type NodeState = 'done' | 'live' | 'wait' | 'failed' | 'denied' | 'text';

/** Tools whose consecutive calls fold into one step, each file one chip. */
const FILE_TOOLS: ReadonlySet<string> = new Set(['read', 'edit']);

/** The engine's tool that starts a subagent. */
export const AGENT_CALL = 'agent';

export const childrenUnder = (turn: Turn, toolId: string): Child[] => Object.values(turn.children ?? {}).filter((child) => child.toolId === toolId);

export const isEdit = (tool: ToolBlock): tool is EditTool => tool.diff !== undefined;

/** A file's calls in a run, which one chip or one card shows together. */
export type FileCalls<T extends ToolBlock = ToolBlock> = { readonly path: string; readonly tools: readonly T[] };

/** The calls grouped by the file they touched, in the order each file first appears. */
export function byFile<T extends ToolBlock>(tools: readonly T[]): FileCalls<T>[] {
  const files = new Map<string, T[]>();
  for (const tool of tools) {
    const path = tool.diff?.path ?? tool.target;
    files.set(path, [...(files.get(path) ?? []), tool]);
  }
  return [...files].map(([path, calls]) => ({ path, tools: calls }));
}

/** The list as the turn's last todo call left it; undefined when the turn set none. */
export const todoListOf = (turn: Turn): TodoList | undefined => turn.blocks.findLast((block): block is ToolBlock => block.kind === 'tool' && block.todo !== undefined)?.todo;

/** A todo call that ran or still runs shows as the list, not as a call; one the engine refused stays a failed call. */
const isTodoCall = (block: ToolBlock): boolean => block.name === TODO_TOOL && block.status !== 'failed';

/**
 * A running turn pins the list it set, or the one it started with while that has work left, as carried until the turn
 * sets its own; a cleared list shows nothing, and a finished one from an earlier turn stays in that turn.
 */
function pinnedList(turn: Turn, carried: TodoList): { readonly list: TodoList; readonly place: TodoPlace } | undefined {
  const own = todoListOf(turn);
  if (own !== undefined) return own.length === 0 ? undefined : { list: own, place: 'live' };
  return carried.some((item) => item.status !== 'done') ? { list: carried, place: 'carried' } : undefined;
}

/** `carried` is the list the turn starts with: the latest an earlier turn set, as Plan's is when Start building runs. */
export function railOf(turn: Turn, carried: TodoList = []): Step[] {
  const steps: Step[] = [];
  const streaming = turn.status === 'streaming';
  const lastSet = turn.blocks.findLast((block) => block.kind === 'tool' && block.todo !== undefined);
  for (const block of turn.blocks) {
    const last = steps.at(-1);
    if (block.kind === 'tool' && isTodoCall(block)) {
      if (!streaming && block === lastSet && block.todo!.length > 0) steps.push({ kind: 'todo', key: 'todo', turn: turn.id, list: block.todo!, place: 'kept' });
    } else if (block.kind === 'tool' && block.name === SPAWN_TASK_TOOL && block.spinoff !== undefined) {
      if (block.spinoff.state.kind === 'offered' || block.spinoff.state.kind === 'started') steps.push({ kind: 'spinoff', key: `spinoff:${block.id}`, tool: block as SpinoffTool });
    } else if (block.kind === 'tool' && isChapterCall(block)) steps.push({ kind: 'chapter', key: `chapter:${block.id}`, tool: block });
    else if (block.kind === 'text') steps.push({ kind: 'text', key: block.id, block });
    else if (block.kind === 'permission') steps.push({ kind: 'permission', key: `permission:${block.id}`, block });
    else if (block.kind === 'error') steps.push({ kind: 'error', key: block.id, block });
    else if (block.kind === 'steer') steps.push({ kind: 'steer', key: block.id, block });
    else if (block.kind === 'compact') steps.push({ kind: 'compact', key: block.id, block });
    else if (block.editorAction !== undefined) steps.push({ kind: 'editor', key: `editor:${block.id}`, tool: block as EditorTool });
    else if (block.widget !== undefined) steps.push({ kind: 'widget', key: `widget:${block.id}`, tool: block as WidgetTool });
    else if (block.name === AGENT_CALL) steps.push({ kind: 'agent', key: `agent:${block.id}`, tool: block, children: childrenUnder(turn, block.id) });
    else if (last?.kind === 'calls' && last.name === block.name && FILE_TOOLS.has(block.name)) steps[steps.length - 1] = { ...last, tools: [...last.tools, block] };
    else steps.push({ kind: 'calls', key: `calls:${block.id}`, name: block.name, tools: [block] });
  }
  if (turn.notice !== undefined) steps.push({ kind: 'notice', key: 'notice', text: turn.notice });
  else if (isThinking(turn)) steps.push({ kind: 'thinking', key: 'thinking', progress: turn.progress });
  const pinned = streaming ? pinnedList(turn, carried) : undefined;
  if (pinned !== undefined) steps.splice(Math.max(0, steps.length - 1), 0, { kind: 'todo', key: 'todo', turn: turn.id, ...pinned });
  const edits = turn.blocks.flatMap((b) => (b.kind === 'tool' && isEdit(b) ? [b] : []));
  if (edits.length > 0) steps.push({ kind: 'changes', key: 'changes', edits });
  return steps;
}

/** A running turn whose last word was not text and that runs and asks nothing is waiting on the model, unless its call waits offline or for a limit. */
function isThinking(turn: Turn): boolean {
  if (turn.status !== 'streaming' || turn.waiting !== undefined) return false;
  const busy = turn.blocks.some((b) => (b.kind === 'tool' && b.status === 'running') || (b.kind === 'permission' && b.outcome.kind === 'open'));
  return !busy && turn.blocks.at(-1)?.kind !== 'text';
}

export const isWaiting = (turn: Turn): boolean => turn.blocks.some((b) => b.kind === 'permission' && b.outcome.kind === 'open');

export function nodeOf(step: Step): NodeState {
  switch (step.kind) {
    case 'text':
    case 'steer':
      return 'text';
    case 'calls':
      if (step.tools.some((t) => t.status === 'running')) return 'live';
      if (step.tools.some((t) => t.status === 'failed')) return 'failed';
      return step.tools.every((t) => t.status === 'denied') ? 'denied' : 'done';
    case 'permission':
      return step.block.outcome.kind === 'open' ? 'wait' : 'done';
    case 'error':
      return 'failed';
    case 'editor':
    case 'spinoff':
    case 'compact':
    case 'chapter':
      return 'done';
    case 'widget':
      return step.tool.status === 'running' ? 'live' : step.tool.status === 'failed' ? 'failed' : 'done';
    case 'todo':
      return step.place === 'live' ? 'live' : 'done';
    case 'agent':
      if (step.tool.status === 'running' || step.children.some((child) => child.status.kind === 'running')) return 'live';
      return step.tool.status === 'failed' ? 'failed' : step.tool.status === 'denied' ? 'denied' : 'done';
    case 'notice':
    case 'thinking':
      return 'live';
    case 'changes':
    case 'fold':
    case 'files':
      return 'done';
  }
}

const WAIT_HEADERS: Readonly<Record<WaitKind, string>> = { offline: 'waiting for the network', limited: 'waiting for the rate limit' };

/** The line beside the avatar: what the turn is doing now, or how long it worked, its waits left out. */
export function headerOf(turn: Turn, format: (ms: number) => string): string {
  if (turn.status === 'streaming') return isWaiting(turn) ? 'waiting for you' : turn.waiting !== undefined ? WAIT_HEADERS[turn.waiting.kind] : 'working';
  const took = turn.endedAt === undefined ? '' : ` ${turn.status === 'done' ? 'for' : 'after'} ${format(workedMs(turn, turn.endedAt))}`;
  return { done: `worked${took}`, stopped: `stopped${took}`, failed: `failed${took}` }[turn.status];
}
