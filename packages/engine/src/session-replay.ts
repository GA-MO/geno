import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as acp from '@agentclientprotocol/sdk';
import {
  APPROVAL_META,
  isWakePrompt,
  triggerOf,
  WAKE_META,
  wakeLabel,
  type WakeMark,
  EDITOR_ACTION_META,
  BACKGROUND_META,
  type JobView,
  laneApplyPrompt,
  laneApplyText,
  askUserTitle,
  DEFAULT_SESSION_MODE,
  parseAskUser,
  REPLAYED_AT_META,
  REPLAYED_CHANGE_META,
  REPLAYED_TURN_META,
  STEER_META,
  steerMarkOf,
  reviewState,
  toolResultText,
  type FileChange,
  type HunkId,
  type HunkStatus,
  type ReplayedTurn,
  type SessionMode,
  type ToolResultEvent,
  type ToolStatus,
  type TurnErrorKind,
  type TurnEvent,
  parseShowWidget,
  parseTodo,
  TODO_META,
  TODO_TOOL,
  todoLine,
  WIDGET_META,
  WIDGET_TOOL,
  type WidgetRef,
} from '@g-code/core';
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { EXECUTORS } from './tools/index.js';

type EventOf<K extends TurnEvent['kind']> = Extract<TurnEvent, { kind: K }>;

/** A woken turn's mark, which its first chunk carries live and in a replay. */
export const wakeMetaOf = (event: EventOf<'user'>): Record<string, WakeMark> =>
  isWakePrompt(event) ? { [WAKE_META]: { seq: event.seq, triggers: event.wake, label: wakeLabel(event.wake) } } : {};

/** A steer as the user message chunk that shows it where it landed in its turn, live and in a replay. */
export const steerUpdate = (event: EventOf<'user'>): acp.SessionUpdate => ({
  sessionUpdate: 'user_message_chunk',
  content: { type: 'text', text: event.content },
  _meta: { [STEER_META]: steerMarkOf(event) },
});

export const TOOL_KINDS: Readonly<Record<string, acp.ToolKind>> = {
  read: 'read',
  grep: 'search',
  glob: 'search',
  list: 'search',
  edit: 'edit',
  bash: 'execute',
  check: 'execute',
  web_fetch: 'fetch',
  web_search: 'fetch',
};

export const TOOL_STATUS: Readonly<Record<ToolStatus, acp.ToolCallStatus>> = { ok: 'completed', error: 'failed', denied: 'failed' };

/** How a turn that ended in an error shows, as its live stop reason showed it: a stop, a failure, or an answer with the error in it. */
const ERROR_STATUS: Readonly<Record<TurnErrorKind, ReplayedTurn['status']>> = {
  abort: 'stopped',
  refusal: 'failed',
  'max-turns': 'failed',
  budget: 'failed',
  transport: 'done',
  overflow: 'done',
};

/** The agent tools' own titles, which need their executors' environment, as they read live. */
const AGENT_TITLES: Readonly<Record<string, (input: Record<string, unknown>) => string>> = {
  edit: ({ path }) => `edit ${String(path)}`,
  bash: ({ command }) => `bash ${String(command)}`,
  check: () => 'check',
  [WIDGET_TOOL]: (input) => {
    const parsed = parseShowWidget(input);
    return parsed.ok ? `${WIDGET_TOOL} ${parsed.value.title}` : WIDGET_TOOL;
  },
  [TODO_TOOL]: (input) => {
    const parsed = parseTodo(input);
    return parsed.ok ? `${TODO_TOOL} ${todoLine(parsed.value)}` : TODO_TOOL;
  },
  ask_user: (input) => {
    const parsed = parseAskUser(input);
    return parsed.ok ? `ask_user ${askUserTitle(parsed.value)}` : 'ask_user';
  },
};

export const titleOf = (use: ToolUseBlock): string => {
  if (Object.hasOwn(EXECUTORS, use.name)) return EXECUTORS[use.name as keyof typeof EXECUTORS].describe(use.input);
  return AGENT_TITLES[use.name]?.((use.input ?? {}) as Record<string, unknown>) ?? use.name;
};

export const textUpdate = (text: string): acp.SessionUpdate => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

/** A failure belongs in the transcript, and a notice is live status only, so it goes as agent text, live and replayed. */
export const errorText = (event: EventOf<'error'>): string => `\n\n[${event.error}] ${event.message}`;

/** A stored widget as the editor gets it: the file's address, and its html unless the file is gone. */
export type ShownWidget = { readonly uri: string; readonly html: string | undefined };

/** No widget files at hand, as for a log replayed without its attachments folder. */
const NO_WIDGETS = (): ShownWidget => ({ uri: '', html: undefined });

/**
 * A tool's result as its closing update, live and replayed; `meta` adds to the approval record a flagged command
 * carries. A widget's html goes along as an embedded resource, its reference under WIDGET_META.
 */
export const toolResultUpdate = (event: ToolResultEvent, meta: Record<string, unknown> = {}, widget?: ShownWidget): acp.SessionUpdate => {
  const all = {
    ...(event.approval === undefined ? {} : { [APPROVAL_META]: event.approval }),
    ...(event.widget === undefined ? {} : { [WIDGET_META]: event.widget }),
    ...(event.editorAction === undefined ? {} : { [EDITOR_ACTION_META]: event.editorAction }),
    ...(event.todo === undefined ? {} : { [TODO_META]: { items: event.todo } }),
    ...meta,
  };
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: event.toolUseId,
    status: TOOL_STATUS[event.status],
    content: [
      { type: 'content', content: { type: 'text', text: toolResultText(event) } },
      ...(event.images ?? []).flatMap((image): acp.ToolCallContent[] =>
        image.path === undefined ? [] : [{ type: 'content', content: { type: 'resource_link', uri: pathToFileURL(image.path).href, name: image.name, mimeType: image.mediaType, size: image.bytes } }],
      ),
      ...(widget?.html === undefined ? [] : [{ type: 'content' as const, content: { type: 'resource' as const, resource: { uri: widget.uri, mimeType: 'text/html', text: widget.html } } }]),
    ],
    ...(Object.keys(all).length === 0 ? {} : { _meta: all }),
  };
};

/** A background job as its bash call's step follows it, live and replayed. */
export const backgroundUpdate = (view: JobView, meta: Record<string, unknown> = {}): acp.SessionUpdate => ({
  sessionUpdate: 'tool_call_update',
  toolCallId: view.toolUseId,
  _meta: { [BACKGROUND_META]: view, ...meta },
});

const ms = (iso: string): number => Date.parse(iso);

/** One prompt, the mode the session was in when it was sent, and everything logged until the next. */
type Run = { readonly prompt: EventOf<'user'>; readonly mode: SessionMode; readonly events: readonly TurnEvent[] };

function runsOf(events: readonly TurnEvent[]): Run[] {
  const runs: { prompt: EventOf<'user'>; mode: SessionMode; events: TurnEvent[] }[] = [];
  let mode = DEFAULT_SESSION_MODE;
  for (const event of events) {
    if (event.kind === 'mode') mode = event.mode;
    if (event.kind === 'user' && event.steer !== true) runs.push({ prompt: event, mode, events: [] });
    // A lane apply is a turn of its own in the panel, as the prompt that asked for it showed live.
    else if (event.kind === 'lane-apply') runs.push({ prompt: { kind: 'user', seq: event.seq, at: event.at, content: laneApplyPrompt(event.lane, event.grafted) }, mode, events: [event] });
    else runs.at(-1)?.events.push(event);
  }
  return runs;
}

function turnOf({ prompt, mode, events }: Run): ReplayedTurn {
  const answers = events.flatMap((e) => (e.kind === 'assistant' ? [e] : []));
  const error = events.findLast((e) => e.kind === 'error');
  // Background work may report long after its turn ended, for a woken turn to take; the turn ended with its own last event.
  const last = events.findLast((e) => e.kind !== 'background-end' && e.kind !== 'child-end' && e.kind !== 'wake' && triggerOf(e) === undefined);
  return {
    ...(events[0]?.kind === 'lane-apply' ? {} : { seq: prompt.seq }),
    mode,
    startedAt: ms(prompt.at),
    endedAt: ms(last === undefined || last.kind === 'session-start' ? prompt.at : last.at),
    status: error === undefined ? 'done' : ERROR_STATUS[error.error],
    usage:
      answers.length === 0
        ? null
        : {
            model: answers.at(-1)!.model,
            inputTokens: answers.reduce((n, a) => n + a.usage.input + a.usage.cacheRead + a.usage.cacheWrite, 0),
            outputTokens: answers.reduce((n, a) => n + a.usage.output, 0),
            costUsd: answers.some((a) => a.costUsd === null) ? null : answers.reduce((n, a) => n + (a.costUsd ?? 0), 0),
          },
    ...(prompt.command === undefined ? {} : { command: prompt.command }),
  };
}

/** The edit with each hunk in the status the log's review decisions and rewinds left it. */
const reviewed = (change: FileChange, status: ReadonlyMap<HunkId, HunkStatus>): FileChange => ({
  ...change,
  hunks: change.hunks.map((hunk, i) => ({ ...hunk, status: status.get(`${change.id}:${i}` as HunkId) ?? hunk.status })),
});

/**
 * The session as ACP updates, for session/load: each prompt as a user message carrying how its turn went, then
 * the model's text and tool calls with their results, as the client saw them live. Thinking, retries and the
 * bookkeeping events are left out. `widgetOf` gives each widget the stored html the live update carried.
 */
export function replayUpdates(events: readonly TurnEvent[], widgetOf: (widget: WidgetRef) => ShownWidget = NO_WIDGETS): acp.SessionUpdate[] {
  const status = new Map(reviewState(events).map((hunk) => [hunk.id, hunk.status]));
  const start = events[0];
  const workspace = start?.kind === 'session-start' ? start.session.workspace : undefined;
  return runsOf(events).flatMap((run) => {
    const meta: ReplayedTurn = turnOf(run);
    const updates: acp.SessionUpdate[] = [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: run.prompt.content }, _meta: { [REPLAYED_TURN_META]: meta, ...wakeMetaOf(run.prompt) } },
    ];
    for (const event of run.events) {
      if (event.kind === 'assistant') {
        for (const block of event.content) {
          if (block.type === 'text' && block.text !== '') updates.push(textUpdate(block.text));
          if (block.type === 'tool_use') {
            updates.push({
              sessionUpdate: 'tool_call',
              toolCallId: block.id,
              title: titleOf(block),
              kind: TOOL_KINDS[block.name] ?? 'other',
              status: 'in_progress',
              rawInput: block.input,
              _meta: { [REPLAYED_AT_META]: ms(event.at) },
            });
          }
        }
      }
      if (event.kind === 'tool-result') {
        updates.push(
          toolResultUpdate(
            event,
            {
              [REPLAYED_AT_META]: ms(event.at),
              ...(event.change === undefined ? {} : { [REPLAYED_CHANGE_META]: reviewed(event.change, status) }),
            },
            event.widget === undefined ? undefined : widgetOf(event.widget),
          ),
        );
      }
      if (event.kind === 'lane-apply') {
        event.changes.forEach((change, i) => {
          const toolCallId = `lane-${event.seq}-${i}`;
          const title = `edit ${workspace === undefined ? change.path : path.relative(workspace, change.path)}`;
          updates.push(
            { sessionUpdate: 'tool_call', toolCallId, title, kind: 'edit', status: 'in_progress', _meta: { [REPLAYED_AT_META]: ms(event.at) } },
            { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', _meta: { [REPLAYED_AT_META]: ms(event.at), [REPLAYED_CHANGE_META]: reviewed(change, status) } },
          );
        });
        updates.push(textUpdate(laneApplyText(event, event.changes.length)));
      }
      if (event.kind === 'user') updates.push(steerUpdate(event));
      if (event.kind === 'error') updates.push(textUpdate(errorText(event)));
      if (event.kind === 'background-end') {
        const { id, toolUseId, command, state } = event.job;
        updates.push(backgroundUpdate({ id, toolUseId, command, state, tail: event.tail }, { [REPLAYED_AT_META]: ms(event.at) }));
      }
    }
    return updates;
  });
}
