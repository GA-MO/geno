import type { Action, Block, PermissionBlock, ToolBlock, Transcript, Turn } from './messages.js';

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

/** The turn without its passing status, which any new output replaces. */
const quiet = (turn: Turn): Turn => (turn.notice === undefined ? turn : { ...turn, notice: undefined });

const REDUCERS: { readonly [K in Action['type']]: (transcript: Transcript, action: ActionOf<K>) => Transcript } = {
  reset: (_transcript, { transcript }) => transcript,
  model: (transcript, { model }) => (transcript.model === model ? transcript : { ...transcript, model }),
  'turn-start': (transcript, { id, at, prompt, attachments, mode, command }) => ({
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
  tool: (transcript, { id, at, type: _type, ...fields }) =>
    onLast(transcript, (turn) =>
      withTool(quiet(turn), id, at, (tool) => {
        const defined = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<ToolBlock>;
        const next = { ...tool, ...defined, endedAt: ended(tool, fields.status, at) };
        return (Object.keys(next) as (keyof ToolBlock)[]).every((key) => next[key] === tool[key]) ? tool : next;
      }),
    ),
  diff: (transcript, { toolId, at, diff }) => onLast(transcript, (turn) => withTool(turn, toolId, at, (tool) => ({ ...tool, diff }))),
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
  permission: (transcript, { id, command, reason, options, classifier, ask, toolId }) =>
    onLast(transcript, (turn) => ({
      ...turn,
      blocks: [
        ...turn.blocks,
        { kind: 'permission', id, command, reason, options, classifier, ...(ask === undefined ? {} : { ask }), ...(toolId === undefined ? {} : { toolId }), outcome: { kind: 'open' } },
      ],
    })),
  'permission-done': (transcript, { id, optionId, answer }) =>
    onLast(transcript, (turn) =>
      mapBlocks(turn, isOpen(id), (block) => ({
        ...block,
        outcome: answer !== undefined ? { kind: 'answered', text: answer } : optionId === undefined ? { kind: 'cancelled' } : { kind: 'chosen', optionId },
      })),
    ),
  error: (transcript, { message }) => onLast(transcript, (turn) => ({ ...turn, blocks: [...turn.blocks, { kind: 'error', id: nextId(turn), message }] })),
  'turn-end': (transcript, { at, status, usage }) =>
    onLast(transcript, (turn) => {
      // Nothing more arrives for a turn once it ends, so what still runs or waits never will.
      const stopped = mapBlocks(turn, isRunningTool, (tool) => ({ ...tool, status: 'cancelled' }));
      const settled = mapBlocks(stopped, isOpen(), (block) => ({ ...block, outcome: { kind: 'cancelled' } }));
      return { ...quiet(settled), status, endedAt: at, usage };
    }),
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
