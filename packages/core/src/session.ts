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
import type { Invocation } from './commands.js';
import { renderContextItems, renderLoadedContext, type ContextItem, type LoadedContext } from './context.js';
import type { HunkStatus } from './hunks.js';
import type { ApprovalRecord } from './classifier.js';
import type { ModelRetry } from './model-error.js';
import type { FileChange, HunkId } from './review.js';
import { spillNotice, type Spill } from './tools.js';
import type { Brand } from './types.js';

export type SessionId = Brand<string, 'SessionId'>;
export const asSessionId = (raw: string): SessionId => raw as SessionId;

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
export const isEffort = (raw: string): raw is Effort => (EFFORTS as readonly string[]).includes(raw);

export const PROVIDERS = ['openrouter', 'modelstudio'] as const;
export type ProviderName = (typeof PROVIDERS)[number];
export const isProviderName = (raw: string): raw is ProviderName =>
  (PROVIDERS as readonly string[]).includes(raw);

/** The environment variables the engine reads each provider's key and, where it varies, endpoint from. */
export const PROVIDER_ENV = {
  openrouter: { key: 'OPENROUTER_API_KEY', baseUrl: undefined },
  modelstudio: { key: 'DASHSCOPE_API_KEY', baseUrl: 'DASHSCOPE_BASE_URL' },
} as const satisfies Record<ProviderName, { readonly key: string; readonly baseUrl: string | undefined }>;

/** The model a session uses when neither a flag, GCODE_MODEL nor the editor names one. */
export const DEFAULT_MODELS: Readonly<Record<ProviderName, string>> = {
  openrouter: 'anthropic/claude-opus-5.5',
  modelstudio: 'qwen3.8-flash',
};

export type Session = {
  readonly id: SessionId;
  readonly createdAt: string;
  readonly workspace: string;
  readonly provider: ProviderName;
  readonly model: string;
  readonly effort: Effort;
};

export type TokenUsage = {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
};

export const ZERO_USAGE: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

export const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  output: a.output + b.output,
});

/** `overflow` is a request too long for the model's context window; `transport` is any other failed call. */
export const TURN_ERROR_KINDS = ['refusal', 'transport', 'overflow', 'abort', 'max-turns', 'budget'] as const;
export type TurnErrorKind = (typeof TURN_ERROR_KINDS)[number];

export type AssistantTurn = {
  readonly content: readonly ContentBlock[];
  readonly stopReason: StopReason | null;
  readonly usage: TokenUsage;
  readonly costUsd: number | null;
  readonly latencyMs: number;
  readonly model: string;
};

export type TurnResult =
  | { readonly kind: 'answer'; readonly turn: AssistantTurn }
  | { readonly kind: 'error'; readonly error: TurnErrorKind; readonly message: string };

/** `denied` is a command the user, or the non-interactive policy, refused to run. */
export const TOOL_STATUSES = ['ok', 'error', 'denied'] as const;
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
  /** `context` is absent in logs written before sessions loaded any. */
  | { readonly kind: 'session-start'; readonly session: Session; readonly context?: LoadedContext | undefined }
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
    }
  | ({ readonly kind: 'assistant'; readonly seq: number; readonly at: string } & AssistantTurn)
  | {
      readonly kind: 'error';
      readonly seq: number;
      readonly at: string;
      readonly error: TurnErrorKind;
      readonly message: string;
    }
  | { readonly kind: 'review'; readonly seq: number; readonly at: string; readonly hunk: HunkId; readonly status: HunkStatus }
  | ({ readonly kind: 'retry'; readonly seq: number; readonly at: string } & ModelRetry)
  /** The user switched the session's approval mode; it holds until the next switch, across resumes. */
  | { readonly kind: 'mode'; readonly seq: number; readonly at: string; readonly mode: SessionMode }
  /** A name the user gave the session; the latest one wins over the first prompt. */
  | { readonly kind: 'title'; readonly seq: number; readonly at: string; readonly title: string }
  | ToolResultEvent;

export type TurnEventKind = TurnEvent['kind'];

/** Checkpoints, restores, review decisions, retries and titles record what happened around the conversation; the loop steps over them. */
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
  title: false,
};

export const restoredNotice = (event: Extract<TurnEvent, { kind: 'restored' }>): string =>
  `[The user rewound the workspace to how it was before turn ${event.turnSeq}. ${
    event.files.length === 0 ? 'No files changed.' : `These files were restored: ${event.files.join(', ')}.`
  } Read a file again before editing it.]`;

export const sessionModeOf = (events: readonly TurnEvent[]): SessionMode =>
  events.findLast((e) => e.kind === 'mode')?.mode ?? DEFAULT_SESSION_MODE;

export const nextSeq = (events: readonly TurnEvent[]): number => {
  const last = events.at(-1);
  return last === undefined || last.kind === 'session-start' ? 1 : last.seq + 1;
};

// A refused prompt is dropped so later turns do not resend it; an interrupted or stopped one is answered on the next run.
export const KEEPS_PENDING_PROMPT: Record<TurnErrorKind, boolean> = {
  refusal: false,
  transport: true,
  overflow: true,
  abort: true,
  'max-turns': true,
  budget: true,
};

export const toolUsesOf = (content: readonly ContentBlock[]): ToolUseBlock[] =>
  content.filter((block): block is ToolUseBlock => block.type === 'tool_use');

export const toolResultText = (event: ToolResultEvent): string =>
  'spill' in event ? spillNotice(event.spill) : event.output;

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

/** Images first, which the model reads best before the text about them; then the prompt; then mentions and attached files. */
function userBlocks(event: Extract<TurnEvent, { kind: 'user' }>, stored: StoredAttachments, workspace: string): (TextBlockParam | ImageBlockParam)[] {
  const attachments = event.attachments ?? [];
  const images = attachments.flatMap((a) => (a.kind === 'image' ? [imageBlock(a, stored)] : []));
  const items = [...(event.context ?? []), ...attachments.flatMap((a) => (a.kind === 'file' ? [fileItem(a, stored, shownPath(a, workspace))] : []))];
  return [
    ...images,
    // A message of attachments alone has no prompt text, and the API refuses an empty text block.
    ...(event.content === '' ? [] : [{ type: 'text' as const, text: event.content }]),
    ...(items.length === 0 ? [] : [{ type: 'text' as const, text: renderContextItems(items) }]),
  ];
}

/**
 * The conversation to send next. Everything after an assistant turn becomes one user message: its tool
 * results in the order the model asked for them, then any unanswered prompts. The session's loaded context opens
 * the first user message, after the system prompt, so it is cached with the prefix but never part of it.
 * `stored` holds the bytes of the attachments the events reference; one it lacks is replaced by a note.
 */
export function replayMessages(events: readonly TurnEvent[], stored: StoredAttachments = NO_ATTACHMENTS): MessageParam[] {
  const messages: MessageParam[] = [];
  let toolUses: readonly ToolUseBlock[] = [];
  let results = new Map<string, ToolResultBlockParam>();
  let prompts: (TextBlockParam | ImageBlockParam)[] = [];
  let workspace = '';
  // Kept apart from the prompts, so a refused first prompt does not take the loaded context with it.
  let opening: TextBlockParam[] = [];
  const flush = () => {
    const content = [...toolUses.flatMap((use) => results.get(use.id) ?? []), ...prompts];
    if (content.length > 0) {
      messages.push({ role: 'user', content: [...opening, ...content] });
      opening = [];
    }
    toolUses = [];
    results = new Map();
    prompts = [];
  };
  for (const event of events) {
    if (event.kind === 'session-start') {
      workspace = event.session.workspace;
      const loaded = event.context === undefined ? undefined : renderLoadedContext(event.context);
      if (loaded !== undefined) opening = [{ type: 'text', text: loaded }];
    }
    if (event.kind === 'user') prompts.push(...userBlocks(event, stored, workspace));
    if (event.kind === 'restored') prompts.push({ type: 'text', text: restoredNotice(event) });
    if (event.kind === 'error' && !KEEPS_PENDING_PROMPT[event.error]) prompts = [];
    if (event.kind === 'tool-result') results.set(event.toolUseId, toolResultBlock(event, stored));
    if (event.kind === 'assistant') {
      flush();
      // Response blocks go back verbatim: thinking signatures are verified against the exact bytes.
      messages.push({ role: 'assistant', content: [...event.content] });
      toolUses = toolUsesOf(event.content);
    }
  }
  flush();
  return messages;
}

export const hasPendingPrompt = (events: readonly TurnEvent[]): boolean =>
  replayMessages(events).at(-1)?.role === 'user';
