import * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import { STEER_META, type SteerSource } from '@g-code/core';
import type { Connection } from './engine.js';
import type { Action } from './messages.js';
import type { SteerFromView, SteerResult, SteerShown, SteerTarget, SteerToView } from './steer-model.js';

const steerMark = z.object({ seq: z.number().int(), from: z.enum(['user', 'parent', 'child']) });
const steerOutcome = z.discriminatedUnion('kind', [z.object({ kind: z.literal('delivered'), seq: z.number().int() }), z.object({ kind: z.literal('next-turn') })]);

// The fences core's parentMessage and childReport put around a steer that is not the user's own.
const PARENT_FENCE = /^<parent_message>\n([\s\S]*?)\n<\/parent_message>/;
const REPORT_AGENT = /^<subagent_report agent="([^"]*)"/;

const SHOWN: { readonly [K in SteerSource]: (text: string) => SteerShown } = {
  user: (text) => ({ from: 'user', text }),
  parent: (text) => ({ from: 'parent', text: PARENT_FENCE.exec(text)?.[1] ?? text }),
  child: (text) => ({ from: 'child', agent: REPORT_AGENT.exec(text)?.[1] }),
};

/** A user message chunk the engine marked as a steer, live or replayed; any other update is not one. */
export function steerActionOf(update: acp.SessionUpdate): Extract<Action, { type: 'steer' }> | undefined {
  if (update.sessionUpdate !== 'user_message_chunk' || update.content.type !== 'text') return undefined;
  const mark = steerMark.safeParse(update._meta?.[STEER_META]);
  if (!mark.success) return undefined;
  return { type: 'steer', seq: mark.data.seq, shown: SHOWN[mark.data.from](update.content.text) };
}

/** A steer request's answer: delivered into the running turn, or the end of the next turn it ran as. */
export const steerResultOf = (response: acp.PromptResponse): SteerResult => {
  const outcome = steerOutcome.safeParse(response._meta?.[STEER_META]);
  return outcome.success && outcome.data.kind === 'delivered' ? { kind: 'delivered' } : { kind: 'next-turn' };
};

const failed = (error: unknown): SteerResult => ({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });

const steerRequest = (connection: Connection, sessionId: string, text: string): Promise<acp.PromptResponse> =>
  connection.agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }], _meta: { [STEER_META]: true } });

/** The running turn a steer goes to, as the chat holds it. */
export type SteerLink = { readonly connection: Connection; readonly sessionId: string };

/** What steering needs of the chat. */
export type SteerChat = {
  readonly running: () => SteerLink | undefined;
  readonly connection: () => Promise<Connection>;
  /** No turn runs after all: the text goes as an ordinary prompt. */
  readonly send: (text: string) => Promise<unknown>;
  /** Shows a steer the turn ended without taking as the next turn, which `response`, the steer's own, ends. */
  readonly adopt: (text: string, response: Promise<acp.PromptResponse>) => Promise<unknown>;
  readonly post: (message: SteerToView) => void;
};

/** The chat's steer on its way: sent while `link`'s turn ran, settled once, by its answer or by that turn's end. */
type Pending = { readonly link: SteerLink; readonly text: string; readonly response: Promise<acp.PromptResponse>; settled: boolean };

/**
 * Sends steers and tells the panel how each went. The chat's own follow-up has one more way to go: when its turn
 * ends first, the engine runs it as the next turn, and the panel shows that turn with the steer as its prompt.
 */
export class SteerHost {
  private pending: Pending | undefined;

  constructor(private readonly chat: SteerChat) {}

  readonly handlers: { readonly [K in SteerFromView['type']]: (message: Extract<SteerFromView, { type: K }>) => void } = {
    steer: ({ target, text }) => (target.kind === 'chat' ? this.steerChat(text) : void this.steerSession(target, text)),
  };

  /** The turn `link` ran ended. A steer it did not take is now the next turn, so it shows as one. */
  turnEnded(link: SteerLink): void {
    const pending = this.pending;
    if (pending === undefined || pending.link !== link || pending.settled) return;
    this.settle(pending, { kind: 'next-turn' });
    void this.chat.adopt(pending.text, pending.response).catch(() => {});
  }

  private steerChat(text: string): void {
    const link = this.chat.running();
    if (link === undefined) {
      this.chat.post({ type: 'steered', target: { kind: 'chat' }, result: { kind: 'next-turn' } });
      void this.chat.send(text).catch(() => {});
      return;
    }
    const pending: Pending = { link, text, response: steerRequest(link.connection, link.sessionId, text), settled: false };
    this.pending = pending;
    pending.response.then(
      (response) => {
        if (steerResultOf(response).kind === 'delivered') this.settle(pending, { kind: 'delivered' });
      },
      (error: unknown) => this.settle(pending, failed(error)),
    );
  }

  private settle(pending: Pending, result: SteerResult): void {
    if (pending.settled) return;
    pending.settled = true;
    if (this.pending === pending) this.pending = undefined;
    this.chat.post({ type: 'steered', target: { kind: 'chat' }, result });
  }

  /** A subagent or a task: its session id takes the steer, and the answer says how it went. */
  private async steerSession(target: Exclude<SteerTarget, { kind: 'chat' }>, text: string): Promise<void> {
    const sessionId = target.kind === 'child' ? target.id : target.sessionId;
    const result = await this.chat
      .connection()
      .then((connection) => steerRequest(connection, sessionId, text))
      .then(steerResultOf, failed);
    this.chat.post({ type: 'steered', target, result });
  }
}
