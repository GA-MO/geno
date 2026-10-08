import { GENO_NOTE } from './fence.js';
import { handedBack } from './handback.js';
import { spendOf, type SessionId, type TurnEvent } from './session.js';
import { childReport, childRunKey, type ChildStartEvent, type ChildUsage } from './subagent.js';

/**
 * Subagents an engine crash cut off (P18b). A child's run lives in the engine that started it, so when that engine
 * stops, the run stops with it and its parent's log keeps a start with no end. The next engine for the folder logs an
 * `interrupted` end for each such run, answers the calls it left running, and tells the parent once which ran and how
 * far each got. Nothing resumes on its own, because a run costs money: the parent or the user resumes one with
 * `message_agent`, which goes on from the child's own log.
 */

/** Each run whose start the log holds and whose end it does not, oldest first. */
export function openRunsOf(events: readonly TurnEvent[]): ChildStartEvent[] {
  const open = new Map<string, ChildStartEvent>();
  for (const event of events) {
    if (event.kind === 'child-start') open.set(childRunKey(event), event);
    else if (event.kind === 'child-end') open.delete(childRunKey(event));
  }
  return [...open.values()];
}

/** One run a stopped engine cut off, as the parent's notice lists it. */
export type CutOffRun = {
  readonly child: SessionId;
  /** The call that began the run: the `agent` call, or the `message_agent` call that resumed the child. */
  readonly toolUseId: string;
  readonly role: string;
  /** Its report, if it got as far as one, or else its last text. */
  readonly report: string;
  /** The files its edits changed, in the order it first changed each. */
  readonly files: readonly string[];
  readonly usage: ChildUsage;
  /** The workflow it was a step of, whose own session stopped with it. */
  readonly workflow?: { readonly session: SessionId; readonly name: string } | undefined;
};

/** What a run did, from its own events in the child's log: those logged since its start. */
export function cutOffRunOf(start: ChildStartEvent, childEvents: readonly TurnEvent[]): CutOffRun {
  const ran = childEvents.filter((e): e is Exclude<TurnEvent, { kind: 'session-start' }> => e.kind !== 'session-start' && e.at >= start.at);
  const spends = ran.flatMap((e) => spendOf(e) ?? []);
  const files = [...new Set(ran.flatMap((e) => (e.kind === 'tool-result' && e.change !== undefined ? [e.change.path] : [])))];
  const last = ran.at(-1);
  return {
    child: start.child,
    toolUseId: start.toolUseId,
    role: start.role,
    report: handedBack(ran, false),
    files,
    usage: {
      turns: ran.filter((e) => e.kind === 'assistant').length,
      costUsd: spends.some((s) => s.costUsd === null) ? null : spends.reduce((sum, s) => sum + (s.costUsd ?? 0), 0),
      durationMs: last === undefined ? 0 : Math.max(0, Date.parse(last.at) - Date.parse(start.at)),
    },
  };
}

/** The result of a call that a stopped engine left without one, so no later run runs it again. */
export const INTERRUPTED_CALL = '[Geno stopped] Geno stopped while this call ran, so it may have partly run and its result is lost.';

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** A path as the model's own edit named it, quoted, so a newline or a tag in it stays on its line and inside the fence. */
const shownFile = (file: string): string => JSON.stringify(file).replaceAll('<', '\\u003c');

/** Geno's notes inside a run's fence: what it changed, and the workflow it was a step of. */
function notesOf(run: CutOffRun): string[] {
  const changed = run.files.length === 0 ? `${GENO_NOTE} It changed no files.` : `${GENO_NOTE} It changed ${run.files.map(shownFile).join(', ')}.`;
  const step = run.workflow === undefined ? [] : [`${GENO_NOTE} It was a step of workflow ${run.workflow.name} (session ${run.workflow.session}), which stopped with it; that workflow's report will not come.`];
  return [changed, ...step];
}

/** The parent's one notice for every run it had cut off: what to do, then each run's report fenced as data. */
export function interruptedText(runs: readonly CutOffRun[]): string {
  const head = `Geno stopped before ${plural(runs.length, 'subagent of this session', 'subagents of this session')} ended, so ${runs.length === 1 ? 'its run was' : 'their runs were'} cut off. Nothing resumes on its own. To go on with one, call message_agent with its agent_session and what it should do next: it continues from its own transcript with fresh caps. The user can also resume each from Tasks. Tell the user which ${runs.length === 1 ? 'one was' : 'ones were'} cut off and how far each got, and do not redo their work unasked.`;
  return [head, ...runs.map((run) => childReport(run.role, run.child, { kind: 'interrupted' }, run.report, run.usage, notesOf(run)))].join('\n');
}
