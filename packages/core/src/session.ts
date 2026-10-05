import type {
  ContentBlock,
  MessageParam,
  StopReason,
  TextBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages/messages';
import { DEFAULT_SESSION_MODE, type SessionMode } from './approval.js';
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
  | ToolResultEvent;

export type TurnEventKind = TurnEvent['kind'];

/** Checkpoints, restores, review decisions and retries record what happened around the conversation; the loop steps over them. */
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

const toolResultBlock = (event: ToolResultEvent): ToolResultBlockParam => ({
  type: 'tool_result',
  tool_use_id: event.toolUseId,
  content: toolResultText(event),
  ...(event.status === 'ok' ? {} : { is_error: true }),
});

const userBlocks = (event: Extract<TurnEvent, { kind: 'user' }>): TextBlockParam[] => [
  { type: 'text', text: event.content },
  ...(event.context === undefined || event.context.length === 0 ? [] : [{ type: 'text' as const, text: renderContextItems(event.context) }]),
];

/**
 * The conversation to send next. Everything after an assistant turn becomes one user message: its tool
 * results in the order the model asked for them, then any unanswered prompts. The session's loaded context opens
 * the first user message, after the system prompt, so it is cached with the prefix but never part of it.
 */
export function replayMessages(events: readonly TurnEvent[]): MessageParam[] {
  const messages: MessageParam[] = [];
  let toolUses: readonly ToolUseBlock[] = [];
  let results = new Map<string, ToolResultBlockParam>();
  let prompts: TextBlockParam[] = [];
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
      const loaded = event.context === undefined ? undefined : renderLoadedContext(event.context);
      if (loaded !== undefined) opening = [{ type: 'text', text: loaded }];
    }
    if (event.kind === 'user') prompts.push(...userBlocks(event));
    if (event.kind === 'restored') prompts.push({ type: 'text', text: restoredNotice(event) });
    if (event.kind === 'error' && !KEEPS_PENDING_PROMPT[event.error]) prompts = [];
    if (event.kind === 'tool-result') results.set(event.toolUseId, toolResultBlock(event));
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
