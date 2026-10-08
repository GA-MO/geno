import { appendFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  answerEvent,
  asSessionId,
  childSummary,
  cutOffRunOf,
  INTERRUPTED_CALL,
  interruptedText,
  nextSeq,
  openRunsOf,
  pendingToolUses,
  titleOf,
  type ChildStartEvent,
  type CutOffRun,
  type InterruptedChild,
  type TurnEvent,
} from '@g-code/core';
import { holdingLock } from './file-lock.js';
import { dropTornTail, readSessionLog, sessionFile, type SessionLog } from './sessions.js';
import { isMissing, type Store } from './store.js';
import { pidAlive } from './wait-hooks.js';

/** A session that was told of subagents cut off, with those still not resumed, for its Tasks row. */
export type InterruptedSession = { readonly sessionId: string; readonly title: string; readonly workspace: string; readonly children: readonly InterruptedChild[] };

export type RecoveryDeps = {
  /** Runs `work` after the session's other log writes in this engine. */
  readonly serially: <T>(sessionId: string, work: () => Promise<T>) => Promise<T>;
  readonly alive?: ((pid: number) => boolean) | undefined;
  readonly pid?: number | undefined;
  readonly now?: (() => Date) | undefined;
};

// A crash worth telling a parent about is recent; a log untouched for a day is left as it is.
const HORIZON_MS = 24 * 60 * 60 * 1000;
const CHILD_LINE = '"kind":"child-start"';

type Parent = { readonly log: SessionLog; readonly runs: readonly ChildStartEvent[] };

/** Each log the scan reads: one that started a subagent, written within the horizon, that is not a subagent's own. */
async function parentLogs(store: Store): Promise<SessionLog[]> {
  let names: string[];
  try {
    names = await readdir(store.sessionsDir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const logs = await Promise.all(
    names
      .filter((name) => name.endsWith('.jsonl'))
      .map(async (name) => {
        const file = path.join(store.sessionsDir, name);
        try {
          if ((await stat(file)).mtimeMs < Date.now() - HORIZON_MS) return [];
          const log = await readSessionLog(file);
          const head = log.events[0];
          if (head?.kind !== 'session-start' || head.child !== undefined || !log.events.some((e) => e.kind === 'child-start')) return [];
          return [log];
        } catch {
          return [];
        }
      }),
  );
  return logs.flat();
}

const workflowOf = (log: SessionLog) => (log.events[0]?.kind === 'session-start' ? log.events[0].workflow : undefined);

/** Lines appended in one write, numbered after the log's last event, so a crash leaves all of them or a torn tail. */
async function appendAll(log: SessionLog, events: readonly TurnEvent[]): Promise<void> {
  if (events.length === 0) return;
  await dropTornTail(log);
  let seq = nextSeq(log.events);
  await appendFile(log.file, events.map((event) => `${JSON.stringify({ ...event, seq: seq++ })}\n`).join(''));
}

const reread = (sessionId: string, store: Store) => readSessionLog(sessionFile(store, asSessionId(sessionId)));

/** The calls among the log's pending ones that `ids` began, answered as cut off. */
const answered = (events: readonly TurnEvent[], ids: ReadonlySet<string> | undefined, at: string): TurnEvent[] =>
  pendingToolUses(events)
    .filter((use) => ids === undefined || ids.has(use.id))
    .map((use) => answerEvent({ use, text: INTERRUPTED_CALL }, 0, at));

/**
 * Takes up the subagent runs an engine serving `cwd` left open when it stopped (P18b). For each run its log started
 * and never ended, whose engine is gone, it answers the calls the run left pending in the child's log, tells the
 * session that started the run once with an `interrupted` note, then logs the run's `interrupted` end and answers the
 * parent's call that began it. A workflow step's notice goes to the session that started the workflow. It holds a
 * lock on the sessions folder, so two engines that start together tell each run once; a run already in a notice is
 * not told again, so a crash midway converges on the next start. A log with a run a live engine still holds is left
 * alone. Returns every session with subagents cut off and not resumed since, for its Tasks row.
 */
export async function recoverInterrupted(store: Store, cwd: string, deps: RecoveryDeps): Promise<InterruptedSession[]> {
  const alive = deps.alive ?? pidAlive;
  const now = deps.now ?? (() => new Date());
  return holdingLock(path.join(store.sessionsDir, 'interrupted'), deps.pid ?? process.pid, alive, async () => {
    const logs = await parentLogs(store);
    const parents: Parent[] = logs.flatMap((log) => {
      const open = openRunsOf(log.events);
      if (open.some((run) => run.by !== undefined && alive(run.by.pid))) return [];
      const runs = open.filter((run) => run.by !== undefined && run.by.cwd === cwd);
      return runs.length === 0 ? [] : [{ log, runs }];
    });
    const key = (run: { readonly child: string; readonly toolUseId: string }) => `${run.child} ${run.toolUseId}`;
    const cut = new Map<string, CutOffRun>();
    const told = new Map<string, CutOffRun[]>();
    for (const { log, runs } of parents) {
      const workflow = workflowOf(log);
      for (const run of runs) {
        const events = await deps.serially(run.child, async () => {
          const child = await reread(run.child, store).catch(() => undefined);
          if (child !== undefined) await appendAll(child, answered(child.events, undefined, now().toISOString()));
          return child?.events ?? [];
        });
        const done = { ...cutOffRunOf(run, events), ...(workflow === undefined ? {} : { workflow: { session: log.session.id, name: workflow.name } }) };
        cut.set(key(run), done);
        const recipient = workflow?.parentId ?? log.session.id;
        told.set(recipient, [...(told.get(recipient) ?? []), done]);
      }
    }
    // The parent's calls first, so their results follow the calls in its log before any note does.
    for (const { log: before, runs } of parents) {
      await deps.serially(before.session.id, async () => {
        const log = await reread(before.session.id, store);
        await appendAll(log, answered(log.events, new Set(runs.map((run) => run.toolUseId)), now().toISOString()));
      });
    }
    for (const [recipient, runs] of told) {
      await deps.serially(recipient, async () => {
        const log = await reread(recipient, store);
        const announced = new Set(log.events.flatMap((e) => (e.kind === 'wake' && e.note.kind === 'interrupted' ? e.note.runs.map(key) : [])));
        const fresh = runs.filter((run) => !announced.has(key(run)));
        if (fresh.length === 0) return;
        const runsTold = fresh.map(({ child, toolUseId }) => ({ child, toolUseId }));
        await appendAll(log, [{ kind: 'wake', seq: 0, at: now().toISOString(), note: { kind: 'interrupted', runs: runsTold, text: interruptedText(fresh) } }]);
      });
    }
    for (const { log: before } of parents) {
      await deps.serially(before.session.id, async () => {
        const log = await reread(before.session.id, store);
        const at = now().toISOString();
        const ending = openRunsOf(log.events).filter((run) => cut.has(key(run)));
        const ends = ending.map((run): TurnEvent => {
          const { usage, report } = cut.get(key(run))!;
          return { kind: 'child-end', seq: 0, at, child: run.child, toolUseId: run.toolUseId, end: { kind: 'interrupted' }, turns: usage.turns, costUsd: usage.costUsd, summary: childSummary(report) };
        });
        await appendAll(log, ends);
      });
    }
    return cutOffSessions(store, await parentLogs(store));
  });
}

/**
 * The sessions whose subagents' newest runs ended interrupted, with those subagents. A child resumed since has a newer
 * start, maybe in another log: a workflow step that the workflow's starter resumed starts again in that session's log.
 */
async function cutOffSessions(store: Store, logs: readonly SessionLog[]): Promise<InterruptedSession[]> {
  const newest = new Map<string, { readonly at: string; readonly owner: SessionLog; readonly event: TurnEvent }>();
  for (const log of logs) {
    for (const event of log.events) {
      if (event.kind !== 'child-start' && event.kind !== 'child-end') continue;
      const before = newest.get(event.child);
      if (before === undefined || before.at <= event.at) newest.set(event.child, { at: event.at, owner: log, event });
    }
  }
  const byRecipient = new Map<string, InterruptedChild[]>();
  const roles = new Map<string, string>();
  for (const log of logs) for (const e of log.events) if (e.kind === 'child-start') roles.set(e.child, e.role);
  for (const [child, { owner, event }] of newest) {
    if (event.kind !== 'child-end' || event.end.kind !== 'interrupted') continue;
    const recipient = workflowOf(owner)?.parentId ?? owner.session.id;
    byRecipient.set(recipient, [...(byRecipient.get(recipient) ?? []), { child, role: roles.get(child) ?? 'subagent', summary: event.summary }]);
  }
  const sessions: InterruptedSession[] = [];
  for (const [sessionId, children] of byRecipient) {
    const log = logs.find((l) => l.session.id === sessionId) ?? (await reread(sessionId, store).catch(() => undefined));
    if (log === undefined) continue;
    sessions.push({ sessionId, title: titleOf(log.events) ?? 'Chat', workspace: log.session.workspace, children });
  }
  return sessions;
}
