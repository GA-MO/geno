import type {
  ContentBlock,
  ImageBlockParam,
  MessageParam,
  StopReason,
  TextBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages/messages';
import { DEFAULT_SESSION_MODE, type SessionMode } from './approval.js';
import { fileItem, imageBlock, NO_ATTACHMENTS, type Attachment, type FileAttachment, type ImageAttachment, type StoredAttachments } from './attachments.js';
import { backgroundEndNotice, type BackgroundEndEvent } from './background.js';
import type { Invocation } from './commands.js';
import { renderContextItems, renderLoadedContext, type ContextItem, type LoadedContext } from './context.js';
import type { HunkStatus } from './hunks.js';
import type { ApprovalRecord } from './classifier.js';
import type { ModelRetry } from './model-error.js';
import type { EditorAction } from './editor-actions.js';
import type { FileChange, HunkId } from './review.js';
import type { InterruptedTool, ModelMarks, ToolMarks } from './timing.js';
import { spillNotice, type Spill } from './tools.js';
import type { ProviderName } from './providers.js';
import type { ChildEvent, ChildOf } from './subagent.js';
import type { WaitEvent } from './waiting.js';
import { wakeNoteText, type WakeEvent, type WakeTrigger } from './wake.js';
import type { LaneApplyRecord } from './tasks.js';
import type { BackendBinding, BackendStart } from './backends.js';
import type { PartRun } from './parts.js';
import type { CutEvent, ForkOrigin } from './rewind.js';
import { compactedText, contextView, type CompactEvent } from './compact.js';
import { renderEnvironment, type Environment } from './environment.js';
import { arrivalText, GENO_NOTE, STOPPED_TURN_NOTE, USER_PROMPT_FOLLOWS, userSteerText } from './fence.js';
import { nudgeText, type ReportNudgeEvent } from './handback.js';
import { changedOnDiskNote, type FileChangedEvent, type FileStamp } from './file-tracker.js';
import { renderMemory, type MemoryEntry } from './memory.js';
import { isMcpToolName, MCP_SPILL_NOTE } from './mcp-notice.js';
import { noticeTexts, type Notice } from './notice.js';
import { hookContextTexts, type HookContextEvent } from './hooks.js';
import type { Brand } from './types.js';
import type { TodoList } from './todo.js';
import type { SpinoffEvent, SpinoffNote } from './spinoff.js';
import type { ChapterEvent, ChapterMark } from './chapters.js';
import type { WidgetRef } from './widget.js';

export type SessionId = Brand<string, 'SessionId'>;
export const asSessionId = (raw: string): SessionId => raw as SessionId;

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
export const isEffort = (raw: string): raw is Effort => (EFFORTS as readonly string[]).includes(raw);

export type Session = {
  readonly id: SessionId;
  readonly createdAt: string;
  readonly workspace: string;
  readonly provider: ProviderName;
  readonly model: string;
  readonly effort: Effort;
  /** The external agent the session runs on; absent for Geno's own loop. */
  readonly backend?: BackendBinding | undefined;
};

/** A workflow's own session: the workflow, and the session whose call started it, which its report goes to. */
export type WorkflowOrigin = {
  readonly parentId: SessionId;
  readonly toolUseId: string;
  readonly name: string;
  /** The run's input, which a resumed run keeps unless given another; absent in logs from before P33. */
  readonly input?: string | undefined;
  /** The earlier run whose journal this one replays. */
  readonly resumes?: SessionId | undefined;
};

export type TokenUsage = {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
};

export const ZERO_USAGE: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

/** A model call's spend as the log records it. */
export type Spend = { readonly usage: TokenUsage; readonly costUsd: number | null; readonly model: string };

export const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  output: a.output + b.output,
});

/**
 * `overflow` is a request too long for the model's context window; `transport` is any other failed call. `blocked` is a
 * prompt a UserPromptSubmit hook stopped before the model saw it.
 */
export const TURN_ERROR_KINDS = ['refusal', 'transport', 'overflow', 'abort', 'max-turns', 'budget', 'blocked'] as const;
export type TurnErrorKind = (typeof TURN_ERROR_KINDS)[number];

export type AssistantTurn = {
  readonly content: readonly ContentBlock[];
  readonly stopReason: StopReason | null;
  readonly usage: TokenUsage;
  readonly costUsd: number | null;
  readonly latencyMs: number;
  readonly model: string;
  /** The request split into parts by the tokenizer estimate; absent in logs written before requests were split. */
  readonly promptParts?: readonly PartRun[] | undefined;
  /**
   * The name of the request's snapshot, the request without its messages, kept by the engine; with the log before
   * the turn it rebuilds the request. Absent in logs written before requests were kept.
   */
  readonly snapshot?: string | undefined;
};

export type TurnResult =
  | { readonly kind: 'answer'; readonly turn: AssistantTurn }
  | { readonly kind: 'error'; readonly error: TurnErrorKind; readonly message: string };

/**
 * `denied` is a call a rule, the classifier or the non-interactive policy refused to run. `rejected` is one the user
 * turned down on its card, which ends the turn there (loop.ts).
 */
export const TOOL_STATUSES = ['ok', 'error', 'denied', 'rejected'] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];

/** A result is either short enough to keep inline or spilled to a file the model can read in ranges. */
export type ToolOutput = { readonly output: string } | { readonly spill: Spill };

export type ToolResultEvent = {
  readonly kind: 'tool-result';
  readonly seq: number;
  readonly at: string;
  readonly toolUseId: string;
  /** As the model sent it, so a call to an unknown tool is still logged. */
  readonly name: string;
  readonly status: ToolStatus;
  /** The file edit this tool made, for review. */
  readonly change?: FileChange | undefined;
  /** How a flagged command was let through or refused. */
  readonly approval?: ApprovalRecord | undefined;
  /** Images the tool returned beside its text, such as a read of a PNG. */
  readonly images?: readonly ImageAttachment[] | undefined;
  /** The widget a show_widget call drew, stored by its hash. */
  readonly widget?: WidgetRef | undefined;
  /** What an editor tool showed the user, so its step can show it again. */
  readonly editorAction?: EditorAction | undefined;
  /** The whole list a todo call set (`todo.ts`). */
  readonly todo?: TodoList | undefined;
  /** The deferred tools a tool_search call loaded, callable from then on in the session (`deferred-tools.ts`). */
  readonly loaded?: readonly string[] | undefined;
  /** The suggestion a spawn_task call offered, or the one a dismiss_task call withdrew (`spinoff.ts`). */
  readonly spinoff?: SpinoffNote | undefined;
  /** The chapter a mark_chapter call started (`chapters.ts`). */
  readonly chapter?: ChapterMark | undefined;
  /** The file a read showed or an edit wrote, as the model now knows it (`file-tracker.ts`). */
  readonly file?: FileStamp | undefined;
  /** Absent in logs written before turns were timed. */
  readonly timing?: ToolMarks | undefined;
} & ToolOutput;

/** The workspace as it was before model turn `turnSeq`, committed to the workspace's shadow repo. */
export type Checkpoint = {
  readonly sessionId: SessionId;
  readonly turnSeq: number;
  readonly sha: string;
  /** Paths that changed since the session's previous checkpoint. */
  readonly files: readonly string[];
  readonly label: string;
};

export type TurnEvent =
  /**
   * `context` is absent in logs written before sessions loaded any, `environment` in logs written before sessions
   * recorded one, and `memory` when there were no notes; `child` is present in a subagent's own log, `fork` in a fork's.
   */
  | {
      readonly kind: 'session-start';
      readonly session: Session;
      readonly context?: LoadedContext | undefined;
      /** The memory notes when the session started, frozen like the loaded context; a later change arrives as a notice. */
      readonly memory?: readonly MemoryEntry[] | undefined;
      readonly environment?: Environment | undefined;
      readonly child?: ChildOf | undefined;
      readonly fork?: ForkOrigin | undefined;
      readonly workflow?: WorkflowOrigin | undefined;
    }
  | ({ readonly kind: 'checkpoint'; readonly seq: number; readonly at: string } & Checkpoint)
  | {
      readonly kind: 'restored';
      readonly seq: number;
      readonly at: string;
      readonly turnSeq: number;
      readonly sha: string;
      /** Paths rewritten or deleted to match the checkpoint. */
      readonly files: readonly string[];
    }
  | {
      readonly kind: 'user';
      readonly seq: number;
      readonly at: string;
      /** What the user typed: the one trusted text in the conversation. */
      readonly content: string;
      /** What the user attached to the prompt, rendered after it. */
      readonly context?: readonly ContextItem[] | undefined;
      /** Images and files the user sent with the prompt, as references into the session's attachments folder. */
      readonly attachments?: readonly Attachment[] | undefined;
      /** The slash command `content` was expanded from. */
      readonly command?: Invocation | undefined;
      /** Delivered into a running turn, after its last tool results, rather than starting one (`steer.ts`). */
      readonly steer?: true | undefined;
      /**
       * Someone other than the user: the parent agent's steer, a background child's report, or the engine itself,
       * which starts a woken turn (`wake.ts`).
       */
      readonly from?: 'parent' | 'child' | 'wake' | undefined;
      /** What woke the session, on a woken turn's first event. */
      readonly wake?: readonly WakeTrigger[] | undefined;
    }
  /**
   * `timing` is absent in logs written before turns were timed. `issuedBy: 'user'` marks a tool call the user typed,
   * such as `@explore`, which the engine logged in place of a model call.
   */
  | ({ readonly kind: 'assistant'; readonly seq: number; readonly at: string; readonly timing?: ModelMarks | undefined; readonly issuedBy?: 'user' | undefined } & AssistantTurn)
  | {
      readonly kind: 'error';
      readonly seq: number;
      readonly at: string;
      readonly error: TurnErrorKind;
      readonly message: string;
      /** The model call that failed or was interrupted. */
      readonly timing?: ModelMarks | undefined;
      /**
       * The calls the user interrupted while they ran, timed up to the stop. Their stopped results are logged before
       * this event; in logs written before that, the batch's calls have no results and every call here had started.
       */
      readonly tools?: readonly InterruptedTool[] | undefined;
    }
  | { readonly kind: 'review'; readonly seq: number; readonly at: string; readonly hunk: HunkId; readonly status: HunkStatus }
  | ({ readonly kind: 'retry'; readonly seq: number; readonly at: string } & ModelRetry)
  /**
   * The user switched the session's approval mode; it holds until the next switch, across resumes. A switch logged while
   * a turn runs has no seq, because the turn numbers its own events and is still writing them.
   */
  | { readonly kind: 'mode'; readonly seq?: number | undefined; readonly at: string; readonly mode: SessionMode }
  /** What the model was told at a safe point of a mode switch or a memory change (`notice.ts`). */
  | ({ readonly kind: 'notice'; readonly seq: number; readonly at: string } & Notice)
  /** The user set the session's effort; it holds from the next model call until the next change, across resumes. Like a mode switch, one set during a turn has no seq. */
  | { readonly kind: 'effort'; readonly seq?: number | undefined; readonly at: string; readonly effort: Effort }
  /** A name the user gave the session; the latest one wins over the first prompt. */
  | { readonly kind: 'title'; readonly seq: number; readonly at: string; readonly title: string }
  /** A lane applied into this session's workspace, its changes put under review like an edit's. */
  | ({ readonly kind: 'lane-apply'; readonly seq: number; readonly at: string; readonly changes: readonly FileChange[] } & LaneApplyRecord)
  | BackgroundEndEvent
  /** An external agent's session started: on the first turn, and again after its process died or the engine restarted. */
  | ({ readonly kind: 'backend-start'; readonly seq: number; readonly at: string } & BackendStart)
  /** The user chose one of the external agent's models; like an effort change, one made during a turn has no seq. */
  | { readonly kind: 'backend-model'; readonly seq?: number | undefined; readonly at: string; readonly model: string }
  | WaitEvent
  | WakeEvent
  /** The user started or dismissed a suggested task. */
  | SpinoffEvent
  /** The user marked, renamed or removed a chapter at one of their messages. */
  | ChapterEvent
  | ChildEvent
  | CutEvent
  | CompactEvent
  /** A file the model read changed on disk; logged at the safe point before the model call that is told of it. */
  | FileChangedEvent
  /** What a hook told the model, such as SessionStart's output (`hooks.ts`). */
  | HookContextEvent
  | ReportNudgeEvent
  | ToolResultEvent;

export type TurnEventKind = TurnEvent['kind'];

/** Checkpoints, restores, review decisions, retries, waits, titles, child events and background ends record what happened around the conversation; the loop steps over them. */
export const IN_CONVERSATION: Readonly<Record<TurnEventKind, boolean>> = {
  'session-start': true,
  user: true,
  assistant: true,
  error: true,
  'tool-result': true,
  checkpoint: false,
  restored: false,
  review: false,
  retry: false,
  mode: false,
  notice: false,
  effort: false,
  title: false,
  'child-start': false,
  'child-end': false,
  'lane-apply': false,
  'background-end': false,
  wait: false,
  wake: false,
  'backend-start': false,
  'backend-model': false,
  spinoff: false,
  chapter: false,
  cut: false,
  compact: false,
  'file-changed': false,
  'hook-context': false,
  'report-nudge': true,
};

export const restoredNotice = (event: Extract<TurnEvent, { kind: 'restored' }>): string =>
  `${GENO_NOTE} The user rewound the workspace to how it was before turn ${event.turnSeq}. ${
    event.files.length === 0 ? 'No files changed.' : `These files were restored: ${event.files.join(', ')}.`
  } Read a file again before editing it.`;

export const sessionModeOf = (events: readonly TurnEvent[]): SessionMode =>
  events.findLast((e) => e.kind === 'mode')?.mode ?? DEFAULT_SESSION_MODE;

export const sessionEffortOf = (session: Session, events: readonly TurnEvent[]): Effort =>
  events.findLast((e) => e.kind === 'effort')?.effort ?? session.effort;

export const nextSeq = (events: readonly TurnEvent[]): number => {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind === 'session-start') return 1;
    if (event.seq !== undefined) return event.seq + 1;
  }
  return 1;
};

// A refused or blocked prompt is dropped so later turns do not resend it; an interrupted or stopped one is answered on the next run.
export const KEEPS_PENDING_PROMPT: Record<TurnErrorKind, boolean> = {
  refusal: false,
  blocked: false,
  transport: true,
  overflow: true,
  abort: true,
  'max-turns': true,
  budget: true,
};

/** What a model call cost, for the events that record one: a model turn, and a compaction's summary call. */
export const spendOf = (event: TurnEvent): Spend | undefined =>
  event.kind === 'assistant' || event.kind === 'compact' ? { usage: event.usage, costUsd: event.costUsd, model: event.model } : undefined;

/** What the Auto classifier's call cost to settle one tool call; 0 when none ran or its model has no price. */
export const classifierCostOf = (event: TurnEvent): number => (event.kind === 'tool-result' ? (event.approval?.classifier?.costUsd ?? 0) : 0);

export const toolUsesOf = (content: readonly ContentBlock[]): ToolUseBlock[] =>
  content.filter((block): block is ToolUseBlock => block.type === 'tool_use');

export const toolResultText = (event: ToolResultEvent): string =>
  'spill' in event ? (isMcpToolName(event.name) ? `${spillNotice(event.spill)}\n${MCP_SPILL_NOTE}` : spillNotice(event.spill)) : event.output;

const toolResultBlock = (event: ToolResultEvent, stored: StoredAttachments): ToolResultBlockParam => ({
  type: 'tool_result',
  tool_use_id: event.toolUseId,
  content:
    event.images === undefined || event.images.length === 0
      ? toolResultText(event)
      : [{ type: 'text', text: toolResultText(event) }, ...event.images.map((image) => imageBlock(image, stored))],
  ...(event.status === 'ok' ? {} : { is_error: true }),
});

const shownPath = (file: FileAttachment, workspace: string): string => {
  if (file.path === undefined) return file.name;
  const root = workspace.endsWith('/') ? workspace : `${workspace}/`;
  return file.path.startsWith(root) ? file.path.slice(root.length) : file.path;
};

type UserEvent = Extract<TurnEvent, { kind: 'user' }>;

/**
 * A user event's text as the model reads it, by who sent it. The log keeps what was sent; only the user's own
 * prompt goes as it is. A woken turn's text is the arrival notice already.
 */
const SENDER_TEXT: Readonly<Record<'prompt' | 'steer' | NonNullable<UserEvent['from']>, (text: string) => string>> = {
  prompt: (text) => text,
  steer: userSteerText,
  parent: arrivalText,
  child: arrivalText,
  wake: (text) => text,
};

const senderOf = (event: UserEvent): keyof typeof SENDER_TEXT => event.from ?? (event.steer === true ? 'steer' : 'prompt');

/** Images first, which the model reads best before the text about them; then the prompt; then mentions and attached files. */
function userBlocks(event: Extract<TurnEvent, { kind: 'user' }>, stored: StoredAttachments, workspace: string): (TextBlockParam | ImageBlockParam)[] {
  const attachments = event.attachments ?? [];
  const images = attachments.flatMap((a) => (a.kind === 'image' ? [imageBlock(a, stored)] : []));
  const items = [...(event.context ?? []), ...attachments.flatMap((a) => (a.kind === 'file' ? [fileItem(a, stored, shownPath(a, workspace))] : []))];
  return [
    ...images,
    // A message of attachments alone has no prompt text, and the API refuses an empty text block.
    ...(event.content === '' ? [] : [{ type: 'text' as const, text: SENDER_TEXT[senderOf(event)](event.content) }]),
    ...(items.length === 0 ? [] : [{ type: 'text' as const, text: renderContextItems(items) }]),
  ];
}

/** The hooks whose text goes with the prompts, in the order logged, rather than with the opening or the notices. */
const PROMPT_HOOKS: ReadonlySet<HookContextEvent['event']> = new Set(['UserPromptSubmit', 'Stop', 'SubagentStop', 'SubagentStart']);

/**
 * The conversation to send next. Everything after an assistant turn becomes one user message: its tool
 * results in the order the model asked for them, then any notices, then any unanswered prompts. The session's loaded
 * context, its memory and its environment open the first user message, after the system prompt, so they are cached
 * with the prefix but never part of it, and the system prompt stays the same for every session and every mode.
 * `stored` holds the bytes of the attachments the events reference; one it lacks is replaced by a note. After a
 * compaction, the conversation is its `contextView`: the compaction's text opens it in place of the turns it replaced.
 */
export function replayMessages(events: readonly TurnEvent[], stored: StoredAttachments = NO_ATTACHMENTS): MessageParam[] {
  const messages: MessageParam[] = [];
  let toolUses: readonly ToolUseBlock[] = [];
  let results = new Map<string, ToolResultBlockParam>();
  let prompts: (TextBlockParam | ImageBlockParam)[] = [];
  let workspace = '';
  // Kept apart from the prompts, so a refused prompt does not take the loaded context or the compacted turns with it.
  let opening: TextBlockParam[] = [];
  // Notices too: a refused prompt leaves the mode it was sent in. They go out only with something to answer.
  let notices: TextBlockParam[] = [];
  // Whether the prompts hold one the user wrote, which the notices must not seem to cover.
  let typed = false;
  // Whether the user stopped the turn since the model last answered.
  let stopped = false;
  // Before a model turn the opening goes out even alone: a compaction can keep from the middle of a turn.
  const flush = (beforeTurn: boolean) => {
    const answers = toolUses.flatMap((use) => results.get(use.id) ?? []);
    if (answers.length + prompts.length > 0 || (beforeTurn && opening.length + notices.length > 0)) {
      const follows = notices.length > 0 && typed ? [{ type: 'text' as const, text: USER_PROMPT_FOLLOWS }] : [];
      messages.push({ role: 'user', content: [...opening, ...answers, ...notices, ...follows, ...prompts] });
      opening = [];
      notices = [];
    }
    toolUses = [];
    results = new Map();
    prompts = [];
    typed = false;
    stopped = false;
  };
  for (const event of contextView(events)) {
    if (event.kind === 'session-start') {
      workspace = event.session.workspace;
      const loaded = event.context === undefined ? undefined : renderLoadedContext(event.context);
      const memory = event.memory === undefined ? undefined : renderMemory(event.memory);
      const environment = event.environment === undefined ? undefined : renderEnvironment(event.environment, event.session);
      opening = [loaded, memory, environment].flatMap((text) => (text === undefined ? [] : [{ type: 'text' as const, text }]));
    }
    if (event.kind === 'hook-context') {
      const texts = hookContextTexts(event).map((text) => ({ type: 'text' as const, text }));
      if ('toolUseId' in event) {
        const result = results.get(event.toolUseId);
        if (result !== undefined) results.set(event.toolUseId, { ...result, content: [...(typeof result.content === 'string' ? [{ type: 'text' as const, text: result.content }] : (result.content ?? [])), ...texts] });
      } else {
        // UserPromptSubmit's output goes with its prompt, and is dropped with it; Stop's is what the model answers next.
        // SubagentStart's is logged just before the subagent's task or its parent's message, so it comes first.
        const place = PROMPT_HOOKS.has(event.event) ? prompts : event.event === 'SessionStart' && event.matched === 'startup' ? opening : notices;
        place.push(...texts);
      }
    }
    if (event.kind === 'notice') notices.push(...noticeTexts(event).map((text) => ({ type: 'text' as const, text })));
    if (event.kind === 'user') {
      // A new message after a Stop, not a resume of the stopped one.
      if (stopped && event.from === undefined && event.steer !== true) prompts.push({ type: 'text', text: STOPPED_TURN_NOTE });
      stopped = false;
      prompts.push(...userBlocks(event, stored, workspace));
      typed ||= event.from === undefined;
    }
    if (event.kind === 'compact') opening.push({ type: 'text', text: compactedText(event) });
    if (event.kind === 'restored') prompts.push({ type: 'text', text: restoredNotice(event) });
    if (event.kind === 'background-end') prompts.push({ type: 'text', text: backgroundEndNotice(event) });
    if (event.kind === 'report-nudge') prompts.push({ type: 'text', text: nudgeText(event) });
    if (event.kind === 'file-changed') prompts.push({ type: 'text', text: changedOnDiskNote(event.shown, event.excerpt) });
    const noted = event.kind === 'wake' ? wakeNoteText(event.note) : undefined;
    if (noted !== undefined) prompts.push({ type: 'text', text: noted });
    if (event.kind === 'error' && event.error === 'abort') stopped = true;
    if (event.kind === 'error' && !KEEPS_PENDING_PROMPT[event.error]) {
      prompts = [];
      typed = false;
    }
    if (event.kind === 'tool-result') results.set(event.toolUseId, toolResultBlock(event, stored));
    if (event.kind === 'assistant') {
      flush(true);
      // Response blocks go back verbatim: thinking signatures are verified against the exact bytes.
      messages.push({ role: 'assistant', content: [...event.content] });
      toolUses = toolUsesOf(event.content);
    }
  }
  flush(false);
  return messages;
}

export const hasPendingPrompt = (events: readonly TurnEvent[]): boolean =>
  replayMessages(events).at(-1)?.role === 'user';
