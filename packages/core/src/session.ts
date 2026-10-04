import type {
  ContentBlock,
  ContentBlockParam,
  MessageParam,
  StopReason,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type { Brand } from './types.js';

export type SessionId = Brand<string, 'SessionId'>;
export const asSessionId = (raw: string): SessionId => raw as SessionId;

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
export const isEffort = (raw: string): raw is Effort => (EFFORTS as readonly string[]).includes(raw);

export type Session = {
  readonly id: SessionId;
  readonly createdAt: string;
  readonly workspace: string;
  readonly model: string;
  readonly effort: Effort;
};

export type TokenUsage = {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
};

export const TURN_ERROR_KINDS = ['refusal', 'transport', 'abort'] as const;
export type TurnErrorKind = (typeof TURN_ERROR_KINDS)[number];

export type AssistantTurn = {
  readonly content: readonly ContentBlock[];
  readonly stopReason: StopReason | null;
  readonly usage: TokenUsage;
  readonly costUsd: number | null;
  readonly latencyMs: number;
  readonly model: string;
};

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
    };

export type TurnEventKind = TurnEvent['kind'];

export const nextSeq = (events: readonly TurnEvent[]): number => {
  const last = events.at(-1);
  return last === undefined || last.kind === 'session-start' ? 1 : last.seq + 1;
};

// A refused prompt is dropped so later turns do not resend it; an interrupted one is answered on the next run.
const KEEPS_PENDING_PROMPT: Record<TurnErrorKind, boolean> = {
  refusal: false,
  transport: true,
  abort: true,
};

/** The conversation to send next. Consecutive unanswered user events merge into one user message. */
export function replayMessages(events: readonly TurnEvent[]): MessageParam[] {
  const messages: MessageParam[] = [];
  let pending: TextBlockParam[] = [];
  const flush = () => {
    if (pending.length > 0) messages.push({ role: 'user', content: pending });
    pending = [];
  };
  for (const event of events) {
    if (event.kind === 'user') pending.push({ type: 'text', text: event.content });
    if (event.kind === 'error' && !KEEPS_PENDING_PROMPT[event.error]) pending = [];
    if (event.kind === 'assistant') {
      flush();
      // Response blocks go back verbatim: thinking signatures are verified against the exact bytes.
      messages.push({ role: 'assistant', content: event.content as ContentBlockParam[] });
    }
  }
  flush();
  return messages;
}

export const hasPendingPrompt = (events: readonly TurnEvent[]): boolean =>
  replayMessages(events).at(-1)?.role === 'user';
