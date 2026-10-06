import type { AskUserAnswer, ChildEnd } from '@g-code/core';
import type { Action, Block, Child, PermissionBlock, PermissionOutcome, ToolBlock, Transcript, Turn, TurnStatus } from './messages.js';
import { withSteer } from './steer-model.js';

export const emptyTranscript = (model: string): Transcript => ({ model, turns: [] });

type ActionOf<K extends Action['type']> = Extract<Action, { type: K }>;

/** Replaces the last turn with `change(turn)`; a transcript with no turns, or an unchanged turn, is returned as is. */
function onLast(transcript: Transcript, change: (turn: Turn) => Turn): Transcript {
  const last = transcript.turns.at(-1);
  if (last === undefined) return transcript;
  const next = change(last);
  return next === last ? transcript : { ...transcript, turns: [...transcript.turns.slice(0, -1), next] };
}

/** Replaces the blocks `pick` selects with `change(block)`, keeping every other block, and the turn, by identity. */
function mapBlocks<B extends Block>(turn: Turn, pick: (block: Block) => block is B, change: (block: B) => B): Turn {
  let changed = false;
  const blocks = turn.blocks.map((block) => {
    if (!pick(block)) return block;
    const next = change(block);
    changed ||= next !== block;
    return next;
  });
  return changed ? { ...turn, blocks } : turn;
}

const isTool = (block: Block): block is ToolBlock => block.kind === 'tool';
const toolWithId = (id: string) => (block: Block): block is ToolBlock => block.kind === 'tool' && block.id === id;
const isRunningTool = (block: Block): block is ToolBlock => block.kind === 'tool' && block.status === 'running';
const isOpen = (id?: string) => (block: Block): block is PermissionBlock =>
  block.kind === 'permission' && block.outcome.kind === 'open' && (id === undefined || block.id === id);
const answered = (answer: AskUserAnswer): PermissionOutcome => (answer.kind === 'answered' ? { kind: 'answered', answers: answer.answers } : { kind: 'skipped' });
const nextId = (turn: Turn): string => `${turn.id}:${turn.blocks.length}`;

function newTool(id: string, at: number): ToolBlock {
  return { kind: 'tool', id, name: 'tool', target: '', toolKind: 'other', status: 'running', startedAt: at, endedAt: undefined, output: undefined, diff: undefined };
}

/** Creates the tool call if this is the first word of it; a write can arrive before the call's own update. */
function withTool(turn: Turn, id: string, at: number, change: (tool: ToolBlock) => ToolBlock): Turn {
  const exists = turn.blocks.some(toolWithId(id));
  const base = exists ? turn : { ...turn, blocks: [...turn.blocks, newTool(id, at)] };
  return mapBlocks(base, toolWithId(id), change);
}

const ended = (tool: ToolBlock, status: ToolBlock['status'] | undefined, at: number): number | undefined =>
  tool.endedAt ?? (status === undefined || status === 'running' ? undefined : at);

/** The turn with its wait, if any, ended at `at` and counted in `waitedMs`. */
function settleWait(turn: Turn, at: number): Turn {
  const was = turn.waiting;
  if (was === undefined) return turn;
  return { ...turn, waiting: undefined, waitedMs: (turn.waitedMs ?? 0) + Math.max(0, at - was.since) };
}

/** How long the turn has worked by `now`: its time so far without its waits offline or for a limit. */
export const workedMs = (turn: Turn, now: number): number =>
  (turn.endedAt ?? now) - turn.startedAt - (turn.waitedMs ?? 0) - (turn.waiting === undefined ? 0 : Math.max(0, now - turn.waiting.since));

/** The turn without its passing status, which any new output replaces. */
const quiet = (turn: Turn): Turn => (turn.notice === undefined ? turn : { ...turn, notice: undefined });

/** How a child's end reads on its own turn. */
const CHILD_TURN_ENDS: Readonly<Record<ChildEnd['kind'], Exclude<TurnStatus, 'streaming'>>> = { done: 'done', cancelled: 'stopped', failed: 'failed', capped: 'failed' };

/** Replaces the child `id` of the turn with `change(child)`; a turn without it, or an unchanged child, is returned as is. */
function withChild(turn: Turn, id: string, change: (child: Child) => Child): Turn {
  const child = turn.children?.[id];
  if (child === undefined) return turn;
  const next = change(child);
  return next === child ? turn : { ...turn, children: { ...turn.children, [id]: next } };
}

/** A child's turn after one action, through the same reducer as any turn. */
function childTurn(child: Child, action: Action): Child {
  const turn = reduce({ model: child.model, turns: [child.turn] }, action).turns[0]!;
  return turn === child.turn ? child : { ...child, turn };
}

/** A child that is still running ends `end`, with its turn; one that already ended keeps its end. */
function endChild(child: Child, at: number, end: ChildEnd, spent: Pick<Child, 'turns' | 'costUsd'>): Child {
  if (child.status.kind !== 'running') return child;
  return { ...childTurn(child, { type: 'turn-end', at, status: CHILD_TURN_ENDS[end.kind], usage: undefined }), status: end, endedAt: at, ...spent };
}

/** The engine's own end of a child: it replaces the cancel its parent's end assumed, keeping when the child stopped. */
function settleChild(child: Child, at: number, end: ChildEnd, spent: Pick<Child, 'turns' | 'costUsd'>): Child {
  if (child.endedByParent !== true) return endChild(child, at, end, spent);
  return { ...child, status: end, ...spent, endedByParent: undefined, turn: { ...child.turn, status: CHILD_TURN_ENDS[end.kind] } };
}

const REDUCERS: { readonly [K in Action['type']]: (transcript: Transcript, action: ActionOf<K>) => Transcript } = {
  reset: (_transcript, { transcript }) => transcript,
  model: (transcript, { model }) => (transcript.model === model ? transcript : { ...transcript, model }),
  backend: (transcript, { backend }) => (JSON.stringify(transcript.backend) === JSON.stringify(backend) ? transcript : { ...transcript, backend }),
  'turn-start': (transcript, { id, at, prompt, attachments, mode, command, seq }) => ({
    ...transcript,
    turns: [
      ...transcript.turns,
      {
        id,
        prompt,
        blocks: [],
        status: 'streaming',
        startedAt: at,
        endedAt: undefined,
        usage: undefined,
        mode,
        ...(attachments === undefined || attachments.length === 0 ? {} : { attachments }),
        ...(command === undefined ? {} : { command }),
        ...(seq === undefined ? {} : { seq }),
      },
    ],
  }),
  text: (transcript, { text }) =>
    onLast(transcript, (raw) => {
      const turn = quiet(raw);
      const last = turn.blocks.at(-1);
      if (last?.kind === 'text') return { ...turn, blocks: [...turn.blocks.slice(0, -1), { ...last, text: last.text + text }] };
      return { ...turn, blocks: [...turn.blocks, { kind: 'text', id: nextId(turn), text }] };
    }),
  notice: (transcript, { text }) => onLast(transcript, (turn) => (turn.status !== 'streaming' || turn.notice === text ? turn : { ...turn, notice: text })),
  waiting: (transcript, { at, waiting }) =>
    onLast(transcript, (turn) => {
      if (turn.status !== 'streaming') return turn;
      const was = turn.waiting;
      if (waiting !== null && was !== undefined && was.kind === waiting.kind && was.since === waiting.since) return { ...turn, waiting };
      return { ...settleWait(turn, at), waiting: waiting ?? undefined };
    }),
  tool: (transcript, { id, at, type: _type, ...fields }) =>
    onLast(transcript, (turn) =>
      withTool(quiet(turn), id, at, (tool) => {
        const defined = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<ToolBlock>;
        const next = { ...tool, ...defined, endedAt: ended(tool, fields.status, at) };
        return (Object.keys(next) as (keyof ToolBlock)[]).every((key) => next[key] === tool[key]) ? tool : next;
      }),
    ),
  diff: (transcript, { toolId, at, diff }) => onLast(transcript, (turn) => withTool(turn, toolId, at, (tool) => ({ ...tool, diff }))),
  background: (transcript, { toolId, job }) => {
    let changed = false;
    const turns = transcript.turns.map((turn) =>
      mapBlocks(turn, toolWithId(toolId), (tool) => {
        changed = true;
        return { ...tool, background: job };
      }),
    );
    return changed ? { ...transcript, turns } : transcript;
  },
  review: (transcript, { hunks }) => {
    let changed = false;
    const turns = transcript.turns.map((turn) =>
      mapBlocks(turn, isTool, (tool) => {
        if (tool.diff === undefined || !tool.diff.hunks.some((h) => hunks[h.id] !== undefined && hunks[h.id] !== h.status)) return tool;
        changed = true;
        return { ...tool, diff: { ...tool.diff, hunks: tool.diff.hunks.map((h) => ({ ...h, status: hunks[h.id] ?? h.status })) } };
      }),
    );
    return changed ? { ...transcript, turns } : transcript;
  },
  permission: (transcript, { id, command, reason, description, options, classifier, ask, toolId, toolKind }) =>
    onLast(transcript, (turn) => ({
      ...turn,
      blocks: [
        ...turn.blocks,
        { kind: 'permission', id, command, reason, ...(description === undefined ? {} : { description }), options, classifier, ...(ask === undefined ? {} : { ask }), ...(toolId === undefined ? {} : { toolId }), ...(toolKind === undefined ? {} : { toolKind }), outcome: { kind: 'open' } },
      ],
    })),
  'permission-done': (transcript, { id, optionId, answer }) =>
    onLast(transcript, (turn) =>
      mapBlocks(turn, isOpen(id), (block) => ({
        ...block,
        outcome: answer !== undefined ? answered(answer) : optionId === undefined ? { kind: 'cancelled' } : { kind: 'chosen', optionId },
      })),
    ),
  error: (transcript, { message }) => onLast(transcript, (turn) => ({ ...turn, blocks: [...turn.blocks, { kind: 'error', id: nextId(turn), message }] })),
  steer: (transcript, { seq, shown }) => onLast(transcript, (turn) => withSteer(turn, seq, shown)),
  'turn-end': (transcript, { at, status, usage, seq }) =>
    onLast(transcript, (turn) => {
      // Nothing more arrives for a turn once it ends, so what still runs or waits never will.
      const stopped = mapBlocks(turn, isRunningTool, (tool) => ({ ...tool, status: 'cancelled' }));
      const settled = mapBlocks(stopped, isOpen(), (block) => ({ ...block, outcome: { kind: 'cancelled' } }));
      const children = Object.keys(settled.children ?? {}).reduce((t, id) => withChild(t, id, (child) => (child.status.kind === 'running' ? { ...endChild(child, at, { kind: 'cancelled' }, { turns: child.turns, costUsd: child.costUsd }), endedByParent: true } : child)), settled);
      return { ...settleWait(quiet(children), at), status, endedAt: at, usage, ...(seq === undefined ? {} : { seq }) };
    }),
  'child-start': (transcript, { id, toolId, role, task, model, at }) =>
    onLast(transcript, (turn) => {
      if (turn.children?.[id] !== undefined) return turn;
      const own: Turn = { id, prompt: task, blocks: [], status: 'streaming', startedAt: at, endedAt: undefined, usage: undefined };
      const child: Child = { id, toolId, role, model, status: { kind: 'running' }, startedAt: at, endedAt: undefined, turns: 0, costUsd: undefined, turn: own };
      return { ...turn, children: { ...turn.children, [id]: child } };
    }),
  // Nothing a child streams after its end belongs to its turn.
  child: (transcript, { id, action }) => onLast(transcript, (turn) => withChild(turn, id, (child) => (child.status.kind === 'running' ? childTurn(child, action) : child))),
  'child-end': (transcript, { id, at, end, turns, costUsd }) => onLast(transcript, (turn) => withChild(turn, id, (child) => settleChild(child, at, end, { turns, costUsd }))),
};

/** The transcript after `action`. Parts the action leaves alone keep their identity, so a view can skip them. */
export const reduce = (transcript: Transcript, action: Action): Transcript =>
  (REDUCERS[action.type] as (t: Transcript, a: Action) => Transcript)(transcript, action);

export type Totals = { readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number | null; readonly turns: number };

/** The session so far, over the turns that reported usage; the cost is unknown if any of them had no price. */
export function totalsOf(transcript: Transcript): Totals {
  const used = transcript.turns.flatMap((turn) => (turn.usage === undefined ? [] : [turn.usage]));
  return {
    inputTokens: used.reduce((n, u) => n + u.inputTokens, 0),
    outputTokens: used.reduce((n, u) => n + u.outputTokens, 0),
    costUsd: used.some((u) => u.costUsd === null) ? null : used.reduce((n, u) => n + (u.costUsd ?? 0), 0),
    turns: used.length,
  };
}

export const isRunning = (transcript: Transcript): boolean => transcript.turns.at(-1)?.status === 'streaming';

/** The children of the last turn, the only one whose children can still run, that run now. */
export const runningChildren = (transcript: Transcript): Child[] => Object.values(transcript.turns.at(-1)?.children ?? {}).filter((child) => child.status.kind === 'running');

/** A child by its session id, in whichever turn started it. */
export const childOf = (transcript: Transcript, id: string): Child | undefined => transcript.turns.findLast((turn) => turn.children?.[id] !== undefined)?.children?.[id];
