// Turns archived real-model sessions into the chat panel's messages for the gallery's "Real sessions" group, with the
// engine's own session replay and the extension's own update mapping, so the states show what the panel showed.
// usage: pnpm tsx scripts/run-to-gallery.ts        (writes packages/extension/test/gallery/real-sessions.ts)
import { writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { approvalQuestion, patternText, ruledDenial, SUBAGENT_META, type TurnEvent } from '../packages/core/src/index.js';
import { replayUpdates } from '../packages/engine/src/session-replay.js';
import { optionsFor } from '../packages/engine/src/serve.js';
import type { Action } from '../packages/extension/src/chat/messages.js';
import { actionOf, permissionAction, replayedEnd, replayedTurnStart, timeOf, updateActions } from '../packages/extension/src/chat/session-updates.js';
import { isChildAction, subagentAction } from '../packages/extension/src/chat/subagent-host.js';
import { steerActionOf } from '../packages/extension/src/chat/steer-host.js';
import { portableValue, readRun, REPO, RUNS, workspacesOf, type ArchivedRun, type Conversation, type LogEvent } from './real-usecases/archived-run.js';

type SessionUpdate = ReturnType<typeof replayUpdates>[number];
type SubagentUpdate = Extract<SessionUpdate, { sessionUpdate: 'subagent_update' }>;
type PermissionRequest = Parameters<typeof permissionAction>[0];

export const OUTPUT = path.join(REPO, 'packages/extension/test/gallery/real-sessions.ts');

/** A gallery state from a real run: which run, and, for an approval, that the state stops at the card. */
export const STATES = [
  { id: 'real-code-fix', title: 'A13: a finished code fix', run: 'A13-fail-then-fix/1' },
  { id: 'real-plan-todo', title: 'A10: a plan with its todo list', run: 'A10-plan-mode/1' },
  { id: 'real-subagent', title: 'B07: an explore subagent', run: 'B07-subagent-row/2' },
  { id: 'real-approval', title: 'B01: the approval card for rm -rf', run: 'B01-ask-allow/1', untilApproval: true },
  { id: 'real-thai', title: 'A02: a Thai prompt and answer', run: 'A02-thai-fix/1' },
] as const;

/** A subagent's start and end, as the engine tells an editor that shows subagents (`noticeOf` in subagent-acp.ts). */
function subagentUpdate(parent: string, start: LogEvent, end: LogEvent | undefined, task: string): SessionUpdate[] {
  const notice = (status: unknown, turns: number, costUsd: number | null) => ({
    sessionId: parent,
    child: start.child,
    toolUseId: start.toolUseId,
    role: start.role,
    task,
    model: start.model,
    effort: start.effort,
    caps: start.caps,
    status,
    turns,
    costUsd,
  });
  const update = (n: object): SessionUpdate => ({ sessionUpdate: 'subagent_update', sessionId: start.child, state: { state: 'running' }, _meta: { [SUBAGENT_META]: n } }) as SessionUpdate;
  return [update(notice({ kind: 'running' }, 0, 0)), ...(end === undefined ? [] : [update(notice(end.end, end.turns, end.costUsd))])];
}

/** The card the engine's `approve` asks with for the call the user allowed, from the rule that flags its command today. */
function approvalRequest(run: ArchivedRun, conversation: Conversation, toolUseId: string): PermissionRequest {
  const call = conversation.events.flatMap((e) => (e.kind === 'assistant' ? e.content : [])).find((b: any) => b.type === 'tool_use' && b.id === toolUseId);
  const logged = conversation.events.find((e) => e.kind === 'tool-result' && e.toolUseId === toolUseId)!.approval;
  const scope = { workspace: conversation.workspace, tempDir: tmpdir(), home: homedir() };
  const denial = ruledDenial(call.input.command, scope, 'ask', []);
  // The rule must still be the one the run logged; the command the card shows may span more of the line as the rules change.
  if (denial === undefined || denial.rule !== logged.rule || !denial.command.includes(logged.command)) {
    throw new Error(`${run.rel}: the engine flags ${JSON.stringify(call.input.command)} as ${denial?.rule ?? 'nothing'} today, not ${logged.rule} as the run logged`);
  }
  const rawInput = {
    command: denial.command,
    reason: denial.reason,
    ...(typeof call.input.description === 'string' ? { description: call.input.description } : {}),
    ...(denial.offer === undefined ? (denial.keeps === undefined ? {} : { rule: denial.keeps }) : { rule: patternText(denial.offer) }),
    ...(denial.subject === undefined ? {} : { subject: denial.subject }),
  };
  return { toolCall: { toolCallId: toolUseId, title: approvalQuestion(denial, undefined), kind: 'execute', status: 'pending', rawInput }, options: optionsFor(denial) };
}

/**
 * The panel's actions for a run's main conversation, as a session load replays it (ChatProvider.updated with a replay
 * open), with each subagent's start, its own replayed steps and its end placed under the call that started it, as the
 * panel shows them live. With `untilApproval`, they stop at the card for the first call the user allowed.
 */
export function actionsOf(run: ArchivedRun, untilApproval = false): Action[] {
  const workspaces = workspacesOf(run);
  const [main, ...others] = run.conversations.map((c) => ({ ...c, events: portableValue(c.events, workspaces) as LogEvent[] }));
  const children = new Map(others.map((c) => [c.id, c]));
  const events = main!.events;
  const asked = untilApproval ? events.find((e) => e.kind === 'tool-result' && e.approval?.decidedBy === 'user')?.toolUseId : undefined;
  if (untilApproval && asked === undefined) throw new Error(`${run.rel} has no call the user allowed`);
  const actions: Action[] = [];
  let end: Action | undefined;
  let turns = 0;
  for (const update of replayUpdates(events as TurnEvent[])) {
    if (update.sessionUpdate === 'user_message_chunk') {
      const steer = steerActionOf(update);
      if (steer !== undefined || update.content.type !== 'text') {
        if (steer !== undefined) actions.push(steer);
        continue;
      }
      if (end !== undefined) actions.push(end);
      actions.push(replayedTurnStart(update, update.content.text, `t${turns++}`, () => undefined));
      end = replayedEnd(update);
      continue;
    }
    actions.push(...updateActions(update, (file) => file));
    if (update.sessionUpdate !== 'tool_call') continue;
    if (update.toolCallId === asked) return [...actions, permissionAction(approvalRequest(run, main!, asked), '0')];
    const start = events.find((e) => e.kind === 'child-start' && e.toolUseId === update.toolCallId);
    if (start === undefined) continue;
    const at = Date.parse(start.at!);
    const task = (update.rawInput as { task?: string } | undefined)?.task ?? '';
    const [running, ended] = subagentUpdate(main!.id, start, events.find((e) => e.kind === 'child-end' && e.child === start.child), task);
    const begun = subagentAction(running as SubagentUpdate, at);
    if (begun !== undefined) actions.push(begun);
    for (const step of replayUpdates((children.get(start.child)?.events ?? []) as TurnEvent[])) {
      const action = actionOf(step, timeOf(step));
      if (isChildAction(action)) actions.push({ type: 'child', id: start.child, action });
    }
    if (ended !== undefined) {
      const done = subagentAction(ended as SubagentUpdate, Date.parse(events.find((e) => e.kind === 'child-end' && e.child === start.child)!.at!));
      if (done !== undefined) actions.push(done);
    }
  }
  return end === undefined ? actions : [...actions, end];
}

export function realSessions() {
  return STATES.map((state) => {
    const run = readRun(path.join(RUNS, state.run));
    return { id: state.id, title: state.title, source: run.rel, actions: actionsOf(run, 'untilApproval' in state && state.untilApproval) };
  });
}

export const renderRealSessions = (sessions: ReturnType<typeof realSessions>): string =>
  [
    '// Written by scripts/run-to-gallery.ts from the archived real-model runs. Run it again instead of editing this file.',
    "import type { Action } from '../../src/chat/messages.js';",
    '',
    'export type RealSession = { readonly id: string; readonly title: string; readonly source: string; readonly actions: readonly Action[] };',
    '',
    `export const REAL_SESSIONS: readonly RealSession[] = ${JSON.stringify(sessions, null, 2)};`,
    '',
  ].join('\n');

if (import.meta.url === `file://${process.argv[1]}`) {
  const sessions = realSessions();
  writeFileSync(OUTPUT, renderRealSessions(sessions));
  for (const s of sessions) console.log(`${s.id}: ${s.actions.length} actions from ${s.source}`);
}
