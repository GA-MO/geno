import type { ForkOrigin } from './rewind.js';
import { classifierCostOf, spendOf, type Session, type SessionId, type TurnEvent } from './session.js';

/** One past conversation as the history lists it, read from its log. */
export type SessionSummary = {
  readonly id: SessionId;
  /** Absolute, as the session logged it. */
  readonly workspace: string;
  readonly title: string;
  readonly createdAt: string;
  /** When anything was last logged. */
  readonly updatedAt: string;
  /** Prompts the user sent. */
  readonly turns: number;
  /** Null when any model call had no known price. */
  readonly costUsd: number | null;
  /** The session and turn this one was forked from; absent for a session started fresh. */
  readonly forkedFrom?: ForkOrigin | undefined;
};

/** Which sessions a listing shows: one workspace's, or every workspace's but the temporary ones. */
export type SessionScope = { readonly kind: 'project'; readonly workspace: string } | { readonly kind: 'all' };

export const UNTITLED = 'New chat';

const TITLE_LENGTH = 80;

/** A prompt as a title: its words on one line, cut to fit a list row. */
export function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= TITLE_LENGTH ? line : `${line.slice(0, TITLE_LENGTH - 1).trimEnd()}…`;
}

/** The name the user gave the session last, else its first prompt; undefined before the first prompt. */
export function titleOf(events: readonly TurnEvent[]): string | undefined {
  let named: string | undefined;
  let first: string | undefined;
  for (const event of events) {
    if (event.kind === 'title') named = event.title;
    if (event.kind === 'user' && first === undefined && event.content.trim() !== '') first = titleFrom(event.content);
  }
  return named ?? first;
}

export function summarizeSession(session: Session, events: readonly TurnEvent[]): SessionSummary {
  const prompts = events.filter((e) => e.kind === 'user' && e.steer !== true);
  // A subagent's spend is the parent's: the parent's log records it when the child ends.
  const spends = events.flatMap((e): (number | null)[] => {
    if (e.kind === 'child-end') return [e.costUsd];
    const spend = spendOf(e);
    if (spend === undefined) return classifierCostOf(e) > 0 ? [classifierCostOf(e)] : [];
    return [spend.costUsd];
  });
  const last = events.at(-1);
  const head = events[0];
  const forkedFrom = head?.kind === 'session-start' ? head.fork : undefined;
  return {
    id: session.id,
    workspace: session.workspace,
    title: titleOf(events) ?? UNTITLED,
    createdAt: session.createdAt,
    updatedAt: last === undefined || last.kind === 'session-start' ? session.createdAt : last.at,
    turns: prompts.length,
    costUsd: spends.includes(null) ? null : spends.reduce<number>((sum, cost) => sum + (cost ?? 0), 0),
    ...(forkedFrom === undefined ? {} : { forkedFrom }),
  };
}

const within = (root: string, target: string): boolean => target === root || target.startsWith(root.endsWith('/') ? root : `${root}/`);

/**
 * Whether a listing shows the session. A session the user never prompted is left out. Every workspace's list
 * leaves out sessions in temporary directories, eval clones and tests; the current project's list shows its
 * own sessions wherever it lives.
 */
export function inScope(summary: SessionSummary, scope: SessionScope, tempRoots: readonly string[]): boolean {
  if (summary.turns === 0) return false;
  if (scope.kind === 'project') return summary.workspace === scope.workspace;
  return !tempRoots.some((root) => within(root, summary.workspace));
}

/** Newest activity first. */
export const byRecency = (a: SessionSummary, b: SessionSummary): number => b.updatedAt.localeCompare(a.updatedAt);
