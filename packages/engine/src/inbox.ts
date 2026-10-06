import type { TurnEvent } from '@g-code/core';
import type { JobEnd } from './background.js';

/**
 * What reaches a session from outside its turn's own loop, logged at the turn's next safe point: after the tool batch
 * that runs, before the next model call. A background command's end is one. U44's steering message is meant to be
 * another member of this union, delivered through the same `take` in drive.ts.
 */
export type Arrival = JobEnd;

/** An arrival as the session log numbers it. */
export const loggedArrival = (arrival: Arrival, seq: number): TurnEvent => ({ ...arrival, seq });

/**
 * Arrivals per session, until a running turn takes them at its safe point or, while no turn runs, the engine logs them
 * at once. `arrived` runs after each `put`, for whatever logs them while the session is idle.
 */
export class Inbox {
  private readonly pending = new Map<string, Arrival[]>();
  arrived: (sessionId: string) => void = () => {};

  put(sessionId: string, arrival: Arrival): void {
    const queue = this.pending.get(sessionId) ?? this.pending.set(sessionId, []).get(sessionId)!;
    queue.push(arrival);
    this.arrived(sessionId);
  }

  /** Everything the session has waiting, in the order it came, and empties its queue. */
  take(sessionId: string): Arrival[] {
    const queue = this.pending.get(sessionId) ?? [];
    this.pending.delete(sessionId);
    return queue;
  }
}
