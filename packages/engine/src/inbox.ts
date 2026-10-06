import { steerEvent, type Steer, type SteerOutcome, type TurnEvent } from '@g-code/core';
import type { JobEnd } from './background.js';

/** A steer for the session's running run, settled with the seq the run logged it at, or `next-turn` if the run ended first. */
export type SteerArrival = { readonly kind: 'steer'; readonly steer: Steer; readonly settle: (outcome: SteerOutcome) => void };

/**
 * What reaches a session from outside its turn's own loop, logged at the turn's next safe point: after the tool batch
 * that runs, before the next model call. drive.ts takes every kind at that one point.
 */
export type Arrival = JobEnd | SteerArrival;

/** An arrival as the session log numbers it. */
export const loggedArrival = (arrival: Arrival, seq: number): Extract<TurnEvent, { kind: 'user' | 'background-end' }> =>
  arrival.kind === 'steer' ? steerEvent(arrival.steer, seq, new Date().toISOString()) : { ...arrival, seq };

/**
 * Whether the engine logs an arrival while no turn runs. A background end joins the next prompt. A steer does not: one
 * its run missed is settled `next-turn`, and the caller runs it as a prompt of its own.
 */
const LOGGED_WHILE_IDLE: { readonly [K in Arrival['kind']]: boolean } = { 'background-end': true, steer: false };

const isSteer = (arrival: Arrival): arrival is SteerArrival => arrival.kind === 'steer';

/**
 * Arrivals per session, in the order they came, until a running turn takes them at its safe point. `arrived` runs
 * after each `put` of a kind logged while idle, for whatever logs it if no turn takes it.
 */
export class Inbox {
  private readonly pending = new Map<string, Arrival[]>();
  arrived: (sessionId: string) => void = () => {};

  put(sessionId: string, arrival: Arrival): void {
    const queue = this.pending.get(sessionId) ?? this.pending.set(sessionId, []).get(sessionId)!;
    queue.push(arrival);
    if (LOGGED_WHILE_IDLE[arrival.kind]) this.arrived(sessionId);
  }

  /** Everything the session has waiting, for its run's safe point, and empties its queue. */
  take(sessionId: string): Arrival[] {
    const queue = this.pending.get(sessionId) ?? [];
    this.pending.delete(sessionId);
    return queue;
  }

  /** What may be logged while no turn runs; steers stay for their run to take or to send to the next turn. */
  takeIdle(sessionId: string): Arrival[] {
    return this.takeWhere(sessionId, (arrival) => LOGGED_WHILE_IDLE[arrival.kind]);
  }

  /** The session's steers, which its run's end sends to the next turn. */
  takeSteers(sessionId: string): SteerArrival[] {
    return this.takeWhere(sessionId, isSteer);
  }

  /** The steers waiting for the session's run, oldest first. */
  steers(sessionId: string): readonly Steer[] {
    return (this.pending.get(sessionId) ?? []).filter(isSteer).map((arrival) => arrival.steer);
  }

  private takeWhere<A extends Arrival>(sessionId: string, which: (arrival: Arrival) => arrival is A): A[];
  private takeWhere(sessionId: string, which: (arrival: Arrival) => boolean): Arrival[];
  private takeWhere(sessionId: string, which: (arrival: Arrival) => boolean): Arrival[] {
    const queue = this.pending.get(sessionId) ?? [];
    const taken = queue.filter(which);
    const left = queue.filter((arrival) => !which(arrival));
    if (left.length === 0) this.pending.delete(sessionId);
    else this.pending.set(sessionId, left);
    return taken;
  }
}
