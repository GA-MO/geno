import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
  RENAME_SESSION_METHOD,
  SESSION_SUMMARY_META,
  summarizeSession,
  titleFrom,
  titleOf,
  type SessionScope,
  type SessionSummary,
  type SessionSummaryMeta,
  APPROVAL_META,
  approvalQuestion,
  DEFAULT_SESSION_MODE,
  isMcpRule,
  isSessionMode,
  MCP_ENABLE_METHOD,
  MCP_SERVERS_METHOD,
  MCP_TRUST_METHOD,
  type McpServersResponse,
  SESSION_MODES,
  sessionEffortOf,
  contextUseOf,
  lastContextUse,
  type Session,
  sessionModeOf,
  type SessionMode,
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
  type Attachment,
  type ContextItem,
  type Expansion,
  type Mention,
  type TurnEvent,
  type UnsavedBuffersRequest,
  appliedRules,
  askUserAnswerOf,
  askUserForm,
  askUserMessage,
  ASK_USER_META,
  GLOBAL_RULES_METHOD,
  MEMORY_CAPABILITY,
  MEMORY_DELETE_METHOD,
  MEMORY_EDIT_METHOD,
  MEMORY_METHOD,
  REMEMBER_META,
  RULES_METHOD,
  type AskUserReply,
  type AskUserRequest,
  type GlobalRulesResponse,
  type MemoryResponse,
  type RulesResponse,
} from '@g-code/core';
import { LIMIT_FLAGS, limitsOf, runAgent } from './agent.js';
import { AttachmentError, attachmentsDir, incomingAttachments, storeAttachments, type Incoming } from './attachments.js';
import { openSessionLog, resumeSession, startSession, type OpenSession } from './chat.js';
import { fileAt, shadowRepoFor } from './checkpoints.js';
import { commandClassifier } from './classifier.js';
import { homeOf, homesOf, runBuiltin, sessionCommands } from './commands.js';
import { MemoryError, memoryStore } from './memory.js';
import { ensureGlobalRules, globalRulesFile } from './project-context.js';
import { UsageError, type Command, type Io } from './command.js';
import { workspaceDir, type Limits, type Surface } from './drive.js';
import { DISK_FILES, type Files } from './files.js';
import { runInlineEdit } from './inline.js';
import { contextItems, MentionError, mentionsOf } from './mentions.js';
import { checkpointsOf, rewindTo } from './rewind.js';
import { browserLauncherOf, browserSettingsOf } from './mcp/browser.js';
import { mcpSessions, type McpSessions } from './mcp/sessions.js';
import { appendEvent, dropTornTail, logEffort, logMode } from './sessions.js';
import { chosenEffort, effortConfigOptions } from './effort-option.js';
import { usageUpdate } from './usage-update.js';
import { errorText, replayUpdates, textUpdate, TOOL_KINDS, TOOL_STATUS, toolResultUpdate } from './session-replay.js';
import { listSessions, renameSession, trashSession } from './history.js';
import { guardStdout } from './stdout-guard.js';
import type { Store } from './store.js';
import type { Approval, Approver, Diagnostics, PermissionAnswer } from './tools/agent.js';
import { ToolError } from './tools/context.js';
import { ruleAttacher } from './tools/rules.js';
import type { UserChannel } from './tools/user.js';

const RESOURCE_NOT_FOUND = -32002;

const STOP_REASONS: Readonly<Record<DoneReason, acp.StopReason>> = {
  end_turn: 'end_turn',
  'max-turns': 'max_turn_requests',
  // ACP has no budget stop; the turn limit is the nearest, and the logged error says which it was.
  budget: 'max_turn_requests',
  refusal: 'refusal',
  error: 'end_turn',
};

const PERMISSION_OPTIONS: acp.PermissionOption[] = [
  { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

// An MCP tool can also be allowed for the rest of the session.
const MCP_PERMISSION_OPTIONS: acp.PermissionOption[] = [
  PERMISSION_OPTIONS[0]!,
  { optionId: 'allow-session', name: 'Allow this tool for the session', kind: 'allow_always' },
  PERMISSION_OPTIONS[1]!,
];
const PERMISSION_ANSWERS: Readonly<Record<string, PermissionAnswer>> = { allow: 'allow', 'allow-session': 'allow-session' };

const SESSION_MODE_INFO: Readonly<Record<SessionMode, Omit<acp.SessionMode, 'id'>>> = {
  plan: { name: 'Plan', description: 'Read the code and plan the change without changing anything.' },
  ask: { name: 'Ask', description: 'Ask before risky commands.' },
  auto: {
    name: 'Auto',
    description: 'Run safe commands on its own and let a classifier judge the rest. Still asks before deleting the workspace, pushing, downloading, or touching paths outside it.',
  },
};

const modeState = (mode: SessionMode): acp.SessionModeState => ({
  currentModeId: mode,
  availableModes: SESSION_MODES.map((id) => ({ id, ...SESSION_MODE_INFO[id] })),
});

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

type Peer = {
  readonly files: boolean;
  readonly diagnostics: boolean;
  readonly unsaved: boolean;
  readonly notices: boolean;
  /** It answers ACP form elicitations, which carry ask_user's questions. */
  readonly elicitation: boolean;
  /** It shows a remember question as a memory card with the exact text. */
  readonly memory: boolean;
};

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


type EventOf<K extends TurnEvent['kind']> = Extract<TurnEvent, { kind: K }>;

const RETRY_REASONS: readonly (readonly [RegExp, string])[] = [
  [/overload|capacity|high demand|\b529\b/i, 'model overloaded'],
  [/rate.?limit|too many requests|\b429\b/i, 'rate limited'],
  [/timed? ?out|timeout/i, 'timed out'],
  [/connect|network|socket|fetch failed|ECONNRESET|EAI_AGAIN|closed|terminated|ended/i, 'connection dropped'],
];

/** The few words a status line gives for why a call is retried; the full message goes in the notice's description. */
const retryReason = (message: string): string => RETRY_REASONS.find(([pattern]) => pattern.test(message))?.[1] ?? 'server error';

const LOGGED: { readonly [K in TurnEvent['kind']]?: (event: EventOf<K>, peer: Peer) => acp.SessionUpdate | undefined } = {
  'tool-result': (event) => toolResultUpdate(event),
  error: (event) => textUpdate(errorText(event)),
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
  readonly user: UserChannel;
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

/**
 * One prompt turn's view of the editor: what the loop shows, reads and writes, and asks permission for. `session`
 * is known once the turn opened the log, before its first model call.
 */
function editorTurn(client: acp.AgentContext, sessionId: string, peer: Peer, io: Io, session: () => Session | undefined): Turn {
  const sent = updates(client, sessionId, io);
  // Tools run one at a time, so the last one started is the one asking or writing.
  let running: acp.ToolCallId = '';
  let spent: Spent | undefined;
  return {
    updates: sent,
    user: editorUser(client, sessionId, peer, () => sent.flush(), () => running),
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
          const opened = session();
          if (event.kind === 'assistant' && opened !== undefined && spent !== undefined) {
            sent.send(usageUpdate(contextUseOf(opened.provider, opened.model, event.usage), { model: spent.model, costUsd: spent.costUsd }));
          }
        },
      },
    },
    async approve(denial, classifier) {
      await sent.flush();
      const rawInput: PermissionInput = { command: denial.command, reason: denial.reason };
      const { outcome } = await client.request(acp.methods.client.session.requestPermission, {
        sessionId,
        toolCall: { toolCallId: running, title: approvalQuestion(denial, classifier), kind: isMcpRule(denial.rule) ? 'other' : 'execute', status: 'pending', rawInput },
        options: isMcpRule(denial.rule) ? MCP_PERMISSION_OPTIONS : PERMISSION_OPTIONS,
      });
      return (outcome.outcome === 'selected' && PERMISSION_ANSWERS[outcome.optionId]) || 'reject';
    },
  };
}

const REMEMBER_OPTIONS: acp.PermissionOption[] = [
  { optionId: 'allow', name: 'Remember', kind: 'allow_once' },
  { optionId: 'reject', name: "Don't remember", kind: 'reject_once' },
];

const SCOPE_WORDS = { project: 'in this project', global: 'in every project' } as const;

const elicitationAnswer = z.looseObject({ action: z.string(), content: z.record(z.string(), z.unknown()).nullish() });

/** The user's reply to an ask_user form: the answers it holds; anything but an accept with an answer declines. */
function askUserReplyOf(request: AskUserRequest, raw: unknown): AskUserReply {
  const parsed = elicitationAnswer.safeParse(raw);
  if (!parsed.success || parsed.data.action !== 'accept') return { kind: 'declined' };
  return askUserAnswerOf(request, parsed.data.content ?? {});
}

/** The cards this editor can show: a remember question with its exact text, and an ask_user question as a form. */
function editorUser(client: acp.AgentContext, sessionId: string, peer: Peer, flush: () => Promise<void>, running: () => acp.ToolCallId): UserChannel {
  return {
    ...(peer.memory
      ? {
          async remember(input, signal) {
            await flush();
            const { outcome } = await client.request(
              acp.methods.client.session.requestPermission,
              {
                sessionId,
                toolCall: { toolCallId: running(), title: `Remember this ${SCOPE_WORDS[input.scope]}?`, kind: 'other', status: 'pending', rawInput: input, _meta: { [REMEMBER_META]: input } },
                options: REMEMBER_OPTIONS,
              },
              { cancellationSignal: signal },
            );
            return outcome.outcome === 'selected' && outcome.optionId === 'allow';
          },
        }
      : {}),
    ...(peer.elicitation
      ? {
          async ask_user(request, signal) {
            await flush();
            const elicitation = {
              mode: 'form' as const,
              sessionId,
              toolCallId: running(),
              message: askUserMessage(request),
              requestedSchema: askUserForm(request),
              _meta: { [ASK_USER_META]: request },
            };
            try {
              return askUserReplyOf(request, await client.request(acp.methods.client.elicitation.create, elicitation, { cancellationSignal: signal }));
            } catch (error) {
              // An editor that advertised forms but cannot show this one: the model asks in plain words instead.
              if (signal.aborted) throw error;
              return { kind: 'unshown' };
            }
          },
        }
      : {}),
  };
}

const sessionInfo = (summary: SessionSummary): acp.SessionUpdate => ({ sessionUpdate: 'session_info_update', title: summary.title, updatedAt: summary.updatedAt });

function sessionInfoOf(summary: SessionSummary): acp.SessionInfo {
  const meta: SessionSummaryMeta = { turns: summary.turns, costUsd: summary.costUsd, createdAt: summary.createdAt };
  return { sessionId: summary.id, cwd: summary.workspace, title: summary.title, updatedAt: summary.updatedAt, _meta: { [SESSION_SUMMARY_META]: meta } };
}

const renameRequest = z.object({ sessionId: z.string(), title: z.string() });

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
const mcpServersRequest = z.object({ sessionId: z.string() });
const mcpTrustRequest = z.object({ sessionId: z.string(), name: z.string().min(1), hash: z.string().min(1) });
const mcpEnableRequest = z.object({ sessionId: z.string(), name: z.string().min(1), enabled: z.boolean() });
const sessionRequest = z.object({ sessionId: z.string() });
const memoryEditRequest = z.object({ sessionId: z.string(), id: z.string().min(1), text: z.string() });
const memoryDeleteRequest = z.object({ sessionId: z.string(), id: z.string().min(1) });
const inlineEditTarget = z
  .object({ path: z.string().min(1), startLine: z.number().int().positive(), endLine: z.number().int().positive() })
  .refine((t) => t.startLine <= t.endLine, 'startLine must not be after endLine');

function parsedAttachments(sessionId: string, blocks: readonly acp.ContentBlock[]): Incoming[] {
  try {
    return incomingAttachments(blocks);
  } catch (error) {
    if (error instanceof AttachmentError) throw acp.RequestError.invalidParams({ sessionId }, error.message);
    throw error;
  }
}

function parsedMentions(sessionId: string, blocks: readonly acp.ContentBlock[]): Mention[] {
  try {
    return mentionsOf(blocks);
  } catch (error) {
    if (error instanceof MentionError) throw acp.RequestError.invalidParams({ sessionId }, error.message);
    throw error;
  }
}

type Attached = { readonly mentions: readonly Mention[]; readonly attachments: readonly Incoming[] };

const hasAttached = ({ mentions, attachments }: Attached): boolean => mentions.length > 0 || attachments.length > 0;

type Expanded = Extract<Expansion, { kind: 'message' }>;

async function logPrompt(
  store: Store,
  opened: OpenSession,
  content: string,
  attached: Attached,
  files: Files,
  sessionId: string,
  expanded: Expanded | undefined,
): Promise<OpenSession> {
  const { log } = opened;
  let context: ContextItem[];
  let attachments: Attachment[];
  try {
    context = await contextItems(attached.mentions, await workspaceDir(log.session.workspace, '.'), files, ruleAttacher(log.events));
    attachments = await storeAttachments(attachmentsDir(store, log.session.id), attached.attachments);
  } catch (error) {
    if (error instanceof MentionError || error instanceof ToolError || error instanceof AttachmentError) throw acp.RequestError.invalidParams({ sessionId }, error.message);
    throw error;
  }
  const event: TurnEvent = {
    kind: 'user',
    seq: nextSeq(log.events),
    at: new Date().toISOString(),
    content,
    context: [...(expanded?.context ?? []), ...context],
    ...(attachments.length === 0 ? {} : { attachments }),
    ...(expanded === undefined ? {} : { command: expanded.command }),
  };
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
export function gcodeAgent(io: Io, store: Store, limits: Limits, mcp: McpSessions = mcpSessions(store, io.env)): acp.AgentApp {
  let peer: Peer = { files: false, diagnostics: false, unsaved: false, notices: false, elicitation: false, memory: false };
  const turns = new Map<string, AbortController | undefined>();
  // Each known session's approval mode. A switch applies at once, even inside a running turn; the log catches up after it.
  const modes = new Map<string, SessionMode>();
  // A turn and a review decision both append to the session log and number their events from what they read,
  // so each session's writers take turns.
  const writers = new Map<string, Promise<unknown>>();
  const serially = <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const next = (writers.get(sessionId) ?? Promise.resolve()).then(work, work);
    writers.set(sessionId, next.catch(() => {}));
    return next;
  };
  const commands = sessionCommands(homesOf(store, io.env), io);
  const switchMode = async (client: acp.AgentContext, sessionId: string, mode: SessionMode) => {
    modes.set(sessionId, mode);
    await client.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: mode } });
    // Not awaited: a running turn holds the log until it ends, and the switch must not wait for it.
    void serially(sessionId, async () => {
      const log = await openSessionLog(store, sessionId, io);
      await dropTornTail(log);
      await logMode(log, mode);
    }).catch((error: unknown) => io.err(`could not log the mode of ${sessionId}: ${String(error)}`));
  };
  const existing = (sessionId: string) =>
    openSessionLog(store, sessionId, io).catch((error: unknown) => {
      throw acp.RequestError.resourceNotFound(`session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  const known = (sessionId: string) => {
    if (!turns.has(sessionId)) throw acp.RequestError.invalidParams({ sessionId }, `no session ${sessionId}`);
  };
  const memoryOf = async (sessionId: string) => {
    known(sessionId);
    return memoryStore(homeOf(store), (await existing(sessionId)).session.workspace);
  };
  const refusedMemory =
    (id: string) =>
    (error: unknown): never => {
      if (error instanceof MemoryError) throw acp.RequestError.invalidParams({ id }, error.message);
      throw error;
    };

  return acp
    .agent({ name: 'gcode' })
    .onRequest(acp.methods.agent.initialize, ({ params }) => {
      const { fs, _meta, session, elicitation } = params.clientCapabilities ?? {};
      peer = {
        files: fs?.readTextFile === true && fs.writeTextFile === true,
        diagnostics: _meta?.[DIAGNOSTICS_CAPABILITY] === true,
        unsaved: _meta?.[UNSAVED_BUFFERS_CAPABILITY] === true,
        notices: session?.notices != null,
        elicitation: elicitation?.form != null,
        memory: _meta?.[MEMORY_CAPABILITY] === true,
      };
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {}, list: {}, delete: {}, close: {} },
          promptCapabilities: { embeddedContext: true, image: true },
          mcpCapabilities: { http: true, sse: true },
        },
        agentInfo: { name: 'gcode', version: '0.0.0' },
      };
    })
    .onRequest(acp.methods.agent.session.new, async ({ params, client }) => {
      const workspace = await workspaceDir(io.cwd, params.cwd);
      const opened = await startSession(store, io, { workspace, provider: undefined, model: undefined, effort: undefined });
      const { id } = opened.log.session;
      turns.set(id, undefined);
      modes.set(id, DEFAULT_SESSION_MODE);
      commands.attach(client, id, workspace);
      mcp.register(id, workspace, params.mcpServers, browserSettingsOf(params._meta));
      io.err(`session: ${id} log: ${opened.log.file}`);
      return { sessionId: id, modes: modeState(DEFAULT_SESSION_MODE), configOptions: effortConfigOptions(opened.log.session.effort) };
    })
    .onRequest(acp.methods.agent.session.resume, async ({ params, client }) => {
      const log = await existing(params.sessionId);
      const id = log.session.id;
      if (!turns.has(id)) turns.set(id, undefined);
      if (!modes.has(id)) modes.set(id, sessionModeOf(log.events));
      commands.attach(client, id, log.session.workspace);
      mcp.register(id, log.session.workspace, params.mcpServers ?? [], browserSettingsOf(params._meta));
      const context = lastContextUse(log.session, log.events);
      if (context !== undefined) await client.notify(acp.methods.client.session.update, { sessionId: id, update: usageUpdate(context) });
      io.err(`session: ${id} resumed, log: ${log.file}`);
      return { modes: modeState(modes.get(id)!), configOptions: effortConfigOptions(sessionEffortOf(log.session, log.events)) };
    })
    .onRequest(acp.methods.agent.session.load, async ({ params, client }) => {
      const log = await existing(params.sessionId);
      const workspace = await workspaceDir(io.cwd, params.cwd);
      if (log.session.workspace !== workspace) {
        throw acp.RequestError.invalidParams({ cwd: params.cwd }, `session ${log.session.id} belongs to ${log.session.workspace}; open it there`);
      }
      const id = log.session.id;
      if (!turns.has(id)) turns.set(id, undefined);
      if (!modes.has(id)) modes.set(id, sessionModeOf(log.events));
      commands.attach(client, id, log.session.workspace);
      mcp.register(id, log.session.workspace, params.mcpServers, browserSettingsOf(params._meta));
      const notify =(update: acp.SessionUpdate) => client.notify(acp.methods.client.session.update, { sessionId: id, update });
      for (const update of replayUpdates(log.events)) await notify(update);
      const context = lastContextUse(log.session, log.events);
      if (context !== undefined) await notify(usageUpdate(context));
      await notify(sessionInfo(summarizeSession(log.session, log.events)));
      io.err(`session: ${id} loaded, log: ${log.file}`);
      return { modes: modeState(modes.get(id)!), configOptions: effortConfigOptions(sessionEffortOf(log.session, log.events)) };
    })
    .onRequest(acp.methods.agent.session.list, async ({ params }): Promise<acp.ListSessionsResponse> => {
      const scope: SessionScope = params.cwd == null ? { kind: 'all' } : { kind: 'project', workspace: await workspaceDir(io.cwd, params.cwd) };
      const sessions = await listSessions(store, io, scope);
      return { sessions: sessions.map(sessionInfoOf) };
    })
    .onRequest(acp.methods.agent.session.delete, async ({ params }) => {
      const { sessionId } = params;
      if (turns.get(sessionId) !== undefined) throw acp.RequestError.invalidRequest({ sessionId }, 'stop the running turn before deleting its session');
      await existing(sessionId);
      const trashed = await serially(sessionId, () => trashSession(store, io, sessionId));
      turns.delete(sessionId);
      modes.delete(sessionId);
      io.err(`session: ${sessionId} moved to ${trashed}`);
      return {};
    })
    .onRequest(acp.methods.agent.session.close, async ({ params }) => {
      // Closing frees what the session holds open, its MCP servers; its log stays, and resume or load opens it again.
      const { sessionId } = params;
      turns.get(sessionId)?.abort();
      turns.delete(sessionId);
      commands.detach(sessionId);
      await mcp.close(sessionId);
      return {};
    })
    .onRequest(RENAME_SESSION_METHOD, renameRequest, async ({ params, client }) => {
      const { sessionId } = params;
      await existing(sessionId);
      const title = await serially(sessionId, () => renameSession(store, io, sessionId, params.title)).catch((error: unknown) => {
        if (error instanceof UsageError) throw acp.RequestError.invalidParams({ title: params.title }, error.message);
        throw error;
      });
      await client.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate: 'session_info_update', title } });
      return {};
    })
    .onRequest(acp.methods.agent.session.setMode, async ({ params, client }) => {
      const { sessionId, modeId } = params;
      known(sessionId);
      if (!isSessionMode(modeId)) throw acp.RequestError.invalidParams({ modeId }, `unknown mode ${modeId}; the modes are ${SESSION_MODES.join(', ')}`);
      await switchMode(client, sessionId, modeId);
      return {};
    })
    .onRequest(acp.methods.agent.session.setConfigOption, async ({ params }) => {
      const { sessionId } = params;
      known(sessionId);
      const effort = chosenEffort(params);
      // Not awaited, as a mode switch: a running turn holds the log, and the next turn reads the effort from it.
      void serially(sessionId, async () => {
        const log = await openSessionLog(store, sessionId, io);
        await dropTornTail(log);
        await logEffort(log, effort);
      }).catch((error: unknown) => io.err(`could not log the effort of ${sessionId}: ${String(error)}`));
      return { configOptions: effortConfigOptions(effort) };
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
      const { sessionId } = params;
      known(sessionId);
      if (turns.get(sessionId) !== undefined) throw acp.RequestError.invalidRequest({ sessionId }, 'a turn is already running');
      const text = promptText(params.prompt);
      const attached: Attached = { mentions: parsedMentions(sessionId, params.prompt), attachments: parsedAttachments(sessionId, params.prompt) };
      if (text === '' && attached.attachments.length === 0) throw acp.RequestError.invalidParams({ sessionId }, 'the prompt has no text');
      const rawTarget = params._meta?.[INLINE_EDIT_META];
      const target = rawTarget === undefined ? undefined : inlineEditTarget.safeParse(rawTarget);
      if (target?.success === false) throw acp.RequestError.invalidParams({ sessionId }, `${INLINE_EDIT_META}: ${z.prettifyError(target.error)}`);
      const slash = target === undefined ? await commands.expand(sessionId, text) : undefined;
      if (slash?.kind === 'builtin') {
        const reply = await runBuiltin(slash, { setMode: (mode) => switchMode(client, sessionId, mode) });
        await client.notify(acp.methods.client.session.update, { sessionId, update: textUpdate(reply) });
        return { stopReason: 'end_turn' };
      }
      if (slash?.content.trim() === '') throw acp.RequestError.invalidParams({ sessionId }, `/${slash.command.name} expands to no text`);

      const controller = new AbortController();
      turns.set(sessionId, controller);
      let session: Session | undefined;
      const turn = editorTurn(client, sessionId, peer, io, () => session);
      const turnIo = { ...io, interrupts: () => controller.signal };
      const diagnostics = peer.diagnostics ? editorDiagnostics(client, sessionId) : undefined;
      try {
        return await serially(sessionId, async () => {
          const resumed = await resumeSession(store, io, sessionId);
          session = resumed.log.session;
          if (titleOf(resumed.log.events) === undefined && target === undefined) turn.updates.send({ sessionUpdate: 'session_info_update', title: titleFrom(text) });
          const opened =
            target === undefined && (hasAttached(attached) || slash !== undefined)
              ? await logPrompt(store, resumed, slash?.content ?? text, attached, turn.surface.files, sessionId, slash)
              : resumed;
          const prompt = opened === resumed ? text : '';
          const approval: Approval = {
            kind: 'interactive',
            mode: () => modes.get(sessionId) ?? DEFAULT_SESSION_MODE,
            approve: turn.approve,
            classify: commandClassifier(io.env, io.fetch),
          };
          const result =
            target === undefined
              ? await runAgent(turnIo, store, opened, prompt, {
                  limits,
                  check: undefined,
                  checkAfterEdit: true,
                  approval,
                  surface: turn.surface,
                  diagnostics,
                  mcp: await mcp.toolset(sessionId, approval),
                  user: turn.user,
                })
              : await runInlineEdit(turnIo, store, opened, target.data, text, { maxCostUsd: limits.maxCostUsd, surface: turn.surface, diagnostics });
          await turn.updates.flush();
          return { stopReason: controller.signal.aborted ? 'cancelled' : STOP_REASONS[result.reason], ...turn.usage() };
        });
      } finally {
        // A session closed during its turn stays closed.
        if (turns.has(sessionId)) turns.set(sessionId, undefined);
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
    })
    .onRequest(RULES_METHOD, sessionRequest, async ({ params }): Promise<RulesResponse> => {
      known(params.sessionId);
      const log = await existing(params.sessionId);
      const start = log.events[0];
      const context = start?.kind === 'session-start' ? start.context : undefined;
      return { rules: context === undefined ? [] : appliedRules(context, log.session.workspace), globalFile: globalRulesFile(homeOf(store)) };
    })
    .onRequest(GLOBAL_RULES_METHOD, sessionRequest, async ({ params }): Promise<GlobalRulesResponse> => {
      known(params.sessionId);
      return { file: await ensureGlobalRules(homeOf(store)) };
    })
    .onRequest(MEMORY_METHOD, sessionRequest, async ({ params }): Promise<MemoryResponse> => ({ entries: await (await memoryOf(params.sessionId)).list() }))
    .onRequest(MEMORY_EDIT_METHOD, memoryEditRequest, async ({ params }): Promise<MemoryResponse> => ({
      entries: await (await memoryOf(params.sessionId)).edit(params.id, params.text).catch(refusedMemory(params.id)),
    }))
    .onRequest(MEMORY_DELETE_METHOD, memoryDeleteRequest, async ({ params }): Promise<MemoryResponse> => ({
      entries: await (await memoryOf(params.sessionId)).remove(params.id).catch(refusedMemory(params.id)),
    }))
    .onRequest(MCP_SERVERS_METHOD, mcpServersRequest, async ({ params }): Promise<McpServersResponse> => {
      known(params.sessionId);
      return mcp.servers(params.sessionId);
    })
    .onRequest(MCP_TRUST_METHOD, mcpTrustRequest, async ({ params }): Promise<McpServersResponse> => {
      known(params.sessionId);
      return mcp.trust(params.sessionId, params.name, params.hash).catch((error: unknown) => {
        throw acp.RequestError.invalidParams({ name: params.name }, error instanceof Error ? error.message : String(error));
      });
    })
    .onRequest(MCP_ENABLE_METHOD, mcpEnableRequest, async ({ params }): Promise<McpServersResponse> => {
      known(params.sessionId);
      return mcp.setEnabled(params.sessionId, params.name, params.enabled).catch((error: unknown) => {
        throw acp.RequestError.invalidParams({ name: params.name }, error instanceof Error ? error.message : String(error));
      });
    });
}

export const serve: Command = async (args, { io, store }) => {
  const { values } = parseArgs({ args, strict: true, options: { stdio: { type: 'boolean', default: false }, ...LIMIT_FLAGS } });
  if (!values.stdio) throw new UsageError('serve needs --stdio, the only transport');
  // stdout carries the protocol, so everything the engine prints goes to stderr, and so does anything a dependency prints.
  const quiet: Io = { ...io, out: io.err, write: () => {} };
  const stream = acp.ndJsonStream(guardStdout(), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
  const mcp = mcpSessions(store, io.env, quiet.err, browserLauncherOf(io.env));
  const connection = gcodeAgent(quiet, store, limitsOf(values), mcp).connect(stream);
  quiet.err(`gcode serve: ACP v${acp.PROTOCOL_VERSION} on stdio, sessions in ${store.sessionsDir}`);
  await connection.closed;
  await mcp.stopAll();
  return 0;
};
