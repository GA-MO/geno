import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { parseArgs } from 'node:util';
import * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import {
  BASE_HASH_META,
  CHECKPOINT_TEXT_METHOD,
  DIAGNOSTICS_CAPABILITY,
  DIAGNOSTICS_METHOD,
  HUNK_STATUSES,
  INLINE_EDIT_META,
  nextSeq,
  REVIEW_METHOD,
  reviewState,
  REWIND_METHOD,
  SEVERITIES,
  spillNotice,
  STALE_BASE_ERROR,
  TOOL_CALL_META,
  TURN_USAGE_META,
  UNSAVED_BUFFERS_CAPABILITY,
  UNSAVED_BUFFERS_METHOD,
  addUsage,
  type CheckpointTextResponse,
  type PermissionInput,
  type TokenUsage,
  type TurnUsage,
  type DiagnosticsRequest,
  type DoneReason,
  type HunkId,
  type ReviewDecision,
  type ReviewResponse,
  type RewindResponse,
  type ToolStatus,
  type ContextItem,
  type Mention,
  type TurnEvent,
  type UnsavedBuffersRequest,
} from '@g-code/core';
import { LIMIT_FLAGS, limitsOf, runAgent } from './agent.js';
import { openSessionLog, resumeSession, startSession, type OpenSession } from './chat.js';
import { fileAt, shadowRepoFor } from './checkpoints.js';
import { UsageError, type Command, type Io } from './command.js';
import { workspaceDir, type Limits, type Surface } from './drive.js';
import { DISK_FILES, type Files } from './files.js';
import { runInlineEdit } from './inline.js';
import { contextItems, MentionError, mentionsOf } from './mentions.js';
import { checkpointsOf, rewindTo } from './rewind.js';
import { appendEvent, dropTornTail } from './sessions.js';
import { guardStdout } from './stdout-guard.js';
import type { Store } from './store.js';
import type { Approver, Diagnostics } from './tools/agent.js';
import { ToolError } from './tools/context.js';
import { ruleAttacher } from './tools/rules.js';

const RESOURCE_NOT_FOUND = -32002;

const STOP_REASONS: Readonly<Record<DoneReason, acp.StopReason>> = {
  end_turn: 'end_turn',
  'max-turns': 'max_turn_requests',
  // ACP has no budget stop; the turn limit is the nearest, and the logged error says which it was.
  budget: 'max_turn_requests',
  refusal: 'refusal',
  error: 'end_turn',
};

const TOOL_STATUS: Readonly<Record<ToolStatus, acp.ToolCallStatus>> = { ok: 'completed', error: 'failed', denied: 'failed' };

const TOOL_KINDS: Readonly<Record<string, acp.ToolKind>> = {
  read: 'read',
  grep: 'search',
  glob: 'search',
  list: 'search',
  edit: 'edit',
  bash: 'execute',
  check: 'execute',
};

const PERMISSION_OPTIONS: acp.PermissionOption[] = [
  { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

const unsavedBuffersResponse = z.object({ buffers: z.array(z.object({ path: z.string(), text: z.string() })) });

const diagnosticsResponse = z.object({
  diagnostics: z.array(
    z.object({
      path: z.string(),
      line: z.number().int().positive(),
      character: z.number().int().positive(),
      severity: z.enum(SEVERITIES),
      message: z.string(),
      source: z.string().nullable(),
    }),
  ),
});

type Peer = { readonly files: boolean; readonly diagnostics: boolean; readonly unsaved: boolean; readonly notices: boolean };

type Updates = { send(update: acp.SessionUpdate): void; flush(): Promise<void> };

/** Session updates in order. Notifications are fire-and-forget for the loop, but must all precede the turn's response. */
function updates(client: acp.AgentContext, sessionId: string, io: Io): Updates {
  let sent = Promise.resolve();
  return {
    send(update) {
      sent = sent
        .then(() => client.notify(acp.methods.client.session.update, { sessionId, update }))
        .catch((error: unknown) => io.err(`session/update failed: ${String(error)}`));
    },
    flush: () => sent,
  };
}

const textUpdate = (text: string): acp.SessionUpdate => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

type EventOf<K extends TurnEvent['kind']> = Extract<TurnEvent, { kind: K }>;

const RETRY_REASONS: readonly (readonly [RegExp, string])[] = [
  [/overload|capacity|high demand|\b529\b/i, 'model overloaded'],
  [/rate.?limit|too many requests|\b429\b/i, 'rate limited'],
  [/timed? ?out|timeout/i, 'timed out'],
  [/connect|network|socket|fetch failed|ECONNRESET|EAI_AGAIN|closed|terminated|ended/i, 'connection dropped'],
];

/** The few words a status line gives for why a call is retried; the full message goes in the notice's description. */
export const retryReason = (message: string): string => RETRY_REASONS.find(([pattern]) => pattern.test(message))?.[1] ?? 'server error';

const LOGGED: { readonly [K in TurnEvent['kind']]?: (event: EventOf<K>, peer: Peer) => acp.SessionUpdate | undefined } = {
  'tool-result': (event) => ({
    sessionUpdate: 'tool_call_update',
    toolCallId: event.toolUseId,
    status: TOOL_STATUS[event.status],
    content: [{ type: 'content', content: { type: 'text', text: 'spill' in event ? spillNotice(event.spill) : event.output } }],
  }),
  // ACP's notices are unstable, so a failure reaches the user as agent text, as the spec suggests.
  error: (event) => textUpdate(`\n\n[${event.error}] ${event.message}`),
  // A retry is live status, not history, which is what a notice is; a client without notices hears only the outcome.
  retry: ({ delayMs, message }, peer) =>
    peer.notices
      ? { sessionUpdate: 'notice', severity: 'warning', title: `Retrying in ${Math.round(delayMs / 1000)}s (${retryReason(message)})`, description: message }
      : undefined,
};

function loggedUpdate<K extends TurnEvent['kind']>(event: EventOf<K>, peer: Peer): acp.SessionUpdate | undefined {
  return (LOGGED[event.kind] as ((e: EventOf<K>, peer: Peer) => acp.SessionUpdate | undefined) | undefined)?.(event, peer);
}

/** The editor's buffers, through ACP's client file system. `writer` names the tool call a write belongs to. */
function editorFiles(client: acp.AgentContext, sessionId: string, peer: Peer, writer: () => acp.ToolCallId): Files {
  const failure = (verb: string, file: string, error: unknown) =>
    new ToolError(`the editor could not ${verb} ${file}: ${error instanceof Error ? error.message : String(error)}`);
  return {
    async read(file) {
      try {
        return (await client.request(acp.methods.client.fs.readTextFile, { sessionId, path: file })).content;
      } catch (error) {
        if (error instanceof acp.RequestError && error.code === RESOURCE_NOT_FOUND) return null;
        throw failure('read', file, error);
      }
    },
    async write(file, text, baseHash) {
      try {
        await client.request(acp.methods.client.fs.writeTextFile, {
          sessionId,
          path: file,
          content: text,
          _meta: { [BASE_HASH_META]: baseHash, [TOOL_CALL_META]: writer() },
        });
        return 'written';
      } catch (error) {
        if (error instanceof acp.RequestError && error.code === STALE_BASE_ERROR.code) return 'stale-base';
        throw failure('write', file, error);
      }
    },
    async unsaved() {
      if (!peer.unsaved) return [];
      const raw = await client.request<unknown, UnsavedBuffersRequest>(UNSAVED_BUFFERS_METHOD, { sessionId });
      const parsed = unsavedBuffersResponse.safeParse(raw);
      if (!parsed.success) throw new ToolError(`the editor sent malformed buffers: ${z.prettifyError(parsed.error)}`);
      return parsed.data.buffers;
    },
  };
}

function editorDiagnostics(client: acp.AgentContext, sessionId: string): Diagnostics {
  return async (paths) => {
    const raw = await client.request<unknown, DiagnosticsRequest>(DIAGNOSTICS_METHOD, { sessionId, paths });
    const parsed = diagnosticsResponse.safeParse(raw);
    if (!parsed.success) throw new ToolError(`the editor sent malformed diagnostics: ${z.prettifyError(parsed.error)}`);
    return parsed.data.diagnostics;
  };
}

type Turn = {
  readonly surface: Surface;
  readonly approve: Approver;
  readonly updates: Updates;
  /** What the turn's model calls used so far, for the prompt response; nothing before the first call. */
  usage(): Pick<acp.PromptResponse, 'usage' | '_meta'>;
};

type Spent = { readonly tokens: TokenUsage; readonly model: string; readonly costUsd: number | null };

function usageOf(spent: Spent | undefined): Pick<acp.PromptResponse, 'usage' | '_meta'> {
  if (spent === undefined) return {};
  const { tokens, model, costUsd } = spent;
  const usage: acp.Usage = {
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cachedReadTokens: tokens.cacheRead,
    cachedWriteTokens: tokens.cacheWrite,
    totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
  };
  const meta: TurnUsage = { model, costUsd };
  return { usage, _meta: { [TURN_USAGE_META]: meta } };
}

/** One prompt turn's view of the editor: what the loop shows, reads and writes, and asks permission for. */
function editorTurn(client: acp.AgentContext, sessionId: string, peer: Peer, io: Io): Turn {
  const sent = updates(client, sessionId, io);
  // Tools run one at a time, so the last one started is the one asking or writing.
  let running: acp.ToolCallId = '';
  let spent: Spent | undefined;
  return {
    updates: sent,
    usage: () => usageOf(spent),
    surface: {
      files: peer.files ? editorFiles(client, sessionId, peer, () => running) : DISK_FILES,
      watcher: {
        text: (delta) => sent.send(textUpdate(delta)),
        toolStart(use, title) {
          running = use.id;
          sent.send({ sessionUpdate: 'tool_call', toolCallId: use.id, title, kind: TOOL_KINDS[use.name] ?? 'other', status: 'in_progress', rawInput: use.input });
        },
        toolEnd(use, status) {
          sent.send({ sessionUpdate: 'tool_call_update', toolCallId: use.id, status: TOOL_STATUS[status] });
        },
        logged(event) {
          if (event.kind === 'assistant') {
            spent = {
              tokens: spent === undefined ? event.usage : addUsage(spent.tokens, event.usage),
              model: event.model,
              costUsd: spent?.costUsd === null || event.costUsd === null ? null : (spent?.costUsd ?? 0) + event.costUsd,
            };
          }
          const update = loggedUpdate(event, peer);
          if (update !== undefined) sent.send(update);
        },
      },
    },
    async approve(denial) {
      await sent.flush();
      const rawInput: PermissionInput = { command: denial.command, reason: denial.reason };
      const { outcome } = await client.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: running, title: `Allow \`${denial.command}\`? It uses ${denial.reason}.`, kind: 'execute', status: 'pending', rawInput },
        options: PERMISSION_OPTIONS,
      });
      return outcome.outcome === 'selected' && outcome.optionId === 'allow';
    },
  };
}

const promptText = (blocks: readonly acp.ContentBlock[]): string =>
  blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();

const reviewRequest = z.object({
  sessionId: z.string(),
  decisions: z.array(z.object({ hunk: z.string().min(1).transform((raw) => raw as HunkId), status: z.enum(HUNK_STATUSES) })),
});
const checkpointTextRequest = z.object({ sessionId: z.string(), path: z.string() });
const rewindRequest = z.object({ sessionId: z.string() });
const inlineEditTarget = z
  .object({ path: z.string().min(1), startLine: z.number().int().positive(), endLine: z.number().int().positive() })
  .refine((t) => t.startLine <= t.endLine, 'startLine must not be after endLine');

function parsedMentions(sessionId: string, blocks: readonly acp.ContentBlock[]): Mention[] {
  try {
    return mentionsOf(blocks);
  } catch (error) {
    if (error instanceof MentionError) throw acp.RequestError.invalidParams({ sessionId }, error.message);
    throw error;
  }
}

async function logPrompt(opened: OpenSession, content: string, mentions: readonly Mention[], files: Files, sessionId: string): Promise<OpenSession> {
  const { log } = opened;
  let context: ContextItem[];
  try {
    context = await contextItems(mentions, await workspaceDir(log.session.workspace, '.'), files, ruleAttacher(log.events));
  } catch (error) {
    if (error instanceof MentionError || error instanceof ToolError) throw acp.RequestError.invalidParams({ sessionId }, error.message);
    throw error;
  }
  const event: TurnEvent = { kind: 'user', seq: nextSeq(log.events), at: new Date().toISOString(), content, context };
  await appendEvent(log.file, event);
  return { ...opened, log: { ...log, events: [...log.events, event] } };
}

async function appendDecisions(store: Store, io: Io, sessionId: string, decisions: readonly ReviewDecision[]): Promise<void> {
  if (decisions.length === 0) return;
  const log = await openSessionLog(store, sessionId, io);
  await dropTornTail(log);
  const at = new Date().toISOString();
  let seq = nextSeq(log.events);
  for (const { hunk, status } of decisions) await appendEvent(log.file, { kind: 'review', seq: seq++, at, hunk, status });
}

/** The engine as an ACP agent. Each prompt runs `gcode agent`'s loop on the session's log, or a one-shot inline edit. */
export function gcodeAgent(io: Io, store: Store, limits: Limits): acp.AgentApp {
  let peer: Peer = { files: false, diagnostics: false, unsaved: false, notices: false };
  const turns = new Map<string, AbortController | undefined>();
  // A turn and a review decision both append to the session log and number their events from what they read,
  // so each session's writers take turns.
  const writers = new Map<string, Promise<unknown>>();
  const serially = <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const next = (writers.get(sessionId) ?? Promise.resolve()).then(work, work);
    writers.set(sessionId, next.catch(() => {}));
    return next;
  };
  const known = (sessionId: string) => {
    if (!turns.has(sessionId)) throw acp.RequestError.invalidParams({ sessionId }, `no session ${sessionId}`);
  };

  return acp
    .agent({ name: 'gcode' })
    .onRequest(acp.methods.agent.initialize, ({ params }) => {
      const { fs, _meta, session } = params.clientCapabilities ?? {};
      peer = {
        files: fs?.readTextFile === true && fs.writeTextFile === true,
        diagnostics: _meta?.[DIAGNOSTICS_CAPABILITY] === true,
        unsaved: _meta?.[UNSAVED_BUFFERS_CAPABILITY] === true,
        notices: session?.notices != null,
      };
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false, sessionCapabilities: { resume: {} }, promptCapabilities: { embeddedContext: true } },
        agentInfo: { name: 'gcode', version: '0.0.0' },
      };
    })
    .onRequest(acp.methods.agent.session.new, async ({ params }) => {
      const workspace = await workspaceDir(io.cwd, params.cwd);
      const opened = await startSession(store, io, { workspace, provider: undefined, model: undefined, effort: undefined });
      const { id } = opened.log.session;
      turns.set(id, undefined);
      io.err(`session: ${id} log: ${opened.log.file}`);
      return { sessionId: id };
    })
    .onRequest(acp.methods.agent.session.resume, async ({ params }) => {
      const log = await openSessionLog(store, params.sessionId, io).catch((error: unknown) => {
        throw acp.RequestError.resourceNotFound(`session ${params.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      });
      if (!turns.has(log.session.id)) turns.set(log.session.id, undefined);
      io.err(`session: ${log.session.id} resumed, log: ${log.file}`);
      return {};
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const { sessionId } = params;
      known(sessionId);
      if (turns.get(sessionId) !== undefined) throw acp.RequestError.invalidRequest({ sessionId }, 'a turn is already running');
      const text = promptText(params.prompt);
      if (text === '') throw acp.RequestError.invalidParams({ sessionId }, 'the prompt has no text');
      const mentions = parsedMentions(sessionId, params.prompt);
      const rawTarget = params._meta?.[INLINE_EDIT_META];
      const target = rawTarget === undefined ? undefined : inlineEditTarget.safeParse(rawTarget);
      if (target?.success === false) throw acp.RequestError.invalidParams({ sessionId }, `${INLINE_EDIT_META}: ${z.prettifyError(target.error)}`);

      const controller = new AbortController();
      turns.set(sessionId, controller);
      const turn = editorTurn(client, sessionId, peer, io);
      const turnIo = { ...io, interrupts: () => controller.signal };
      const diagnostics = peer.diagnostics ? editorDiagnostics(client, sessionId) : undefined;
      try {
        return await serially(sessionId, async () => {
          const resumed = await resumeSession(store, io, sessionId);
          // A prompt with mentions is logged here, with what they showed, and the loop answers it as a pending prompt.
          const opened = target === undefined && mentions.length > 0 ? await logPrompt(resumed, text, mentions, turn.surface.files, sessionId) : resumed;
          const prompt = opened === resumed ? text : '';
          const result =
            target === undefined
              ? await runAgent(turnIo, store, opened, prompt, {
                  limits,
                  check: undefined,
                  checkAfterEdit: true,
                  approval: { mode: 'interactive', approve: turn.approve },
                  surface: turn.surface,
                  diagnostics,
                })
              : await runInlineEdit(turnIo, store, opened, target.data, text, { maxCostUsd: limits.maxCostUsd, surface: turn.surface, diagnostics });
          await turn.updates.flush();
          return { stopReason: controller.signal.aborted ? 'cancelled' : STOP_REASONS[result.reason], ...turn.usage() };
        });
      } finally {
        turns.set(sessionId, undefined);
      }
    })
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      turns.get(params.sessionId)?.abort();
    })
    .onRequest(REVIEW_METHOD, reviewRequest, async ({ params }): Promise<ReviewResponse> => {
      known(params.sessionId);
      return serially(params.sessionId, async () => {
        await appendDecisions(store, io, params.sessionId, params.decisions);
        return { hunks: reviewState((await openSessionLog(store, params.sessionId, io)).events) };
      });
    })
    .onRequest(CHECKPOINT_TEXT_METHOD, checkpointTextRequest, async ({ params }): Promise<CheckpointTextResponse> => {
      known(params.sessionId);
      const log = await openSessionLog(store, params.sessionId, io);
      const first = checkpointsOf(log.events)[0];
      const file = await realpath(params.path).catch(() => params.path);
      const relative = path.relative(log.session.workspace, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw acp.RequestError.invalidParams({ path: params.path }, 'outside the workspace');
      if (first === undefined) return { text: await DISK_FILES.read(file) };
      return { text: await fileAt(shadowRepoFor(store, log.session.workspace), first.sha, relative) };
    })
    .onRequest(REWIND_METHOD, rewindRequest, async ({ params }): Promise<RewindResponse> => {
      const { sessionId } = params;
      known(sessionId);
      if (turns.get(sessionId) !== undefined) throw acp.RequestError.invalidRequest({ sessionId }, 'stop the running turn before undoing the session');
      return serially(sessionId, async () => {
        const log = await openSessionLog(store, sessionId, io);
        const first = checkpointsOf(log.events)[0];
        if (first === undefined) return { files: [] };
        const { files } = await rewindTo(store, log, first.turnSeq);
        return { files: files.map((file) => path.join(log.session.workspace, file)) };
      });
    });
}

export const serve: Command = async (args, { io, store }) => {
  const { values } = parseArgs({ args, strict: true, options: { stdio: { type: 'boolean', default: false }, ...LIMIT_FLAGS } });
  if (!values.stdio) throw new UsageError('serve needs --stdio, the only transport');
  // stdout carries the protocol, so everything the engine prints goes to stderr, and so does anything a dependency prints.
  const quiet: Io = { ...io, out: io.err, write: () => {} };
  const stream = acp.ndJsonStream(guardStdout(), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
  const connection = gcodeAgent(quiet, store, limitsOf(values)).connect(stream);
  quiet.err(`gcode serve: ACP v${acp.PROTOCOL_VERSION} on stdio, sessions in ${store.sessionsDir}`);
  await connection.closed;
  return 0;
};
