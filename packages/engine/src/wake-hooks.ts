import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { nextSeq, openSchedulesOf, unwokenOf, WAKE_POLICY, wakeGate, wakePauseOf, type Waiter, type WakeNote, type WakePolicy, type WakeView } from '@g-code/core';
import type { BackgroundJobs } from './background.js';
import { openSessionLog } from './chat.js';
import type { Io } from './command.js';
import type { Inbox } from './inbox.js';
import { appendEvent, dropTornTail, readSessionLog } from './sessions.js';
import { isMissing, type Store } from './store.js';
import type { Tasks } from './tasks.js';
import { pidAlive } from './wait-hooks.js';
import { Wakes } from './wakes.js';

/** One editor connection's way to run a woken turn of a session, as that editor's own turn. */
export type Waker = { readonly connection: object; run(sessionId: string): void };

export type WakeDeps = {
  readonly jobs: BackgroundJobs;
  readonly inbox: Inbox;
  readonly tasks: Tasks;
  /** Each known session's running turn, undefined while none runs. */
  readonly turns: ReadonlyMap<string, unknown>;
  /** The connection that shows a session, if any. */
  readonly shownBy: (sessionId: string) => object | undefined;
  /** Runs `work` after the session's other log writes, as serve's writers take turns. */
  readonly serially: <T>(sessionId: string, work: () => Promise<T>) => Promise<T>;
  /** `gcode.wake.auto`: off, nothing wakes a session and arrivals wait for the next prompt. */
  readonly autoWake: boolean;
  readonly policy: WakePolicy;
};

/**
 * The engine's side of waking sessions: what each one waits on, the drafts each editor reports, and the gate applied
 * after every change that could open it: an arrival logged, a turn ended, a draft cleared, a card answered.
 */
export class WakeDriver {
  readonly registry: Wakes;
  readonly wakers = new Set<Waker>();
  private store: { readonly store: Store; readonly io: Io } | undefined;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly drafts = new Map<string, Map<object, boolean>>();
  private readonly cleared = new Map<string, number>();
  private readonly paused = new Map<string, WakeView['paused']>();

  constructor(private readonly deps: WakeDeps) {
    this.registry = new Wakes(deps.jobs, {
      arrive: (sessionId, arrival) => deps.inbox.put(sessionId, arrival),
      changed: (sessionId) => this.soon(sessionId),
    });
  }

  get autoWake(): boolean {
    return this.deps.autoWake;
  }

  get policy(): WakePolicy {
    return this.deps.policy;
  }

  /** The store and the log of the first connection's engine; nothing is woken before one connects. */
  bind(store: Store, io: Io): void {
    this.store ??= { store, io };
  }

  /** What the session's task says about its wakes now; the paused reason is the gate's last. */
  view(sessionId: string): WakeView {
    const paused = this.paused.get(sessionId);
    return { waitsFor: this.registry.waitsFor(sessionId), ...(paused === undefined ? {} : { paused }) };
  }

  /** The composer of a session `connection` shows gained or lost a draft. */
  draft(sessionId: string, connection: object, typing: boolean): void {
    const drafts = this.drafts.get(sessionId) ?? this.drafts.set(sessionId, new Map()).get(sessionId)!;
    const was = this.typing(sessionId);
    if (typing) drafts.set(connection, true);
    else drafts.delete(connection);
    if (was && !this.typing(sessionId)) {
      this.cleared.set(sessionId, Date.now());
      this.soon(sessionId);
    }
  }

  /** An editor went away: its drafts with it, and it runs no more woken turns. */
  disconnected(connection: object): void {
    for (const waker of this.wakers) if (waker.connection === connection) this.wakers.delete(waker);
    for (const [sessionId, drafts] of this.drafts) if (drafts.has(connection)) this.draft(sessionId, connection, false);
  }

  /** An editor connected: sessions held for want of one may wake now. */
  connected(waker: Waker): void {
    this.wakers.add(waker);
    for (const sessionId of this.drafts.keys()) this.soon(sessionId);
    for (const sessionId of this.paused.keys()) this.soon(sessionId);
  }

  private typing(sessionId: string): boolean {
    return [...(this.drafts.get(sessionId)?.values() ?? [])].some(Boolean);
  }

  /** Looks at the session's gate once its pending writes are in the log. */
  soon(sessionId: string): void {
    clearTimeout(this.timers.get(sessionId));
    this.timers.delete(sessionId);
    const bound = this.store;
    if (bound === undefined) return;
    void this.deps
      .serially(sessionId, () => this.look(bound.store, bound.io, sessionId))
      .catch((error: unknown) => bound.io.err(`wake: could not look at ${sessionId}: ${error instanceof Error ? error.message : String(error)}`));
  }

  private async look(store: Store, io: Io, sessionId: string): Promise<void> {
    const log = await openSessionLog(store, sessionId, io);
    const head = log.events[0];
    // A subagent reports to its parent, and an external agent keeps its own turn; neither is woken.
    if (head?.kind !== 'session-start' || head.child !== undefined || log.session.backend !== undefined) return;
    const now = Date.now();
    const unwoken = unwokenOf(log.events, this.registry.wakes(sessionId));
    const pause = wakePauseOf(log.events, now, this.deps.policy.cap);
    const verdict = wakeGate({
      autoWake: this.deps.autoWake,
      now,
      arrivedAt: unwoken.lastAt,
      running: this.deps.turns.get(sessionId) !== undefined,
      asking: this.deps.tasks.asks(sessionId),
      typing: this.typing(sessionId),
      draftClearedAt: this.cleared.get(sessionId),
      pause,
      window: this.wakers.size > 0,
      batchMs: this.deps.policy.batchMs,
    });
    const waitsFor = this.registry.waitsFor(sessionId);
    // A pause is worth showing only while something would otherwise wake the session.
    if (pause !== undefined && (verdict.kind === 'paused' || waitsFor.length > 0)) this.paused.set(sessionId, pause);
    else this.paused.delete(sessionId);
    this.deps.tasks.wake(sessionId, this.view(sessionId));
    if (verdict.kind === 'at') this.timers.set(sessionId, setTimeout(() => this.soon(sessionId), Math.max(0, verdict.at - Date.now())));
    if (verdict.kind !== 'wake') return;
    const shown = this.deps.shownBy(sessionId);
    const waker = [...this.wakers].find((w) => w.connection === shown) ?? [...this.wakers][0];
    waker?.run(sessionId);
  }

  /**
   * Takes up the wake-ups an engine serving `cwd` left in the logs once it is gone, logging each again with this
   * engine as its waiter. A wake-up a live engine keeps stays with it.
   */
  async takeUp(store: Store, io: Io, cwd: string, by: Waiter, alive: (pid: number) => boolean = pidAlive): Promise<string[]> {
    const left = await schedulesLeft(store, cwd, alive);
    const taken: string[] = [];
    for (const { sessionId, schedules } of left) {
      await this.deps.serially(sessionId, async () => {
        const log = await openSessionLog(store, sessionId, io);
        await dropTornTail(log);
        let seq = nextSeq(log.events);
        for (const note of schedules) {
          const adopted: Extract<WakeNote, { kind: 'scheduled' }> = { ...note, by };
          await appendEvent(log.file, { kind: 'wake', seq: seq++, at: new Date().toISOString(), note: adopted });
          this.registry.schedule(sessionId, adopted);
        }
      });
      taken.push(sessionId);
    }
    return taken;
  }
}

// A wake-up is due within an hour of being set; a log untouched for a day holds none worth waking for.
const SCHEDULE_HORIZON_MS = 24 * 60 * 60 * 1000;
const SCHEDULED_LINE = '"kind":"scheduled"';

/** The logs with wake-ups that an engine serving `cwd` set or took up and that is gone. */
export async function schedulesLeft(
  store: Store,
  cwd: string,
  alive: (pid: number) => boolean = pidAlive,
): Promise<{ readonly sessionId: string; readonly schedules: readonly Extract<WakeNote, { kind: 'scheduled' }>[] }[]> {
  let names: string[];
  try {
    names = await readdir(store.sessionsDir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const found = await Promise.all(
    names
      .filter((name) => name.endsWith('.jsonl'))
      .map(async (name) => {
        const file = path.join(store.sessionsDir, name);
        try {
          if ((await stat(file)).mtimeMs < Date.now() - SCHEDULE_HORIZON_MS) return [];
          if (!(await readFile(file, 'utf8')).includes(SCHEDULED_LINE)) return [];
          const log = await readSessionLog(file);
          const schedules = openSchedulesOf(log.events).filter((note) => note.by !== undefined && note.by.cwd === cwd && !alive(note.by.pid));
          return schedules.length === 0 ? [] : [{ sessionId: log.session.id, schedules }];
        } catch {
          return [];
        }
      }),
  );
  return found.flat();
}

const policySchema = z.strictObject({ batchMs: z.number().int().nonnegative(), secondMs: z.number().int().positive(), cap: z.number().int().positive() }).partial();

/** WAKE_POLICY, with any of its numbers replaced from the GCODE_WAKE_POLICY JSON, which the tests use to wake in milliseconds. */
export function wakePolicyOf(env: Readonly<Record<string, string | undefined>>): WakePolicy {
  const raw = env['GCODE_WAKE_POLICY'];
  if (raw === undefined || raw === '') return WAKE_POLICY;
  const parsed = policySchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`GCODE_WAKE_POLICY: ${z.prettifyError(parsed.error)}`);
  return { ...WAKE_POLICY, ...Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)) };
}

export const draftNotice = z.object({ sessionId: z.string(), typing: z.boolean() });
export const wakeCancelRequest = z.object({ sessionId: z.string() });
