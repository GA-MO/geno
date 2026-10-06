import { setTimeout as sleep } from 'node:timers/promises';
import type { ProviderName } from '@g-code/core';

/**
 * The shared limit on model calls. Every gateway of one provider in the engine process takes a slot for each call,
 * so n lanes, their children and a review together hold at most `size` streams open. A rate-limit answer pauses
 * every call that has not started yet, not just the one that got it, so the lanes back off together.
 */
export type ModelSlots = {
  /** Runs `work` once a slot is free and no pause holds the calls; rejects with the signal's reason if it aborts first. */
  run<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T>;
  /** Holds every call not yet started for `ms`; a longer pause already in place stays. */
  pause(ms: number): void;
  stats(): SlotStats;
};

/** What the limiter did, for its measurement: the most calls at once, how many waited, and for how long in all. */
export type SlotStats = {
  readonly size: number;
  readonly calls: number;
  readonly peak: number;
  readonly waited: number;
  readonly waitMs: number;
  readonly pauses: number;
};

/** Four lanes at one call each, the most an arena runs. */
export const DEFAULT_MODEL_CONCURRENCY = 4;
export const CONCURRENCY_ENV = 'GCODE_MODEL_CONCURRENCY';

export function modelSlots(size: number): ModelSlots {
  let busy = 0;
  let pausedUntil = 0;
  const waiting: (() => void)[] = [];
  const stats = { size, calls: 0, peak: 0, waited: 0, waitMs: 0, pauses: 0 };
  const wake = () => {
    while (busy < size && waiting.length > 0) {
      busy++;
      waiting.shift()!();
    }
  };
  const acquire = async (signal: AbortSignal) => {
    if (busy < size && waiting.length === 0) {
      busy++;
      return;
    }
    stats.waited++;
    await new Promise<void>((resolve, reject) => {
      const go = () => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        const at = waiting.indexOf(go);
        if (at !== -1) waiting.splice(at, 1);
        reject(signal.reason);
      };
      waiting.push(go);
      signal.addEventListener('abort', abort, { once: true });
    });
  };
  return {
    async run(work, signal) {
      signal.throwIfAborted();
      const asked = performance.now();
      await acquire(signal);
      try {
        // A pause set while this call waited still holds it; the slot stays taken, so nothing jumps ahead.
        for (let left = pausedUntil - Date.now(); left > 0; left = pausedUntil - Date.now()) await sleep(left, undefined, { signal });
        stats.waitMs += performance.now() - asked;
        stats.calls++;
        stats.peak = Math.max(stats.peak, busy);
        return await work();
      } finally {
        busy--;
        wake();
      }
    },
    pause(ms) {
      stats.pauses++;
      pausedUntil = Math.max(pausedUntil, Date.now() + ms);
    },
    stats: () => ({ ...stats, waitMs: Math.round(stats.waitMs) }),
  };
}

const shared = new Map<ProviderName, ModelSlots>();

/** The process's slots for `provider`, sized by `GCODE_MODEL_CONCURRENCY` the first time a gateway asks. */
export function sharedSlots(provider: ProviderName, env: Readonly<Record<string, string | undefined>>): ModelSlots {
  let slots = shared.get(provider);
  if (slots === undefined) {
    const raw = Number(env[CONCURRENCY_ENV]);
    slots = modelSlots(Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MODEL_CONCURRENCY);
    shared.set(provider, slots);
  }
  return slots;
}
