import * as acp from '@agentclientprotocol/sdk';
import { NOT_SHOWN_ERROR } from '@g-code/core';

/** One editor connection: how to reach it, what it can show, and when it went away. */
export type Viewer<P> = { readonly client: acp.AgentContext; readonly peer: P; readonly closed: AbortSignal };

/** One editor showing one session. While `held`, its updates wait, so a replay of what came before reaches it first. */
type Showing<P> = { readonly viewer: Viewer<P>; held: (() => void)[] | undefined };

/**
 * Which editor shows each session. A turn outlives the editor that started it: its updates go to whichever editor
 * shows the session now and are dropped while none does, since the log keeps them for a later load. A question
 * waits for an editor that shows the session, and goes to the next one if that editor goes away before it answers.
 */
export class Viewers<P> {
  private readonly showing = new Map<string, Showing<P>>();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly err: (line: string) => void) {}

  /**
   * `viewer` shows the session from now on, in place of any other. With `held`, its updates wait until the returned
   * release, which sends them in order and only then lets questions through.
   */
  show(sessionId: string, viewer: Viewer<P>, held = false): () => void {
    const showing: Showing<P> = { viewer, held: held ? [] : undefined };
    this.showing.set(sessionId, showing);
    const release = () => {
      const queued = showing.held ?? [];
      showing.held = undefined;
      for (const send of queued) send();
      this.wake(sessionId);
    };
    if (!held) release();
    return release;
  }

  /** The session goes back to the background, if `viewer` (or, without one, anyone) shows it. */
  hide(sessionId: string, viewer?: Viewer<P>): void {
    const showing = this.showing.get(sessionId);
    if (showing !== undefined && (viewer === undefined || showing.viewer === viewer)) this.showing.delete(sessionId);
  }

  /** The editor showing the session now, once any replay it waits on is out. */
  of(sessionId: string): Viewer<P> | undefined {
    const showing = this.showing.get(sessionId);
    return showing === undefined || showing.held !== undefined ? undefined : showing.viewer;
  }

  /** Every session `viewer` shows. */
  shownBy(viewer: Viewer<P>): string[] {
    return [...this.showing].flatMap(([id, showing]) => (showing.viewer === viewer ? [id] : []));
  }

  isShown(sessionId: string): boolean {
    return this.showing.has(sessionId);
  }

  /** Sends to the editor showing `sessionId`; with none, it is dropped. Calls reach the wire in the order made. */
  notify(sessionId: string, method: string, params: unknown): void {
    const showing = this.showing.get(sessionId);
    if (showing === undefined) return;
    const send = () => void showing.viewer.client.notify(method, params).catch((error: unknown) => this.err(`${method} failed: ${String(error)}`));
    if (showing.held === undefined) send();
    else showing.held.push(send);
  }

  /**
   * Asks the editor that shows the session, waiting for one while none does. An editor that answers with an error, other than that it no longer shows the session, has
   * answered; one whose connection fails instead is hidden, and the question goes to the next editor that shows it.
   */
  async ask<T>(sessionId: string, signal: AbortSignal | undefined, request: (viewer: Viewer<P>) => Promise<T>): Promise<T> {
    for (;;) {
      const viewer = await this.next(sessionId, signal);
      try {
        return await request(viewer);
      } catch (error) {
        const answered = error instanceof acp.RequestError && error.code !== NOT_SHOWN_ERROR.code;
        if (answered || signal?.aborted) throw error;
        this.hide(sessionId, viewer);
      }
    }
  }

  private next(sessionId: string, signal: AbortSignal | undefined): Promise<Viewer<P>> {
    return new Promise((resolve, reject) => {
      const attempt = () => {
        const viewer = this.of(sessionId);
        if (viewer === undefined || viewer.closed.aborted) return false;
        cleanup();
        resolve(viewer);
        return true;
      };
      const aborted = () => {
        cleanup();
        reject(signal?.reason ?? new Error('aborted'));
      };
      const cleanup = () => {
        this.waiters.get(sessionId)?.delete(wake);
        signal?.removeEventListener('abort', aborted);
      };
      const wake = () => void attempt();
      if (signal?.aborted) return aborted();
      if (attempt()) return;
      const set = this.waiters.get(sessionId) ?? this.waiters.set(sessionId, new Set()).get(sessionId)!;
      set.add(wake);
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }

  private wake(sessionId: string): void {
    for (const wake of [...(this.waiters.get(sessionId) ?? [])]) wake();
  }
}
