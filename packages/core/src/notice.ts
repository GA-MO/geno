import { DEFAULT_SESSION_MODE, type SessionMode } from './approval.js';
import { contextView } from './compact.js';
import { GENO_NOTE } from './fence.js';
import { mcpDelta, NO_MCP_BRIEFING, renderMcpDelta, withMcpDelta, type McpBriefing, type McpDelta } from './mcp-notice.js';
import { memoryDelta, renderMemoryDelta, withDelta, type MemoryDelta, type MemoryEntry } from './memory.js';
import type { TurnEvent } from './session.js';
import { todoLines, type TodoList } from './todo.js';

/**
 * What changed in the session's settings since the model was last told: the mode the user switched to, the memory
 * notes added or removed, and the MCP tools and servers that came or went. It is logged at the safe point before a
 * model call and read as a message, so the system prompt and the tools stay byte-stable for the whole session and the
 * cached prefix holds across a change. The session's first MCP notice is its whole briefing, in the first request.
 */
export type Notice = {
  readonly mode?: SessionMode | undefined;
  readonly memory?: MemoryDelta | undefined;
  readonly mcp?: McpDelta | undefined;
  readonly budget?: BudgetLeft | undefined;
  readonly todo?: TodoReminder | undefined;
  /** The next model call is the last the run's limits allow, and it goes out with the tools off. */
  readonly last?: true | undefined;
};

/**
 * What a run has left of its limits, told once when 20% or less of its model calls or its cost is left. `perCallUsd`
 * is the run's mean cost a call so far, undefined before a priced call.
 */
export type BudgetLeft = {
  readonly calls: number;
  readonly maxCalls: number;
  readonly costUsd: number;
  readonly maxCostUsd: number;
  readonly perCallUsd?: number | undefined;
};

/** The share of a limit at or under which the model is told what is left. */
export const BUDGET_REMINDER_SHARE = 0.2;

const usd = (value: number): string => `$${value.toFixed(value < 0.1 ? 4 : 2)}`;

// A model reads a dollar figure badly, so the cost left is also counted in calls. A call starts while the spend is
// within the limit, so the last one may pass it.
const callsLeft = ({ calls, costUsd, perCallUsd }: BudgetLeft): number =>
  perCallUsd === undefined || perCallUsd <= 0 ? calls : Math.max(1, Math.min(calls, Math.ceil(costUsd / perCallUsd)));

export function renderBudgetLeft(left: BudgetLeft): string {
  const n = callsLeft(left);
  const perCall = left.perCallUsd === undefined ? '' : `, at about ${usd(left.perCallUsd)} a call`;
  return `${GENO_NOTE} This run is near its limits: about ${n} more model call${n === 1 ? ' is' : 's are'} left (${left.calls} of its ${left.maxCalls} calls, and ${usd(left.costUsd)} of its ${usd(left.maxCostUsd)} cost limit${perCall}). When either runs out, the run stops and you get no further turn. Start no new exploration or checks. Finish the step in hand, then end your turn with a short report: what you did, how you checked it, and what is still open.`;
}

export const LAST_CALL_NOTE = `${GENO_NOTE} This is the last model call this run's limits allow, so tools are off for it and nothing runs after it. Do not call a tool. Write your report now: what you did, how you checked it, and what is still open.`;

/**
 * The todo list as it stands, when it has work left that the model may have let go stale: `idle` after
 * `TODO_REMINDER_CALLS` model calls without a todo call; `ending` when the model ended its turn on its own, once a run;
 * at a prompt the user typed, `stopped` when the turn before was stopped, failed or capped by its limits, and `earlier`
 * when it ended on its own. Logged with the list, so a replay sends the same bytes.
 */
export type TodoReminder = { readonly why: 'idle' | 'ending' | 'stopped' | 'earlier'; readonly list: TodoList };

// The value commonly reported for Claude Code's TodoWrite reminder, which research/claude-code-harness does not record:
// 10 assistant turns since the last write, and 10 between reminders.
export const TODO_REMINDER_CALLS = 10;

const UPDATE_NOW =
  "Bring it up to date now with one todo call that passes the whole list. Mark done every item you have already finished, even if the rest of the list still applies, and mark in_progress the one you are working on. If the user's latest request moved on to something else and the list no longer applies, clear it by calling todo with an empty list. Do not mention this note to the user.";

const TODO_REMINDER_TEXTS: Readonly<Record<TodoReminder['why'], (unfinished: number) => { readonly opening: string; readonly closing: string }>> = {
  idle: () => ({ opening: `You have not updated your todo list in your last ${TODO_REMINDER_CALLS} model calls, and it still has unfinished items:`, closing: UPDATE_NOW }),
  ending: (unfinished) => ({
    opening: `You ended your turn, but your todo list still shows ${unfinished} unfinished ${unfinished === 1 ? 'item' : 'items'}:`,
    closing:
      'The user sees this list. Update it to match what is done with one todo call that passes the whole list, or clear it with an empty list if it no longer applies, then end your turn. If you stopped to wait for the user, say so in one line and end your turn. Do not mention this note to the user.',
  }),
  stopped: () => ({ opening: 'Your last turn ended before your todo list was finished, and the list still stands as it was then:', closing: UPDATE_NOW }),
  earlier: () => ({ opening: 'Your todo list from earlier still has unfinished items:', closing: UPDATE_NOW }),
};

export function renderTodoReminder({ why, list }: TodoReminder): string {
  const { opening, closing } = TODO_REMINDER_TEXTS[why](list.filter((item) => item.status !== 'done').length);
  return [`${GENO_NOTE} ${opening}`, ...todoLines(list), closing].join('\n');
}

/**
 * The text each mode adds while it holds. The system prompt describes Ask; every mode is offered the same tools, and
 * the tools a mode leaves out are refused when called.
 */
export const MODE_NOTICES: Readonly<Record<SessionMode, string>> = {
  plan: `${GENO_NOTE} The user switched this session to Plan mode, which is read-only. You cannot change anything: edit, and every tool that starts or stops background work or wakes you later, is refused, and bash runs only read-only commands from the safe list; anything else is denied. This overrides what the system prompt says about changing code, until the user switches modes again. Investigate with read, grep, glob, list, check and safe bash commands, then answer with:
- a concrete, numbered step-by-step plan for the change;
- the files you would change or create, and what changes in each;
- the risks and open questions, and how you would check the result.
Also write the steps with the todo tool, all pending, since that same list is the one you tick off once the user starts building.
Do not ask to switch modes; the user starts building when the plan looks right.`,
  ask: `${GENO_NOTE} The user switched this session to Ask mode. You can change code as the system prompt describes; a command outside the safe list asks the user before it runs.`,
  auto: `${GENO_NOTE} The user switched this session to Auto mode. You can change code as the system prompt describes. A command outside the safe list goes to a classifier instead of the user, and ask_user is refused: when something is ambiguous, choose the reading that best fits the codebase and say which you chose.`,
};

/** What the model has been told: the session's opening, then each notice, in the events it reads now. */
export type Told = { readonly mode: SessionMode; readonly memory: readonly MemoryEntry[]; readonly mcp: McpBriefing };

/**
 * Read from the context view, so a compaction that drops a notice drops what it told, and the next safe point tells
 * it again.
 */
export function toldOf(events: readonly TurnEvent[]): Told {
  const view = contextView(events);
  const start = view[0];
  let mode: SessionMode = DEFAULT_SESSION_MODE;
  let memory: readonly MemoryEntry[] = start?.kind === 'session-start' ? (start.memory ?? []) : [];
  let mcp = NO_MCP_BRIEFING;
  for (const event of view) {
    if (event.kind !== 'notice') continue;
    if (event.mode !== undefined) mode = event.mode;
    if (event.memory !== undefined) memory = withDelta(memory, event.memory);
    if (event.mcp !== undefined) mcp = withMcpDelta(mcp, event.mcp);
  }
  return { mode, memory, mcp };
}

/** The session as it is at a safe point. `mode` is undefined in a run nobody can switch, `mcp` in a run without MCP. */
export type Now = { readonly mode: SessionMode | undefined; readonly memory: readonly MemoryEntry[]; readonly mcp?: McpBriefing | undefined };

/** What to tell the model before its next call, or undefined when it already knows. */
export function noticeFor(events: readonly TurnEvent[], now: Now): Notice | undefined {
  const told = toldOf(events);
  const mode = now.mode !== undefined && now.mode !== told.mode ? now.mode : undefined;
  const memory = memoryDelta(told.memory, now.memory);
  const mcp = now.mcp === undefined ? undefined : mcpDelta(told.mcp, now.mcp);
  if (mode === undefined && memory === undefined && mcp === undefined) return undefined;
  return { ...(mode === undefined ? {} : { mode }), ...(memory === undefined ? {} : { memory }), ...(mcp === undefined ? {} : { mcp }) };
}

/** A notice as the model reads it: the mode's text, then the memory change, then the MCP change, then the todo list, then the budget. */
export const noticeTexts = (notice: Notice): string[] => [
  ...(notice.mode === undefined ? [] : [MODE_NOTICES[notice.mode]]),
  ...(notice.memory === undefined ? [] : [renderMemoryDelta(notice.memory)]),
  ...(notice.mcp === undefined ? [] : [renderMcpDelta(notice.mcp)]),
  ...(notice.todo === undefined ? [] : [renderTodoReminder(notice.todo)]),
  ...(notice.budget === undefined ? [] : [renderBudgetLeft(notice.budget)]),
  ...(notice.last === true ? [LAST_CALL_NOTE] : []),
];
