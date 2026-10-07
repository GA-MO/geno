import type { RunEndKind, ScheduleRun, ScheduleView } from '@g-code/core';
import { budgetText, describeWhen, formatAt, MISSED_COUNT_CAP } from '@g-code/core/schedule';
import { formatCost } from './format.js';
import type { Badge, Tone } from './lanes-model.js';

/**
 * The Tasks pane's Scheduled section: one row per scheduled task, from what the engine lists. The webview bundles
 * this file, so it imports only types and other pure webview modules.
 */

/** What the last run came to, with the session it ran in when there is one to open. */
export type LastRun = { readonly text: string; readonly tone: Tone; readonly open: { readonly sessionId: string; readonly workspace: string } | undefined };

export type ScheduleRow = {
  readonly id: string;
  readonly title: string;
  readonly state: Badge;
  /** "Weekdays at 09:00", and when it next runs. */
  readonly when: string;
  readonly next: string;
  /** Read-only, or edits in a lane of its own, and the budget a run stops at. */
  readonly how: string;
  readonly last: LastRun | undefined;
  readonly running: boolean;
  readonly paused: boolean;
};

const END_WORDS: { readonly [K in RunEndKind]: { readonly label: string; readonly tone: Tone } } = {
  done: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed', tone: 'failed' },
  stopped: { label: 'Stopped', tone: 'quiet' },
  budget: { label: 'Stopped at its budget', tone: 'wait' },
  'max-turns': { label: 'Stopped at its turn limit', tone: 'wait' },
};

function lastOf(run: ScheduleRun | undefined, zone: string, now: number): LastRun | undefined {
  if (run === undefined) return undefined;
  const at = (ms: number) => formatAt(ms, zone, now);
  switch (run.kind) {
    case 'ran': {
      const open = { sessionId: run.sessionId, workspace: run.workspace };
      const why = run.trigger === 'catch-up' ? ` (late, for ${at(run.dueAt)})` : run.trigger === 'now' ? ' (Run now)' : '';
      if (run.end === null) return { text: `Running since ${at(run.startedAt)}${why}`, tone: 'busy', open };
      const words = END_WORDS[run.end.kind];
      const cost = run.end.costUsd === null ? '' : ` · ${formatCost(run.end.costUsd)}`;
      return { text: `Last run ${at(run.startedAt)}${why}: ${words.label}${cost}`, tone: words.tone, open };
    }
    case 'missed': {
      const which = run.count === 1 ? at(run.to) : `${run.count >= MISSED_COUNT_CAP ? `${MISSED_COUNT_CAP}+` : run.count} runs, ${at(run.from)} to ${at(run.to)}`;
      return { text: `Missed ${which}: ${run.why === 'off' ? 'Geno was not running' : 'the last run still ran'}`, tone: 'wait', open: undefined };
    }
    case 'not-started':
      return { text: `Did not start at ${at(run.at)}: ${run.message}`, tone: 'failed', open: undefined };
  }
}

export function scheduleRowOf(task: ScheduleView, zone: string, now: number): ScheduleRow {
  const running = task.runs.some((run) => run.kind === 'ran' && run.end === null);
  return {
    id: task.id,
    title: task.title,
    state: running ? { label: 'Running', tone: 'busy' } : task.paused ? { label: 'Paused', tone: 'quiet' } : { label: 'Scheduled', tone: 'ok' },
    when: describeWhen(task.when, zone, now),
    next: task.paused ? 'Paused' : task.nextAt === null ? 'No run left' : `Next ${formatAt(task.nextAt, zone, now)}`,
    how: `${task.edits ? 'Edits in its own lane' : 'Read-only'} · ${budgetText(task.budget)}`,
    last: lastOf(task.runs.at(-1), zone, now),
    running,
    paused: task.paused,
  };
}

export const SCHEDULE_HINT = 'Add one with /schedule in the chat, such as /schedule weekdays at 9:00 run /review on main.';
