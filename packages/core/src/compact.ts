import type { TokenUsage, TurnEvent } from './session.js';
import type { TodoList, TodoStatus } from './todo.js';

/**
 * Context compaction (U47): the data shape. A compaction is one `compact` event appended to the session log. Nothing
 * before it is deleted or rewritten: the model's context is rebuilt from the latest compaction and the events from the
 * one it kept from (`contextView`), while the panel, rewind and fork keep reading the whole log. This file imports only
 * types, so the session's replay and the webview can use it; the cut rule and the summary request are `compaction.ts`.
 */

/** Before a model call whose context would pass this share of the model's window, Geno compacts first. */
export const COMPACT_AT = 0.8;

/** About this many tokens of the newest events stay verbatim after a compaction; the cut moves to a turn boundary. */
export const KEEP_TAIL_TOKENS = 20_000;

/** Where auto compaction starts, in tokens: the user's own setting, else COMPACT_AT of a known window, else never. */
export const compactAtTokens = (window: number | undefined, setting?: number): number | undefined =>
  setting ?? (window === undefined ? undefined : Math.floor(COMPACT_AT * window));

/** The tail kept verbatim: KEEP_TAIL_TOKENS, or a quarter of the threshold on a small window, so the summary has room. */
export const keepTailTokens = (compactAt: number | undefined): number =>
  compactAt === undefined ? KEEP_TAIL_TOKENS : Math.min(KEEP_TAIL_TOKENS, Math.floor(compactAt / 4));

/** `auto` passed COMPACT_AT before a call, `overflow` is a call the provider refused as too long, `manual` is /compact. */
export const COMPACT_TRIGGERS = ['auto', 'overflow', 'manual'] as const;
export type CompactTrigger = (typeof COMPACT_TRIGGERS)[number];

/**
 * A message the summary must not paraphrase: the user's own text, or the parent agent's steer to a subagent. `steer`
 * marks one that joined a running turn.
 */
export type KeptMessage = { readonly seq: number; readonly from: 'user' | 'parent'; readonly steer: boolean; readonly text: string };

export type CompactFiles = { readonly read: readonly string[]; readonly changed: readonly string[] };

/**
 * What a compaction carries verbatim beside the summary, as of its cut, so a later compaction folds on from it without
 * the events it replaced. `tools` holds the definitions tool_search loaded, as the model saw them, so a loaded tool
 * stays callable and described.
 */
export type Kept = {
  readonly messages: readonly KeptMessage[];
  /** How many older messages the budget left out; the summary covers them. */
  readonly droppedMessages: number;
  readonly todo: TodoList;
  readonly tools: readonly string[];
  readonly files: CompactFiles;
};

export const EMPTY_KEPT: Kept = { messages: [], droppedMessages: 0, todo: [], tools: [], files: { read: [], changed: [] } };

export type CompactEvent = {
  readonly kind: 'compact';
  readonly seq: number;
  readonly at: string;
  readonly trigger: CompactTrigger;
  /** The seq of the first event the model still reads verbatim; the summary stands for every conversation event before it. */
  readonly keptFrom: number;
  /** The model's summary: Goal, Progress, Decisions, Next steps. */
  readonly summary: string;
  /** What the user asked the summary to focus on, with /compact. */
  readonly focus?: string | undefined;
  readonly kept: Kept;
  /** The context before, from the last call's usage and an estimate of what was queued after it. */
  readonly tokensBefore: number;
  /** An estimate of the context after, until the next call measures it. */
  readonly tokensAfter: number;
  /** The summary call's own spend, which counts in the session's usage and budget like a model turn. */
  readonly usage: TokenUsage;
  readonly costUsd: number | null;
  readonly model: string;
};

const seqOf = (event: TurnEvent): number | undefined => (event.kind === 'session-start' ? undefined : event.seq);

/**
 * The events the model's context is built from. Without a compaction, all of them. With one, the session start (the
 * loaded context opens the first message), then the latest compaction, then every event from the one it kept from
 * but earlier compactions: a compaction logged mid-turn can sit after the next one's cut, and the next one's summary
 * already covers it. Idempotent: the view of a view is itself.
 */
export function contextView(events: readonly TurnEvent[]): readonly TurnEvent[] {
  const at = events.findLastIndex((event) => event.kind === 'compact');
  const compact = events[at];
  if (compact?.kind !== 'compact') return events;
  const from = events.findIndex((event) => seqOf(event) === compact.keptFrom);
  if (from === -1 || from > at) return events;
  return [events[0]!, compact, ...events.slice(from).filter((event) => event.kind !== 'compact')];
}

const TODO_MARKS: Readonly<Record<TodoStatus, string>> = { pending: '[ ]', in_progress: '[~]', done: '[x]' };

const MESSAGE_LABELS: Readonly<Record<KeptMessage['from'], (steer: boolean) => string>> = {
  user: (steer) => (steer ? 'The user, while you worked' : 'The user'),
  parent: () => 'The agent that started you, while you worked',
};

/** What the model reads in place of the turns a compaction replaced. Byte-stable for a given event, so the cache holds. */
export function compactedText({ summary, kept }: Pick<CompactEvent, 'summary' | 'kept'>): string {
  const { messages, droppedMessages, todo, tools, files } = kept;
  return [
    '<compacted_context>',
    'The earlier part of this session was compacted to free context. The summary below replaces those turns; the turns after this message follow as they happened. Read a file again before you edit it.',
    '',
    '<user_messages>',
    droppedMessages === 0 ? 'Every message the user sent before this point, word for word, oldest first:' : `The newest messages the user sent before this point, word for word, oldest first (${droppedMessages} older ones are in the summary):`,
    ...messages.map((message) => `- ${MESSAGE_LABELS[message.from](message.steer)}: ${message.text}`),
    '</user_messages>',
    '',
    '<summary>',
    summary.trim(),
    '</summary>',
    ...(files.read.length === 0 && files.changed.length === 0
      ? []
      : ['', `Files read: ${files.read.join(', ') || 'none'}`, `Files changed: ${files.changed.join(', ') || 'none'}`]),
    ...(todo.length === 0 ? [] : ['', 'Your todo list as it stood:', ...todo.map((item) => `${TODO_MARKS[item.status]} ${item.id}: ${item.text}`)]),
    ...(tools.length === 0 ? [] : ['', 'Tools you loaded with tool_search, still callable without loading them again:', ...tools]),
    '</compacted_context>',
  ].join('\n');
}

/** Key in an agent_message_chunk's `_meta`: the compaction the chunk stands for, which the panel draws as a divider. */
export const COMPACT_META = 'gcode/compact';

export type CompactMark = {
  readonly seq: number;
  readonly trigger: CompactTrigger;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly summary: string;
  readonly files: CompactFiles;
  readonly focus?: string | undefined;
};

export const compactMarkOf = ({ seq, trigger, tokensBefore, tokensAfter, summary, kept, focus }: CompactEvent): CompactMark => ({
  seq,
  trigger,
  tokensBefore,
  tokensAfter,
  summary,
  files: kept.files,
  ...(focus === undefined ? {} : { focus }),
});

/** The divider in plain words, as the chunk's text, for a client that does not read COMPACT_META. */
export const compactNotice = ({ tokensBefore, tokensAfter }: Pick<CompactEvent, 'tokensBefore' | 'tokensAfter'>): string =>
  `\n\n[Context compacted: ${tokensBefore.toLocaleString('en-US')} → about ${tokensAfter.toLocaleString('en-US')} tokens]\n\n`;
