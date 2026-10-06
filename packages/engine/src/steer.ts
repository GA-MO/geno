import * as acp from '@agentclientprotocol/sdk';
import type { SessionId, Steer, SteerOutcome } from '@g-code/core';
import { Inbox } from './inbox.js';

/**
 * One running session's door for steers, from its run's start to its end. The steers wait in the engine's `Inbox`,
 * beside the session's other arrivals, for the run's safe point. `parentId` names the session that started it, for a
 * child. A background child of this session owes its report until it has pushed it.
 */
export class SteerInbox {
  private open = true;
  private owing = 0;
  private wake: (() => void) | undefined;

  constructor(
    private readonly inbox: Inbox,
    readonly sessionId: string,
    readonly parentId: SessionId | undefined,
  ) {}

  /** Queues a steer until the run takes it; undefined once the run ended. */
  push(steer: Steer): Promise<SteerOutcome> | undefined {
    if (!this.open) return undefined;
    const outcome = new Promise<SteerOutcome>((settle) => this.inbox.put(this.sessionId, { kind: 'steer', steer, settle }));
    this.wake?.();
    return outcome;
  }

  queued(): readonly Steer[] {
    return this.inbox.steers(this.sessionId);
  }

  get owed(): number {
    return this.owing;
  }

  /** A background child will push its report later; the returned release, called once it has, ends the debt. */
  owe(): () => void {
    this.owing++;
    let paid = false;
    return () => {
      if (paid) return;
      paid = true;
      this.owing--;
      this.wake?.();
    };
  }

  /** Settles once a steer is queued or a debt is paid, or on abort. */
  async arrival(signal: AbortSignal): Promise<void> {
    if (this.queued().length > 0 || signal.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        this.wake = undefined;
        signal.removeEventListener('abort', done);
        resolve();
      };
      this.wake = done;
      signal.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * The run ended: nothing more is queued, and what still is goes to the next turn. Safe to call again: the session's
   * queue may hold a newer run's steers by then.
   */
  close(): void {
    if (!this.open) return;
    this.open = false;
    for (const { settle } of this.inbox.takeSteers(this.sessionId)) settle({ kind: 'next-turn' });
  }
}

/** Every running session's steer door in the engine process, children's included, by session id, over one `Inbox`. */
export class Steers {
  private readonly inboxes = new Map<string, SteerInbox>();
  // Children whose run ended, so a late steer to one is told so rather than treated as an unknown session.
  private readonly endedChildren = new Set<string>();

  constructor(readonly inbox: Inbox = new Inbox()) {}

  open(sessionId: string, parentId: SessionId | undefined): SteerInbox {
    this.inboxes.get(sessionId)?.close();
    const inbox = new SteerInbox(this.inbox, sessionId, parentId);
    this.inboxes.set(sessionId, inbox);
    return inbox;
  }

  of(sessionId: string): SteerInbox | undefined {
    return this.inboxes.get(sessionId);
  }

  /** Closes the run's inbox, if it is still the session's, so that nothing waits on a run that is gone. */
  release(sessionId: string, inbox: SteerInbox): void {
    inbox.close();
    if (inbox.parentId !== undefined) this.endedChildren.add(sessionId);
    if (this.inboxes.get(sessionId) === inbox) this.inboxes.delete(sessionId);
  }

  isEndedChild(sessionId: string): boolean {
    return this.endedChildren.has(sessionId) && !this.inboxes.has(sessionId);
  }
}

/**
 * The user's steer over ACP, for the session's running turn: delivered there, or `next-turn` when no turn takes it,
 * which the caller then runs as a prompt once the turn ends. A steer is text only. A child that finished has no next
 * turn, so a steer for it is refused.
 */
export async function steerRunning(steers: Steers, sessionId: string, blocks: readonly acp.ContentBlock[]): Promise<SteerOutcome> {
  if (blocks.some((block) => block.type !== 'text')) throw acp.RequestError.invalidParams({ sessionId }, 'a steer is text only; queue attachments and mentions for the next turn');
  const text = blocks.map((block) => (block.type === 'text' ? block.text : '')).join('').trim();
  if (text === '') throw acp.RequestError.invalidParams({ sessionId }, 'the steer has no text');
  const inbox = steers.of(sessionId);
  const outcome = (await inbox?.push({ text, from: 'user' })) ?? { kind: 'next-turn' };
  if (outcome.kind === 'next-turn' && (inbox?.parentId !== undefined || steers.isEndedChild(sessionId))) throw acp.RequestError.invalidRequest({ sessionId }, 'the subagent already finished');
  return outcome;
}
