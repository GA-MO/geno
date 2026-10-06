import { z } from 'zod';
import { DEFAULT_RESUME_AFTER_LIMIT, isResumeAfterLimit, WAIT_POLICY, type ResumeAfterLimit, type WaitPolicy } from '@g-code/core';
import { EngineError } from './errors.js';

type Env = Readonly<Record<string, string | undefined>>;

/** Retry now: wakes every call of the session that waits, once. */
export class Wake {
  private readonly sleepers = new Set<() => void>();

  /** Settles at the next wake. */
  next(): { readonly woken: Promise<void>; readonly cancel: () => void } {
    let wake: () => void = () => {};
    const woken = new Promise<void>((resolve) => (wake = resolve));
    this.sleepers.add(wake);
    return { woken, cancel: () => this.sleepers.delete(wake) };
  }

  /** Whether anything was asleep to wake. */
  wake(): boolean {
    const any = this.sleepers.size > 0;
    for (const wake of this.sleepers) wake();
    this.sleepers.clear();
    return any;
  }
}

export type Nap = 'slept' | 'woken' | 'aborted';

/** Sleeps `ms`, forever for Infinity, until the time passes, `wake` wakes it, or `signal` aborts. */
export function nap(ms: number, signal: AbortSignal, wake: Wake | undefined): Promise<Nap> {
  if (signal.aborted) return Promise.resolve('aborted');
  return new Promise((resolve) => {
    const woken = wake?.next();
    const timer = Number.isFinite(ms) ? setTimeout(() => done('slept'), Math.max(0, ms)) : undefined;
    const aborted = () => done('aborted');
    signal.addEventListener('abort', aborted, { once: true });
    void woken?.woken.then(() => done('woken'));
    function done(how: Nap) {
      clearTimeout(timer);
      woken?.cancel();
      signal.removeEventListener('abort', aborted);
      resolve(how);
    }
  });
}

const ms = (fallback: number) => z.number().nonnegative().default(fallback);
const { offline, limited } = WAIT_POLICY;
const policySchema = z.strictObject({
  offline: z.strictObject({ firstMs: ms(offline.firstMs), maxMs: ms(offline.maxMs), giveUpMs: ms(offline.giveUpMs) }).default(offline),
  limited: z
    .strictObject({ firstMs: ms(limited.firstMs), maxMs: ms(limited.maxMs), giveUpMs: ms(limited.giveUpMs), jitterMs: ms(limited.jitterMs), autoMaxMs: ms(limited.autoMaxMs) })
    .default(limited),
});

/** WAIT_POLICY, with any of its numbers replaced from the GCODE_WAIT_POLICY JSON, which the tests use to wait in milliseconds. */
export function waitPolicyOf(env: Env): WaitPolicy {
  const raw = env['GCODE_WAIT_POLICY'];
  if (raw === undefined || raw === '') return WAIT_POLICY;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new EngineError('GCODE_WAIT_POLICY is not JSON');
  }
  const parsed = policySchema.safeParse(json);
  if (!parsed.success) throw new EngineError(`GCODE_WAIT_POLICY: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** The `gcode.resume.afterLimit` setting, as the extension passes it in GCODE_RESUME_AFTER_LIMIT. */
export function resumeAfterLimitOf(env: Env): ResumeAfterLimit {
  const raw = env['GCODE_RESUME_AFTER_LIMIT'];
  if (raw === undefined || raw === '') return DEFAULT_RESUME_AFTER_LIMIT;
  if (!isResumeAfterLimit(raw)) throw new EngineError(`GCODE_RESUME_AFTER_LIMIT must be short, always or off, not ${raw}`);
  return raw;
}
