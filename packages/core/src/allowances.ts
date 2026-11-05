import { isMcpRule } from './approval.js';
import type { TurnEvent } from './session.js';
import { startsTurn } from './steer.js';

/**
 * What a call let the rest of its session do unasked, logged on its result: a page on `host` the browser opened, a
 * directory the user allowed the session to read, or schedule changes the user allowed in the chat.
 */
export type SessionAllowance = { readonly kind: 'host'; readonly host: string } | { readonly kind: 'directory'; readonly path: string } | { readonly kind: 'schedule' };

/** What the user allowed for the rest of a session, as its log has it, so a run that resumes the session keeps it. */
export type SessionAllowances = { readonly tools: ReadonlySet<string>; readonly hosts: ReadonlySet<string>; readonly directories: ReadonlySet<string>; readonly schedule: boolean };

/** The events of the session's own turns. A fork's log begins with the turns it copied, whose answers were given to its source. */
function ownEvents(events: readonly TurnEvent[]): readonly TurnEvent[] {
  const head = events[0];
  if (head?.kind !== 'session-start' || head.fork === undefined) return events;
  const { turnSeq } = head.fork;
  const start = events.findIndex((event) => startsTurn(event) && event.seq > turnSeq);
  return start === -1 ? [] : events.slice(start);
}

/** The MCP tools the user allowed for the session or the workspace, by model-facing name, and what each call's result says it allowed. */
export function sessionAllowances(events: readonly TurnEvent[]): SessionAllowances {
  const tools = new Set<string>();
  const hosts = new Set<string>();
  const directories = new Set<string>();
  let schedule = false;
  for (const event of ownEvents(events)) {
    if (event.kind !== 'tool-result') continue;
    const { approval } = event;
    if (approval?.kept !== undefined && approval.decidedBy === 'user' && approval.verdict === 'allow' && isMcpRule(approval.rule)) tools.add(event.name);
    for (const allowed of event.allows ?? []) {
      if (allowed.kind === 'host') hosts.add(allowed.host);
      else if (allowed.kind === 'directory') directories.add(allowed.path);
      else schedule = true;
    }
  }
  return { tools, hosts, directories, schedule };
}
