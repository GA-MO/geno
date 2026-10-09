import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as acp from '@agentclientprotocol/sdk';
import {
  APPROVAL_META,
  TURN_ERROR_META,
  COMPACT_META,
  compactMarkOf,
  compactNotice,
  spendOf,
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
  DISMISS_TASK_TOOL,
  parseDismissTask,
  parseSpawnTask,
  SPAWN_TASK_TOOL,
  SPINOFF_META,
  CHAPTER_META,
  SHOW_FILES_META,
  SHOW_FILES_TOOL,
  parseShowFilesInput,
  showFilesTitle,
  chaptersOf,
  MARK_CHAPTER_TOOL,
  parseChapterMark,
  userChapterAt,
  spinoffShownOf,
  spinoffsOf,
  type Spinoff,
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
  RECALL_TOOL,
  TODO_TOOL,
  todoLine,
  WIDGET_META,
  WIDGET_TOOL,
  type WidgetRef,
  reportMessageOf,
  REPORT_TOOL,
} from '@g-code/core';
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { EXECUTORS, namedTitle } from './tools/index.js';

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
  notebook_edit: 'edit',
  bash: 'execute',
  check: 'execute',
  web_fetch: 'fetch',
  web_search: 'fetch',
};

export const TOOL_STATUS: Readonly<Record<ToolStatus, acp.ToolCallStatus>> = { ok: 'completed', error: 'failed', denied: 'failed', rejected: 'failed' };

/** How a turn that ended in an error shows, as its live stop reason showed it: a stop, a failure, or an answer with the error in it. */
const ERROR_STATUS: Readonly<Record<TurnErrorKind, ReplayedTurn['status']>> = {
  abort: 'stopped',
  refusal: 'failed',
  blocked: 'failed',
  'max-turns': 'failed',
  budget: 'failed',
  transport: 'done',
  overflow: 'done',
};

/** A title of the tool's name and the input's words it names, skipping any the model left out. */
const titled = (name: string, ...words: readonly unknown[]): string => [name, ...words.flatMap((word) => (typeof word === 'string' || typeof word === 'number' ? [String(word)] : []))].join(' ');

/** The agent tools' own titles, which need their executors' environment, as they read live. */
const AGENT_TITLES: Readonly<Record<string, (input: Record<string, unknown>) => string>> = {
  edit: ({ path }) => `edit ${String(path)}`,
  bash: ({ command }) => `bash ${String(command)}`,
  check: () => 'check',
  [WIDGET_TOOL]: (input) => {
    const parsed = parseShowWidget(input);
    return parsed.ok ? `${WIDGET_TOOL} ${parsed.value.title}` : WIDGET_TOOL;
  },
  [RECALL_TOOL]: ({ query }) => `${RECALL_TOOL} ${String(query)}`,
  [TODO_TOOL]: (input) => {
    const parsed = parseTodo(input);
    return parsed.ok ? `${TODO_TOOL} ${todoLine(parsed.value)}` : TODO_TOOL;
  },
  [SPAWN_TASK_TOOL]: (input) => {
    const parsed = parseSpawnTask(input);
    return parsed.ok ? `${SPAWN_TASK_TOOL} ${parsed.value.title}` : SPAWN_TASK_TOOL;
  },
  [MARK_CHAPTER_TOOL]: (input) => {
    const parsed = parseChapterMark(input);
    return parsed.ok ? `${MARK_CHAPTER_TOOL} ${parsed.value.title}` : MARK_CHAPTER_TOOL;
  },
  [SHOW_FILES_TOOL]: (input) => {
    const parsed = parseShowFilesInput(input);
    return parsed.ok ? showFilesTitle(parsed.value) : SHOW_FILES_TOOL;
  },
  [DISMISS_TASK_TOOL]: (input) => {
    const parsed = parseDismissTask(input);
    return parsed.ok ? `${DISMISS_TASK_TOOL} ${parsed.value}` : DISMISS_TASK_TOOL;
  },
  ask_user: (input) => {
    const parsed = parseAskUser(input);
    return parsed.ok ? `ask_user ${askUserTitle(parsed.value)}` : 'ask_user';
  },
  remember: ({ scope }) => titled('remember', scope),
  skill: ({ name, args }) => titled('skill', name, args),
  tool_search: ({ select, query }) => titled('tool_search', ...(Array.isArray(select) ? select : []), ...(typeof query === 'string' ? [JSON.stringify(query)] : [])),
  task_stop: ({ id }) => titled('task_stop', id),
  bash_output: ({ id }) => titled('bash_output', id),
  monitor: ({ command, background_job_id, pattern }) => `monitor ${typeof command === 'string' ? command : String(background_job_id ?? '')} for /${String(pattern)}/`,
  schedule_wakeup: ({ delay_s, reason }) => `schedule_wakeup in ${String(delay_s)}s: ${String(reason)}`,
  web_fetch: ({ url }) => titled('web_fetch', url),
  web_search: ({ query }) => titled('web_search', query),
  agent: ({ agent, task }) => (typeof agent === 'string' && typeof task === 'string' ? `agent ${agent}: ${task.split('\n')[0]}` : 'agent'),
  message_agent: ({ agent_session, text }) => (typeof agent_session === 'string' && typeof text === 'string' ? `message_agent ${agent_session}: ${text.split('\n')[0]}` : 'message_agent'),
  notebook_edit: ({ notebook_path, cell_id, edit_mode }) => titled('notebook_edit', notebook_path, edit_mode ?? 'replace', cell_id),
  preview_start: ({ name }) => titled('preview_start', name),
  preview_stop: ({ name }) => titled('preview_stop', name),
  read_terminal: ({ terminal }) => titled('read_terminal', terminal),
  workflow: ({ name, input }) => (typeof name === 'string' ? `workflow ${name}${typeof input === 'string' && input !== '' ? `: ${input.split('\n')[0]}` : ''}` : 'workflow list'),
};

export const titleOf = (use: ToolUseBlock): string => {
  if (Object.hasOwn(EXECUTORS, use.name)) return namedTitle(use.name, EXECUTORS[use.name as keyof typeof EXECUTORS].describe(use.input));
  return AGENT_TITLES[use.name]?.((use.input ?? {}) as Record<string, unknown>) ?? use.name;
};

export const textUpdate = (text: string): acp.SessionUpdate => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

/** A compaction as the divider the panel draws, live and replayed; its text says the same in words for other clients. */
export const compactUpdate = (event: EventOf<'compact'>): acp.SessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text: compactNotice(event) },
  _meta: { [COMPACT_META]: compactMarkOf(event) },
});

/** What the user typed to compact by hand, as its turn shows it: `/compact` and the focus. */
export const compactPrompt = (event: EventOf<'compact'>): EventOf<'user'> => ({
  kind: 'user',
  seq: event.seq,
  at: event.at,
  content: event.focus === undefined ? '/compact' : `/compact ${event.focus}`,
  command: { name: 'compact', args: event.focus ?? '' },
});

/** A failure belongs in the transcript, and a notice is live status only, so it goes as agent text, live and replayed. */
export const errorUpdate = (event: EventOf<'error'>): acp.SessionUpdate => ({
  ...textUpdate(`\n\n[${event.error}] ${event.message}`),
  _meta: { [TURN_ERROR_META]: { error: event.error, message: event.message } },
});

/** A stored widget as the editor gets it: the file's address, and its html unless the file is gone. */
export type ShownWidget = { readonly uri: string; readonly html: string | undefined };

/** No widget files at hand, as for a log replayed without its attachments folder. */
const NO_WIDGETS = (): ShownWidget => ({ uri: '', html: undefined });

/**
 * A tool's result as its closing update, live and replayed; `meta` adds to the approval record a flagged command
 * carries. A widget's html goes along as an embedded resource, its reference under WIDGET_META.
 */
export const toolResultUpdate = (event: ToolResultEvent, meta: Record<string, unknown> = {}, widget?: ShownWidget, spinoffs?: readonly Spinoff[]): acp.SessionUpdate => {
  const all = {
    ...(event.spinoff === undefined || event.status !== 'ok' ? {} : { [SPINOFF_META]: spinoffShownOf(event.toolUseId, event.spinoff, spinoffs) }),
    ...(event.approval === undefined ? {} : { [APPROVAL_META]: event.approval }),
    ...(event.widget === undefined ? {} : { [WIDGET_META]: event.widget }),
    ...(event.editorAction === undefined ? {} : { [EDITOR_ACTION_META]: event.editorAction }),
    ...(event.todo === undefined ? {} : { [TODO_META]: { items: event.todo } }),
    ...(event.chapter === undefined || event.status !== 'ok' ? {} : { [CHAPTER_META]: event.chapter }),
    ...(event.shown === undefined ? {} : { [SHOW_FILES_META]: event.shown }),
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
    // So is /compact between turns; a compaction inside a turn stays in that turn, where it happened.
    else if (event.kind === 'compact' && event.trigger === 'manual') runs.push({ prompt: compactPrompt(event), mode, events: [event] });
    else runs.at(-1)?.events.push(event);
  }
  return runs;
}

/** What is logged after a turn ended without being part of it: background reports, and the user's settings and decisions. */
const LOGGED_AROUND_TURNS: ReadonlySet<TurnEvent['kind']> = new Set(['background-end', 'child-end', 'wake', 'mode', 'effort', 'backend-model', 'title', 'review', 'spinoff', 'chapter']);

/** A turn the user started with a prompt, as opposed to a lane apply or a /compact, which have no prompt to rewind to. */
const isPromptRun = (events: readonly TurnEvent[]): boolean => events[0]?.kind !== 'lane-apply' && !(events[0]?.kind === 'compact' && events[0].trigger === 'manual');

function turnOf({ prompt, mode, events }: Run): ReplayedTurn {
  const answers = events.flatMap((e) => spendOf(e) ?? []);
  const error = events.findLast((e) => e.kind === 'error');
  // Background work may report long after its turn ended, for a woken turn to take, and the user decides things between
  // turns; the turn ended with its own last event.
  const last = events.findLast((e) => !LOGGED_AROUND_TURNS.has(e.kind) && triggerOf(e) === undefined);
  return {
    ...(isPromptRun(events) ? { seq: prompt.seq } : {}),
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
  const spinoffs = spinoffsOf(events);
  const chapters = chaptersOf(events);
  const start = events[0];
  const workspace = start?.kind === 'session-start' ? start.session.workspace : undefined;
  return runsOf(events).flatMap((run) => {
    const meta: ReplayedTurn = turnOf(run);
    const chapter = meta.seq === undefined ? undefined : userChapterAt(chapters, meta.seq);
    const updates: acp.SessionUpdate[] = [
      {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: run.prompt.content },
        _meta: { [REPLAYED_TURN_META]: meta, ...wakeMetaOf(run.prompt), ...(chapter === undefined ? {} : { [CHAPTER_META]: { title: chapter.title, ...(chapter.summary === undefined ? {} : { summary: chapter.summary }) } }) },
      },
    ];
    for (const event of run.events) {
      if (event.kind === 'assistant') {
        for (const block of event.content) {
          if (block.type === 'text' && block.text !== '') updates.push(textUpdate(block.text));
          const reported = block.type === 'tool_use' ? reportMessageOf(block) : undefined;
          // A subagent's report shows as its text, where the user reads its answer.
          if (reported !== undefined) updates.push(textUpdate(reported));
          else if (block.type === 'tool_use') {
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
      if (event.kind === 'tool-result' && event.name !== REPORT_TOOL) {
        updates.push(
          toolResultUpdate(
            event,
            {
              [REPLAYED_AT_META]: ms(event.at),
              ...(event.change === undefined ? {} : { [REPLAYED_CHANGE_META]: reviewed(event.change, status) }),
            },
            event.widget === undefined ? undefined : widgetOf(event.widget),
            spinoffs,
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
      if (event.kind === 'compact') updates.push(compactUpdate(event));
      if (event.kind === 'error') updates.push(errorUpdate(event));
      if (event.kind === 'background-end') {
        const { id, toolUseId, command, preview, state } = event.job;
        updates.push(backgroundUpdate({ id, toolUseId, command, ...(preview === undefined ? {} : { preview }), state, tail: event.tail }, { [REPLAYED_AT_META]: ms(event.at) }));
      }
    }
    return updates;
  });
}
