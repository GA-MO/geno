import { pathToFileURL } from 'node:url';
import type * as acp from '@agentclientprotocol/sdk';
import {
  APPROVAL_META,
  REPLAYED_AT_META,
  REPLAYED_CHANGE_META,
  REPLAYED_TURN_META,
  reviewState,
  toolResultText,
  type FileChange,
  type HunkId,
  type HunkStatus,
  type ReplayedTurn,
  type ToolResultEvent,
  type ToolStatus,
  type TurnErrorKind,
  type TurnEvent,
} from '@g-code/core';
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { EXECUTORS } from './tools/index.js';

type EventOf<K extends TurnEvent['kind']> = Extract<TurnEvent, { kind: K }>;

export const TOOL_KINDS: Readonly<Record<string, acp.ToolKind>> = {
  read: 'read',
  grep: 'search',
  glob: 'search',
  list: 'search',
  edit: 'edit',
  bash: 'execute',
  check: 'execute',
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
};

const titleOf = (use: ToolUseBlock): string => {
  if (Object.hasOwn(EXECUTORS, use.name)) return EXECUTORS[use.name as keyof typeof EXECUTORS].describe(use.input);
  return AGENT_TITLES[use.name]?.((use.input ?? {}) as Record<string, unknown>) ?? use.name;
};

export const textUpdate = (text: string): acp.SessionUpdate => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

/** A failure belongs in the transcript, and a notice is live status only, so it goes as agent text, live and replayed. */
export const errorText = (event: EventOf<'error'>): string => `\n\n[${event.error}] ${event.message}`;

/** A tool's result as its closing update, live and replayed; `meta` adds to the approval record a flagged command carries. */
export const toolResultUpdate = (event: ToolResultEvent, meta: Record<string, unknown> = {}): acp.SessionUpdate => {
  const all = { ...(event.approval === undefined ? {} : { [APPROVAL_META]: event.approval }), ...meta };
  return {
    sessionUpdate: 'tool_call_update',
    toolCallId: event.toolUseId,
    status: TOOL_STATUS[event.status],
    content: [
      { type: 'content', content: { type: 'text', text: toolResultText(event) } },
      ...(event.images ?? []).flatMap((image): acp.ToolCallContent[] =>
        image.path === undefined ? [] : [{ type: 'content', content: { type: 'resource_link', uri: pathToFileURL(image.path).href, name: image.name, mimeType: image.mediaType, size: image.bytes } }],
      ),
    ],
    ...(Object.keys(all).length === 0 ? {} : { _meta: all }),
  };
};

const ms = (iso: string): number => Date.parse(iso);

/** One prompt and everything logged until the next. */
type Run = { readonly prompt: EventOf<'user'>; readonly events: readonly TurnEvent[] };

function runsOf(events: readonly TurnEvent[]): Run[] {
  const runs: { prompt: EventOf<'user'>; events: TurnEvent[] }[] = [];
  for (const event of events) {
    if (event.kind === 'user') runs.push({ prompt: event, events: [] });
    else runs.at(-1)?.events.push(event);
  }
  return runs;
}

function turnOf({ prompt, events }: Run): ReplayedTurn {
  const answers = events.flatMap((e) => (e.kind === 'assistant' ? [e] : []));
  const error = events.findLast((e) => e.kind === 'error');
  const last = events.at(-1);
  return {
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
 * bookkeeping events are left out.
 */
export function replayUpdates(events: readonly TurnEvent[]): acp.SessionUpdate[] {
  const status = new Map(reviewState(events).map((hunk) => [hunk.id, hunk.status]));
  return runsOf(events).flatMap((run) => {
    const meta: ReplayedTurn = turnOf(run);
    const updates: acp.SessionUpdate[] = [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: run.prompt.content }, _meta: { [REPLAYED_TURN_META]: meta } },
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
          toolResultUpdate(event, {
            [REPLAYED_AT_META]: ms(event.at),
            ...(event.change === undefined ? {} : { [REPLAYED_CHANGE_META]: reviewed(event.change, status) }),
          }),
        );
      }
      if (event.kind === 'error') updates.push(textUpdate(errorText(event)));
    }
    return updates;
  });
}
