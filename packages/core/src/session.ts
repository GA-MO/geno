import type {
  ContentBlock,
  MessageParam,
  StopReason,
  TextBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type { HunkStatus } from './hunks.js';
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

export const TURN_ERROR_KINDS = ['refusal', 'transport', 'abort', 'max-turns', 'budget'] as const;
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
  | { readonly kind: 'session-start'; readonly session: Session }
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
  | { readonly kind: 'user'; readonly seq: number; readonly at: string; readonly content: string }
  | ({ readonly kind: 'assistant'; readonly seq: number; readonly at: string } & AssistantTurn)
  | {
      readonly kind: 'error';
      readonly seq: number;
      readonly at: string;
      readonly error: TurnErrorKind;
      readonly message: string;
    }
  | { readonly kind: 'review'; readonly seq: number; readonly at: string; readonly hunk: HunkId; readonly status: HunkStatus }
  | ToolResultEvent;

export type TurnEventKind = TurnEvent['kind'];

/** Checkpoints, restores and review decisions record what happened to the workspace; the loop steps over them. */
export const IN_CONVERSATION: Readonly<Record<TurnEventKind, boolean>> = {
  'session-start': true,
  user: true,
  assistant: true,
  error: true,
  'tool-result': true,
  checkpoint: false,
  restored: false,
  review: false,
};

export const restoredNotice = (event: Extract<TurnEvent, { kind: 'restored' }>): string =>
  `[The user rewound the workspace to how it was before turn ${event.turnSeq}. ${
    event.files.length === 0 ? 'No files changed.' : `These files were restored: ${event.files.join(', ')}.`
  } Read a file again before editing it.]`;

export const nextSeq = (events: readonly TurnEvent[]): number => {
  const last = events.at(-1);
  return last === undefined || last.kind === 'session-start' ? 1 : last.seq + 1;
};

// A refused prompt is dropped so later turns do not resend it; an interrupted or stopped one is answered on the next run.
export const KEEPS_PENDING_PROMPT: Record<TurnErrorKind, boolean> = {
  refusal: false,
  transport: true,
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

/**
 * The conversation to send next. Everything after an assistant turn becomes one user message: its tool
 * results in the order the model asked for them, then any unanswered prompts.
 */
export function replayMessages(events: readonly TurnEvent[]): MessageParam[] {
  const messages: MessageParam[] = [];
  let toolUses: readonly ToolUseBlock[] = [];
  let results = new Map<string, ToolResultBlockParam>();
  let prompts: TextBlockParam[] = [];
  const flush = () => {
    const content = [...toolUses.flatMap((use) => results.get(use.id) ?? []), ...prompts];
    if (content.length > 0) messages.push({ role: 'user', content });
    toolUses = [];
    results = new Map();
    prompts = [];
  };
  for (const event of events) {
    if (event.kind === 'user') prompts.push({ type: 'text', text: event.content });
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
