import type {
  ContentBlock,
  MessageParam,
  StopReason,
  TextBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages/messages';
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

export const TOOL_STATUSES = ['ok', 'error'] as const;
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
} & ToolOutput;

export type TurnEvent =
  | { readonly kind: 'session-start'; readonly session: Session }
  | { readonly kind: 'user'; readonly seq: number; readonly at: string; readonly content: string }
  | ({ readonly kind: 'assistant'; readonly seq: number; readonly at: string } & AssistantTurn)
  | {
      readonly kind: 'error';
      readonly seq: number;
      readonly at: string;
      readonly error: TurnErrorKind;
      readonly message: string;
    }
  | ToolResultEvent;

export type TurnEventKind = TurnEvent['kind'];

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
  ...(event.status === 'error' ? { is_error: true } : {}),
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
