import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
  type AutoState,
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
  asSessionId,
  WIDGET_CAPABILITY,
  WIDGET_DRAFT_META,
  WIDGET_TOOL,
  widgetDraftOf,
  SUBAGENT_META,
  type WidgetRef,
  DETACH_METHOD,
  isLive,
  LANE_APPLY_META,
  LANE_DISCARD_METHOD,
  LANE_NEW_METHOD,
  LANES_METHOD,
  RUNNING_META,
  TASK_UPDATE_METHOD,
  TASKS_CAPABILITY,
  TASKS_METHOD,
  type LaneNewResponse,
  type LanesResponse,
  ARENA_COMPARE_METHOD,
  ARENA_NEW_METHOD,
  ARENA_PICK_METHOD,
  ARENA_PREVIEW_METHOD,
  ARENA_UPDATE_METHOD,
  ARENAS_METHOD,
  isArenaSize,
  isVariety,
  LANE_GRAFT_META,
  type ArenaCompareResponse,
  type ArenaNewResponse,
  type ArenaPreviewResponse,
  type ArenasResponse,
  type ArenaUpdate,
  type Asking,
  type ArenaStatus,
  type ChildEnd,
  type LaneEnd,
  type LaneRecord,
  type VariantSpec,
  type TaskStatus,
  type TaskUsage,
  type TasksResponse,
  RETRY_NOW_METHOD,
  type RetryNowResponse,
  type Waiting,
} from '@g-code/core';
import { runAgent } from './agent.js';
import { arenaCompare, arenaPreview, arenaVariants, listArenas, pickWinner, startArena } from './arena.js';
import { applyLaneTurn, idleLane, laneFor, laneInfos } from './lane-hooks.js';
import { bindSession, discardLane, laneAt, laneRepoOf, requireLane } from './lanes.js';
import { Tasks } from './tasks.js';
import { Viewers, type Viewer } from './viewers.js';
import { AttachmentError, attachmentsDir, incomingAttachments, loadWidgets, readWidget, storeAttachments, widgetFile, type Incoming } from './attachments.js';
import { openSessionLog, resumeSession, startSession, type OpenSession } from './chat.js';
import { fileAt, shadowRepoFor } from './checkpoints.js';
import { commandClassifier } from './classifier.js';
import { homeOf, homesOf, runBuiltin, sessionCommands } from './commands.js';
import { MemoryError, memoryStore } from './memory.js';
import { ensureGlobalRules, globalRulesFile } from './project-context.js';
import { UsageError, type Io } from './command.js';
import { workspaceDir, type Limits, type Surface } from './drive.js';
import { DISK_FILES, type Files } from './files.js';
import { runInlineEdit } from './inline.js';
import { contextItems, MentionError, mentionsOf } from './mentions.js';
import { checkpointsOf, rewindTo } from './rewind.js';
import { browserSettingsOf } from './mcp/browser.js';
import { mcpSessions, type McpSessions } from './mcp/sessions.js';
import { appendEvent, dropTornTail, logBesideTurn, logEffort, logMode, type SettingChange } from './sessions.js';
import { chosenEffort, effortConfigOptions } from './effort-option.js';
import { usageUpdate } from './usage-update.js';
import { errorText, replayUpdates, textUpdate, TOOL_KINDS, TOOL_STATUS, toolResultUpdate, type ShownWidget } from './session-replay.js';
import { listSessions, renameSession, trashSession } from './history.js';
import type { Store } from './store.js';
import { freshAuto, type Approval, type Approver, type Diagnostics, type PermissionAnswer } from './tools/agent.js';
import { ToolError } from './tools/context.js';
import { EngineError } from './errors.js';
import { ruleAttacher } from './tools/rules.js';
import { acpChildHost } from './subagent-acp.js';
import { waitsLeft, waitUpdate } from './wait-hooks.js';
import { Wake } from './waits.js';
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
    description: 'Run safe commands on its own and let a classifier judge the rest, without asking. Asks before deleting the workspace or anything outside it, and once the classifier has blocked too many actions.',
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
  /** It draws show_widget's html. */
  readonly widgets: boolean;
  /** It understands ACP's subagent sessions. */
  readonly subagents: boolean;
  /** It takes task updates. */
  readonly tasks: boolean;
};

const NO_PEER: Peer = { files: false, diagnostics: false, unsaved: false, notices: false, elicitation: false, memory: false, widgets: false, subagents: false, tasks: false };

/**
 * How a turn reaches the editor that shows its session, whichever that is now: the one that sent the prompt, one that
 * loaded the session after a window reload, or none while it runs in the background. `signal` is the turn's own, and
 * `wake` the session's Retry now.
 */
type Route = { readonly viewers: Viewers<Peer>; readonly tasks: Tasks; readonly sessionId: string; readonly signal: AbortSignal; readonly wake: Wake };

/** The editor showing the route's session, when it can do what `can` asks. */
const viewerThat = (route: Route, can: (peer: Peer) => boolean): Viewer<Peer> | undefined => {
  const viewer = route.viewers.of(route.sessionId);
  return viewer !== undefined && can(viewer.peer) ? viewer : undefined;
};

/**
 * Asks whichever editor shows the session, waiting for one. The task of `asker`, a subagent's or else the session's
 * own, reads needs-input with the card until it answers.
 */
async function askEditor<T>(route: Route, signal: AbortSignal | undefined, card: Asking, request: (viewer: Viewer<Peer>) => Promise<T>, asker = route.sessionId): Promise<T> {
  const answered = route.tasks.ask(asker, card);
  try {
    return await route.viewers.ask(route.sessionId, signal ?? route.signal, request);
  } finally {
    answered();
  }
}

type Updates = { send(update: acp.SessionUpdate | Promise<acp.SessionUpdate>): void; flush(): Promise<void> };

/**
 * Session updates in order. Notifications are fire-and-forget for the loop, but must all precede the turn's response.
 * An update still being built, such as one that reads a stored widget, holds back the ones after it. `sessionId` is
 * the one an update names, a subagent's own for its stream.
 */
function updates(route: Route, sessionId: string, io: Io): Updates {
  let sent = Promise.resolve();
  return {
    send(update) {
      sent = sent
        .then(async () => route.viewers.notify(route.sessionId, acp.methods.client.session.update, { sessionId, update: await update }))
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

/**
 * The editor's buffers, through ACP's client file system, while an editor that has them shows the session; the disk
 * while none does. `writer` names the tool call a write belongs to.
 */
function editorFiles(route: Route, writer: () => acp.ToolCallId): Files {
  const { sessionId } = route;
  const failure = (verb: string, file: string, error: unknown) =>
    new ToolError(`the editor could not ${verb} ${file}: ${error instanceof Error ? error.message : String(error)}`);
  const editor = () => viewerThat(route, (peer) => peer.files);
  return {
    async read(file) {
      const viewer = editor();
      if (viewer === undefined) return DISK_FILES.read(file);
      try {
        return (await viewer.client.request(acp.methods.client.fs.readTextFile, { sessionId, path: file })).content;
      } catch (error) {
        if (error instanceof acp.RequestError && error.code === RESOURCE_NOT_FOUND) return null;
        throw failure('read', file, error);
      }
    },
    async write(file, text, baseHash) {
      const viewer = editor();
      if (viewer === undefined) return DISK_FILES.write(file, text, baseHash);
      try {
        await viewer.client.request(acp.methods.client.fs.writeTextFile, {
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
      const viewer = viewerThat(route, (peer) => peer.files && peer.unsaved);
      if (viewer === undefined) return [];
      const raw = await viewer.client.request<unknown, UnsavedBuffersRequest>(UNSAVED_BUFFERS_METHOD, { sessionId });
      const parsed = unsavedBuffersResponse.safeParse(raw);
      if (!parsed.success) throw new ToolError(`the editor sent malformed buffers: ${z.prettifyError(parsed.error)}`);
      return parsed.data.buffers;
    },
  };
}

/** The problems the editor showing the session reports; none while no such editor shows it. */
function editorDiagnostics(route: Route): Diagnostics {
  return async (paths) => {
    const viewer = viewerThat(route, (peer) => peer.diagnostics);
    if (viewer === undefined) return [];
    const raw = await viewer.client.request<unknown, DiagnosticsRequest>(DIAGNOSTICS_METHOD, { sessionId: route.sessionId, paths });
    const parsed = diagnosticsResponse.safeParse(raw);
    if (!parsed.success) throw new ToolError(`the editor sent malformed diagnostics: ${z.prettifyError(parsed.error)}`);
    return parsed.data.diagnostics;
  };
}

/**
 * What a load needs of a running turn to show it whole: every event logged so far, and the text the model is still
 * writing, which is logged only once its call ends.
 */
type LiveTurn = { readonly events: TurnEvent[]; text: string; waiting: Waiting | null };

type Turn = {
  readonly surface: Surface;
  readonly approve: Approver;
  readonly user: UserChannel;
  readonly updates: Updates;
  readonly live: LiveTurn;
  /** What the turn's model calls used so far, for the prompt response; nothing before the first call. */
  usage(): Pick<acp.PromptResponse, 'usage' | '_meta'>;
  taskUsage(): TaskUsage | undefined;
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

const bashDescriptionOf = (input: unknown): string | undefined => {
  const description = (input as { readonly description?: unknown } | null)?.description;
  return typeof description === 'string' && description.trim() !== '' ? description : undefined;
};

const taskUsageOf = (spent: Spent | undefined): TaskUsage | undefined =>
  spent === undefined
    ? undefined
    : { model: spent.model, inputTokens: spent.tokens.input + spent.tokens.cacheRead + spent.tokens.cacheWrite, outputTokens: spent.tokens.output, costUsd: spent.costUsd };

/**
 * One prompt turn's view of the editor: what the loop shows, reads and writes, and asks permission for. `peer` is what
 * the editor that started it can do; the editor that shows the session decides each call. `disk` keeps the turn's
 * files on disk, as a lane session's are. `session` is known once the turn opened the log, before its first model call.
 */
function editorTurn(
  route: Route,
  sessionId: string,
  peer: Peer,
  io: Io,
  session: () => Session | undefined,
  widgetOf: (widget: WidgetRef) => Promise<ShownWidget>,
  disk = false,
): Turn {
  const sent = updates(route, sessionId, io);
  // What each widget's step last showed while the model wrote it, so a piece of html that changes nothing sends nothing.
  const drafts = new Map<string, string>();
  // Only a tool that runs alone in its batch asks or writes, so the last one started is the one asking or writing.
  let running: acp.ToolCallId = '';
  let runningDescription: string | undefined;
  let spent: Spent | undefined;
  const live: LiveTurn = { events: [], text: '', waiting: null };
  return {
    updates: sent,
    live,
    user: editorUser(route, peer, () => sent.flush(), () => running),
    usage: () => usageOf(spent),
    taskUsage: () => taskUsageOf(spent),
    surface: {
      files: peer.files && !disk ? editorFiles(route, () => running) : DISK_FILES,
      wake: route.wake,
      waiter: { pid: process.pid, cwd: io.cwd },
      watcher: {
        waiting(wait) {
          live.waiting = wait;
          route.tasks.wait(route.sessionId, wait);
          if (peer.notices) sent.send(waitUpdate(wait));
        },
        text(delta) {
          live.text += delta;
          sent.send(textUpdate(delta));
        },
        toolStart(use, title) {
          running = use.id;
          runningDescription = use.name === 'bash' ? bashDescriptionOf(use.input) : undefined;
          sent.send({ sessionUpdate: 'tool_call', toolCallId: use.id, title, kind: TOOL_KINDS[use.name] ?? 'other', status: 'in_progress', rawInput: use.input });
        },
        toolEnd(use, status) {
          sent.send({ sessionUpdate: 'tool_call_update', toolCallId: use.id, status: TOOL_STATUS[status] });
        },
        toolInput({ id, name, json }) {
          if (name !== WIDGET_TOOL || !peer.widgets) return;
          const draft = widgetDraftOf(json);
          const key = JSON.stringify(draft);
          if (drafts.get(id) === key) return;
          const update = drafts.has(id) ? 'tool_call_update' : 'tool_call';
          drafts.set(id, key);
          const title = draft.title === undefined ? WIDGET_TOOL : `${WIDGET_TOOL} ${draft.title}`;
          sent.send({ sessionUpdate: update, toolCallId: id, title, kind: 'other', status: 'pending', _meta: { [WIDGET_DRAFT_META]: draft } });
        },
        logged(event) {
          live.events.push(event);
          if (event.kind === 'assistant' || event.kind === 'error') live.text = '';
          if (event.kind === 'assistant') {
            spent = {
              tokens: spent === undefined ? event.usage : addUsage(spent.tokens, event.usage),
              model: event.model,
              costUsd: spent?.costUsd === null || event.costUsd === null ? null : (spent?.costUsd ?? 0) + event.costUsd,
            };
            route.tasks.update(route.sessionId, { usage: taskUsageOf(spent) });
          }
          const update =
            event.kind === 'tool-result' && event.widget !== undefined
              ? widgetOf(event.widget).then((widget) => toolResultUpdate(event, {}, widget))
              : loggedUpdate(event, peer);
          if (update !== undefined) sent.send(update);
          const opened = session();
          if (event.kind === 'assistant' && opened !== undefined && spent !== undefined) {
            sent.send(usageUpdate(contextUseOf(opened.provider, opened.model, event.usage), { model: spent.model, costUsd: spent.costUsd }));
          }
        },
      },
    },
    async approve(denial, classifier, asker) {
      await sent.flush();
      const description = asker === undefined ? runningDescription : undefined;
      const rawInput: PermissionInput = { command: denial.command, reason: denial.reason, ...(description === undefined ? {} : { description }) };
      const title = `${asker === undefined ? '' : `[${asker.name}] `}${approvalQuestion(denial, classifier)}`;
      const toolCallId = running;
      try {
        const { outcome } = await askEditor(
          route,
          undefined,
          'permission',
          (viewer) =>
            viewer.client.request(acp.methods.client.session.requestPermission, {
              sessionId: route.sessionId,
              toolCall: { toolCallId, title, kind: isMcpRule(denial.rule) ? 'other' : 'execute', status: 'pending', rawInput },
              ...(asker === undefined ? {} : { _meta: { [SUBAGENT_META]: asker } }),
              options: isMcpRule(denial.rule) ? MCP_PERMISSION_OPTIONS : PERMISSION_OPTIONS,
            }),
          asker?.sessionId,
        );
        return (outcome.outcome === 'selected' && PERMISSION_ANSWERS[outcome.optionId]) || 'reject';
      } catch (error) {
        // A turn stopped while its question waited for an editor: as if the editor had cancelled it.
        if (route.signal.aborted) return 'reject';
        throw error;
      }
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
function editorUser(route: Route, peer: Peer, flush: () => Promise<void>, running: () => acp.ToolCallId): UserChannel {
  const { sessionId } = route;
  return {
    ...(peer.memory
      ? {
          async remember(input, signal) {
            await flush();
            const toolCallId = running();
            const { outcome } = await askEditor(route, signal, 'permission', (viewer) =>
              viewer.client.request(
                acp.methods.client.session.requestPermission,
                {
                  sessionId,
                  toolCall: { toolCallId, title: `Remember this ${SCOPE_WORDS[input.scope]}?`, kind: 'other', status: 'pending', rawInput: input, _meta: { [REMEMBER_META]: input } },
                  options: REMEMBER_OPTIONS,
                },
                { cancellationSignal: signal },
              ),
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
              return askUserReplyOf(
                request,
                await askEditor(route, signal, 'question', (viewer) => viewer.client.request(acp.methods.client.elicitation.create, elicitation, { cancellationSignal: signal })),
              );
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

/**
 * What outlives one editor connection: the sessions' turns, modes and Auto state, which editor shows each session,
 * the tasks, and each running turn's live state. One engine process keeps one, shared by every connection to it.
 */
export function engineShared(io: Io) {
  return {
    turns: new Map<string, AbortController | undefined>(),
    // Running subagents by their own session ids, which `session/cancel` may name.
    childCancels: new Map<string, () => void>(),
    // Each session's Auto state, kept across its turns for as long as the engine runs.
    autos: new Map<string, { state: AutoState }>(),
    // Each known session's approval mode. A switch applies at once, even inside a running turn; the log catches up after it.
    modes: new Map<string, SessionMode>(),
    // A turn and a review decision both append to the session log and number their events from what they read,
    // so each session's writers take turns.
    writers: new Map<string, Promise<unknown>>(),
    viewers: new Viewers<Peer>(io.err),
    tasks: new Tasks(),
    live: new Map<string, LiveTurn>(),
    // Each connection's way to hear of an Arena run's steps.
    arenaWatchers: new Set<(update: ArenaUpdate) => void>(),
    // Each session's Retry now, which cuts a wait of its running turn short.
    wakes: new Map<string, Wake>(),
    // Whether a connection already took up the waits an engine that stopped left in the logs; the first one does.
    leftWaits: { taken: false },
  };
}

export type EngineShared = ReturnType<typeof engineShared>;

const lanePrompt = z.object({ cwd: z.string(), prompt: z.string().trim().min(1), mode: z.string().optional() });
const laneDiscardRequest = z.object({ cwd: z.string(), name: z.string().min(1), discardChanges: z.boolean() });
const lanesRequest = z.object({ cwd: z.string() });
const arenaSizeOf = (n: number, params: unknown): 2 | 3 | 4 => {
  if (!isArenaSize(n)) throw acp.RequestError.invalidParams(params, `best-of-n runs 2 to 4 lanes, not ${n}`);
  return n;
};
const varietyOf = (raw: string | undefined, params: unknown) => {
  if (raw === undefined || isVariety(raw)) return raw;
  throw acp.RequestError.invalidParams(params, `unknown variety ${raw}`);
};
const arenaPreviewRequest = z.object({ cwd: z.string(), n: z.number().int(), variety: z.string().optional() });
const arenaNewRequest = z.object({ cwd: z.string(), task: z.string().trim().min(1), n: z.number().int(), variety: z.string().optional(), mode: z.string().optional() });
const arenaRequest = z.object({ cwd: z.string(), id: z.string() });
const arenaPickRequest = z.object({ cwd: z.string(), id: z.string(), lane: z.string().min(1) });
const laneGraftMeta = z.strictObject({ lane: z.string().min(1), hunks: z.array(z.string().min(1)).min(1) });

const CHILD_TASK_ENDS: Readonly<Record<ChildEnd['kind'], Exclude<TaskStatus, 'running' | 'needs-input' | 'waiting'>>> = {
  done: 'done',
  failed: 'failed',
  cancelled: 'stopped',
  capped: 'done',
};

/** An Arena run's own task ends as the run settles: ranked, with no lane that passed, or stopped. */
const ARENA_TASK_ENDS: { readonly [S in ArenaStatus]: Exclude<TaskStatus, 'running' | 'needs-input' | 'waiting'> | undefined } = {
  running: undefined,
  ranking: undefined,
  ranked: 'done',
  'no-winner': 'failed',
  stopped: 'stopped',
};

/** How a lane's turn ended, as the Arena counts it. */
const ARENA_ENDS: Readonly<Record<acp.StopReason, LaneEnd>> = {
  end_turn: 'done',
  max_tokens: 'failed',
  max_turn_requests: 'capped',
  refusal: 'failed',
  cancelled: 'stopped',
};

/** How a turn that ran to its end reads in the tasks list. */
const TASK_ENDS: Readonly<Record<acp.StopReason, Exclude<TaskStatus, 'running' | 'needs-input' | 'waiting'>>> = {
  end_turn: 'done',
  max_tokens: 'failed',
  max_turn_requests: 'failed',
  refusal: 'failed',
  cancelled: 'stopped',
};

/**
 * The engine as an ACP agent, for one editor connection. Each prompt runs `gcode agent`'s loop on the session's log,
 * or a one-shot inline edit, or a lane apply. `shared` is the process's, so a turn started over one connection goes on
 * after it closes and shows in the next editor that loads its session.
 */
export function gcodeAgent(io: Io, store: Store, limits: Limits, mcp: McpSessions = mcpSessions(store, io.env), shared: EngineShared = engineShared(io)): acp.AgentApp {
  const { turns, childCancels, autos, modes, writers, viewers, tasks, live, arenaWatchers, wakes, leftWaits } = shared;
  const wakeOf = (sessionId: string) => wakes.get(sessionId) ?? wakes.set(sessionId, new Wake()).get(sessionId)!;
  let peer: Peer = NO_PEER;
  let viewer: Viewer<Peer> | undefined;
  // This connection itself, as the editor that shows the sessions it opens; known once it connected.
  const self = (): Viewer<Peer> => {
    if (viewer === undefined) throw new Error('the connection is not open yet');
    return viewer;
  };
  /** A session's stored widget, as an update carries it. */
  const shownWidget = (sessionId: string) => async (widget: WidgetRef): Promise<ShownWidget> => {
    const dir = attachmentsDir(store, asSessionId(sessionId));
    return { uri: pathToFileURL(widgetFile(dir, widget)).href, html: await readWidget(dir, widget) };
  };
  const autoOf = (sessionId: string) => autos.get(sessionId) ?? autos.set(sessionId, freshAuto()).get(sessionId)!;
  const serially = <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const next = (writers.get(sessionId) ?? Promise.resolve()).then(work, work);
    writers.set(sessionId, next.catch(() => {}));
    return next;
  };
  const commands = sessionCommands(homesOf(store, io.env), io);
  /** A session no editor shows and no turn runs in lets go of its MCP servers; a load or resume opens them again. */
  const release = (sessionId: string) => {
    if (viewers.isShown(sessionId) || turns.get(sessionId) !== undefined) return;
    turns.delete(sessionId);
    void mcp.close(sessionId);
  };
  const logSetting = async (sessionId: string, change: SettingChange) => {
    // A running turn holds the log until it ends, which may be never, so the change is logged beside it.
    if (turns.get(sessionId) !== undefined) {
      const beside = await openSessionLog(store, sessionId, io)
        .then((log) => logBesideTurn(log, change))
        .catch((error: unknown) => {
          io.err(`could not log the ${change.kind} of ${sessionId} beside its turn: ${String(error)}`);
          return false;
        });
      if (beside) return;
    }
    // Not awaited: a turn that starts now holds the log until it ends, and the change must not wait for it.
    void serially(sessionId, async () => {
      const log = await openSessionLog(store, sessionId, io);
      await dropTornTail(log);
      await (change.kind === 'mode' ? logMode(log, change.mode) : logEffort(log, change.effort));
    }).catch((error: unknown) => io.err(`could not log the ${change.kind} of ${sessionId}: ${String(error)}`));
  };
  const switchMode = async (client: acp.AgentContext, sessionId: string, mode: SessionMode) => {
    modes.set(sessionId, mode);
    await client.notify(acp.methods.client.session.update, { sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: mode } });
    await logSetting(sessionId, { kind: 'mode', mode });
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
  const refused = (params: unknown) => (error: unknown): never => {
    if (error instanceof EngineError) throw acp.RequestError.invalidParams(params, error.message);
    throw error;
  };
  const laneRepo = async (cwd: string) => laneRepoOf(await workspaceDir(io.cwd, cwd)).catch(refused({ cwd }));
  const runningMeta = (sessionId: string) => (turns.get(sessionId) !== undefined ? { _meta: { [RUNNING_META]: true } } : {});

  /**
   * One turn of a session, for a prompt from `from`, the editor that asked. It runs to its end whether or not any
   * editor still shows the session; the tasks list follows it. A `resume` turn has no prompt: it takes up the wait an
   * engine that stopped left in the log.
   */
  const runTurn = async (
    sessionId: string,
    blocks: readonly acp.ContentBlock[],
    meta: Record<string, unknown> | null | undefined,
    from: Viewer<Peer>,
    resume = false,
  ): Promise<acp.PromptResponse> => {
    known(sessionId);
    if (turns.get(sessionId) !== undefined) throw acp.RequestError.invalidRequest({ sessionId }, 'a turn is already running');
    const text = promptText(blocks);
    const attached: Attached = { mentions: parsedMentions(sessionId, blocks), attachments: parsedAttachments(sessionId, blocks) };
    if (text === '' && attached.attachments.length === 0 && !resume) throw acp.RequestError.invalidParams({ sessionId }, 'the prompt has no text');
    const rawTarget = meta?.[INLINE_EDIT_META];
    const target = rawTarget === undefined ? undefined : inlineEditTarget.safeParse(rawTarget);
    if (target?.success === false) throw acp.RequestError.invalidParams({ sessionId }, `${INLINE_EDIT_META}: ${z.prettifyError(target.error)}`);
    const rawGraft = meta?.[LANE_GRAFT_META];
    const graft = rawGraft === undefined ? undefined : laneGraftMeta.safeParse(rawGraft);
    if (graft?.success === false) throw acp.RequestError.invalidParams({ sessionId }, `${LANE_GRAFT_META}: ${z.prettifyError(graft.error)}`);
    const rawLane = meta?.[LANE_APPLY_META] ?? graft?.data.lane;
    if (rawLane !== undefined && typeof rawLane !== 'string') throw acp.RequestError.invalidParams({ sessionId }, `${LANE_APPLY_META} must be a lane name`);
    const slash = target === undefined && rawLane === undefined ? await commands.expand(sessionId, text) : undefined;
    if (slash?.kind === 'builtin') {
      const reply = await runBuiltin(slash, { setMode: (mode) => switchMode(from.client, sessionId, mode) });
      await from.client.notify(acp.methods.client.session.update, { sessionId, update: textUpdate(reply) });
      return { stopReason: 'end_turn' };
    }
    if (slash?.content.trim() === '') throw acp.RequestError.invalidParams({ sessionId }, `/${slash.command.name} expands to no text`);

    const controller = new AbortController();
    turns.set(sessionId, controller);
    let session: Session | undefined;
    const route: Route = { viewers, tasks, sessionId, signal: controller.signal, wake: wakeOf(sessionId) };
    let turn: Turn | undefined;
    let ended: Exclude<TaskStatus, 'running' | 'needs-input' | 'waiting'> = 'failed';
    try {
      const header = await openSessionLog(store, sessionId, io);
      const lane = await laneAt(header.session.workspace, undefined).catch(() => undefined);
      const shown = editorTurn(route, sessionId, from.peer, io, () => session, shownWidget(sessionId), lane !== undefined);
      turn = shown;
      live.set(sessionId, shown.live);
      tasks.start({
        sessionId,
        title: titleOf(header.events) ?? (target !== undefined ? 'Inline edit' : titleFrom(resume ? (header.events.findLast((e) => e.kind === 'user')?.content ?? '') : text)),
        workspace: header.session.workspace,
        lane: lane?.record.name ?? null,
        startedAt: Date.now(),
      });
      const turnIo = { ...io, interrupts: () => controller.signal };
      const diagnostics = from.peer.diagnostics ? editorDiagnostics(route) : undefined;
      const response = await serially(sessionId, async (): Promise<acp.PromptResponse> => {
        const resumed = await resumeSession(store, io, sessionId);
        session = resumed.log.session;
        shown.live.events.push(...resumed.log.events);
        if (titleOf(resumed.log.events) === undefined && target === undefined && rawLane === undefined && !resume) shown.updates.send({ sessionUpdate: 'session_info_update', title: titleFrom(text) });
        if (rawLane !== undefined) {
          const repo = await laneRepoOf(resumed.log.session.workspace).catch(refused({ sessionId }));
          await applyLaneTurn(store, resumed, repo, rawLane, shown.surface.files, shown.surface.watcher, tasks, graft?.data.hunks).catch(refused({ lane: rawLane }));
          await shown.updates.flush();
          return { stopReason: controller.signal.aborted ? 'cancelled' : 'end_turn' };
        }
        const opened =
          target === undefined && (hasAttached(attached) || slash !== undefined)
            ? await logPrompt(store, resumed, slash?.content ?? text, attached, shown.surface.files, sessionId, slash)
            : resumed;
        const prompt = opened === resumed ? text : '';
        const approval: Approval = {
          kind: 'interactive',
          mode: () => modes.get(sessionId) ?? DEFAULT_SESSION_MODE,
          approve: shown.approve,
          classify: commandClassifier(io.env, io.fetch),
          auto: autoOf(sessionId),
        };
        const result =
          target === undefined
            ? await runAgent(turnIo, store, opened, prompt, {
                limits,
                check: undefined,
                checkAfterEdit: true,
                approval,
                surface: shown.surface,
                diagnostics,
                mcp: await mcp.toolset(sessionId, approval),
                user: shown.user,
                widgets: from.peer.widgets,
                childHost: acpChildHost({
                  client: { notify: (method, params) => Promise.resolve(viewers.notify(sessionId, method, params)) },
                  parentId: sessionId,
                  native: from.peer.subagents,
                  flushParent: () => shown.updates.flush(),
                  streamOf: (childId) => {
                    const { surface, updates } = editorTurn(route, childId, from.peer, io, () => undefined, shownWidget(childId));
                    return { watcher: surface.watcher, flush: () => updates.flush() };
                  },
                  cancels: childCancels,
                  err: io.err,
                  tasks: {
                    started: (child) =>
                      tasks.start({
                        sessionId: child.id,
                        parent: sessionId,
                        kind: 'subagent',
                        title: `${child.agent.name}: ${child.task.split('\n')[0]!}`,
                        workspace: header.session.workspace,
                        lane: lane?.record.name ?? null,
                        startedAt: Date.now(),
                      }),
                    ended: (child, end) => tasks.end(child.id, CHILD_TASK_ENDS[end.kind], undefined),
                  },
                }),
              })
            : await runInlineEdit(turnIo, store, opened, target.data, text, { maxCostUsd: limits.maxCostUsd, surface: shown.surface, diagnostics });
        await shown.updates.flush();
        return { stopReason: controller.signal.aborted ? 'cancelled' : STOP_REASONS[result.reason], ...shown.usage() };
      });
      ended = TASK_ENDS[response.stopReason];
      return response;
    } finally {
      live.delete(sessionId);
      tasks.end(sessionId, controller.signal.aborted ? 'stopped' : ended, turn?.taskUsage());
      // A session closed during its turn stays closed.
      if (turns.has(sessionId)) turns.set(sessionId, undefined);
      release(sessionId);
    }
  };

  /** A new session in `lane` running `prompt` in the background, as Run in a new lane and each Arena lane start one. */
  const startLaneSession = async (lane: LaneRecord, prompt: string, rawMode: string | undefined, variant?: VariantSpec, parent?: string) => {
    const opened = await startSession(store, io, { workspace: lane.path, provider: undefined, model: variant?.model ?? undefined, effort: variant?.effort ?? undefined });
    const { id } = opened.log.session;
    // Bound now, so the Lanes pane names the task from the first update on.
    const bound = await laneAt(lane.path, undefined);
    if (bound !== undefined) await bindSession(bound, id);
    const mode = rawMode !== undefined && isSessionMode(rawMode) ? rawMode : DEFAULT_SESSION_MODE;
    turns.set(id, undefined);
    modes.set(id, mode);
    if (mode !== DEFAULT_SESSION_MODE) await logSetting(id, { kind: 'mode', mode });
    mcp.register(id, lane.path, [], undefined);
    io.err(`lane: ${lane.name} at ${lane.path}, session ${id}`);
    if (parent !== undefined) tasks.adopt(id, parent);
    const turn = runTurn(id, [{ type: 'text', text: prompt }], undefined, self());
    void turn.catch((error: unknown) => io.err(`lane ${lane.name}: ${String(error)}`));
    return { id, turn };
  };

  /** Runs on in the background each turn an engine that stopped left waiting, as the first editor connects. */
  const takeUpWaits = async () => {
    const left = await waitsLeft(store, io.cwd).catch((error: unknown) => {
      io.err(`could not look for waits to take up: ${String(error)}`);
      return [];
    });
    for (const id of left) {
      const log = await existing(id).catch(() => undefined);
      if (log === undefined || turns.get(id) !== undefined) continue;
      turns.set(id, undefined);
      if (!modes.has(id)) modes.set(id, sessionModeOf(log.events));
      mcp.register(id, log.session.workspace, [], undefined);
      io.err(`session: ${id} takes up the wait its last engine left`);
      void runTurn(id, [], undefined, self(), true).catch((error: unknown) => io.err(`session ${id}: ${String(error)}`));
    }
  };

  return acp
    .agent({ name: 'gcode' })
    .onConnect((connection) => {
      const shows: Viewer<Peer> = {
        client: connection.client,
        get peer() {
          return peer;
        },
        closed: connection.signal,
      };
      viewer = shows;
      const unlisten = tasks.listen((update) => {
        if (peer.tasks) void connection.client.notify(TASK_UPDATE_METHOD, update).catch(() => {});
      });
      const watch = (update: ArenaUpdate) => {
        if (peer.tasks) void connection.client.notify(ARENA_UPDATE_METHOD, update).catch(() => {});
      };
      arenaWatchers.add(watch);
      void connection.closed.then(() => {
        unlisten();
        arenaWatchers.delete(watch);
        for (const sessionId of viewers.shownBy(shows)) {
          viewers.hide(sessionId, shows);
          commands.detach(sessionId);
          release(sessionId);
        }
      });
    })
    .onRequest(acp.methods.agent.initialize, ({ params }) => {
      if (!leftWaits.taken) {
        leftWaits.taken = true;
        void takeUpWaits();
      }
      const { fs, _meta, session, elicitation, subagents } = params.clientCapabilities ?? {};
      peer = {
        files: fs?.readTextFile === true && fs.writeTextFile === true,
        diagnostics: _meta?.[DIAGNOSTICS_CAPABILITY] === true,
        unsaved: _meta?.[UNSAVED_BUFFERS_CAPABILITY] === true,
        notices: session?.notices != null,
        elicitation: elicitation?.form != null,
        memory: _meta?.[MEMORY_CAPABILITY] === true,
        widgets: _meta?.[WIDGET_CAPABILITY] === true,
        subagents: subagents != null,
        tasks: _meta?.[TASKS_CAPABILITY] === true,
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
      viewers.show(id, self());
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
      viewers.show(id, self());
      commands.attach(client, id, log.session.workspace);
      mcp.register(id, log.session.workspace, params.mcpServers ?? [], browserSettingsOf(params._meta));
      const context = lastContextUse(log.session, log.events);
      if (context !== undefined) await client.notify(acp.methods.client.session.update, { sessionId: id, update: usageUpdate(context) });
      io.err(`session: ${id} resumed, log: ${log.file}`);
      return { modes: modeState(modes.get(id)!), configOptions: effortConfigOptions(sessionEffortOf(log.session, log.events)), ...runningMeta(id) };
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
      const notify = (update: acp.SessionUpdate) => client.notify(acp.methods.client.session.update, { sessionId: id, update });
      // One step, with no await between: what the running turn logged so far is replayed, and what it sends from now on
      // waits behind the replay, so the editor sees each update once and in order.
      const running = live.get(id);
      const events = running === undefined ? log.events : [...running.events];
      const streaming = running?.text ?? '';
      const replayed = viewers.show(id, self(), true);
      try {
        const dir = attachmentsDir(store, id);
        const stored = await loadWidgets(dir, events);
        const widgetOf = (widget: WidgetRef): ShownWidget => ({ uri: pathToFileURL(widgetFile(dir, widget)).href, html: stored.get(widget.sha256) });
        for (const update of replayUpdates(events, widgetOf)) await notify(update);
        if (streaming !== '') await notify(textUpdate(streaming));
        if (running?.waiting != null && self().peer.notices) await notify(waitUpdate(running.waiting));
        const context = lastContextUse(log.session, events);
        if (context !== undefined) await notify(usageUpdate(context));
        await notify(sessionInfo(summarizeSession(log.session, events)));
      } finally {
        replayed();
      }
      io.err(`session: ${id} loaded, log: ${log.file}`);
      return { modes: modeState(modes.get(id)!), configOptions: effortConfigOptions(sessionEffortOf(log.session, log.events)), ...runningMeta(id) };
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
      viewers.hide(sessionId);
      io.err(`session: ${sessionId} moved to ${trashed}`);
      return {};
    })
    .onRequest(acp.methods.agent.session.close, async ({ params }) => {
      // Closing frees what the session holds open, its MCP servers; its log stays, and resume or load opens it again.
      const { sessionId } = params;
      turns.get(sessionId)?.abort();
      turns.delete(sessionId);
      viewers.hide(sessionId);
      commands.detach(sessionId);
      await mcp.close(sessionId);
      return {};
    })
    .onRequest(RETRY_NOW_METHOD, sessionRequest, async ({ params }): Promise<RetryNowResponse> => ({ retried: wakes.get(params.sessionId)?.wake() ?? false }))
    .onRequest(DETACH_METHOD, sessionRequest, async ({ params }) => {
      viewers.hide(params.sessionId, self());
      commands.detach(params.sessionId);
      release(params.sessionId);
      return {};
    })
    .onRequest(RENAME_SESSION_METHOD, renameRequest, async ({ params, client }) => {
      const { sessionId } = params;
      await existing(sessionId);
      const title = await serially(sessionId, () => renameSession(store, io, sessionId, params.title)).catch((error: unknown) => {
        if (error instanceof UsageError) throw acp.RequestError.invalidParams({ title: params.title }, error.message);
        throw error;
      });
      tasks.update(sessionId, { title });
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
      await logSetting(sessionId, { kind: 'effort', effort });
      return { configOptions: effortConfigOptions(effort) };
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params }) => {
      known(params.sessionId);
      if (!viewers.isShown(params.sessionId)) viewers.show(params.sessionId, self());
      return runTurn(params.sessionId, params.prompt, params._meta, self());
    })
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      turns.get(params.sessionId)?.abort();
      childCancels.get(params.sessionId)?.();
    })
    .onRequest(TASKS_METHOD, z.object({}).loose(), async (): Promise<TasksResponse> => tasks.list())
    .onRequest(LANES_METHOD, lanesRequest, async ({ params }): Promise<LanesResponse> => ({ lanes: await laneInfos(await laneRepo(params.cwd), store, io, tasks) }))
    .onRequest(LANE_NEW_METHOD, lanePrompt, async ({ params }): Promise<LaneNewResponse> => {
      const repo = await laneRepo(params.cwd);
      const lane = await laneFor(repo, params.prompt, store, io).catch(refused({ cwd: params.cwd }));
      const { id } = await startLaneSession(lane, params.prompt, params.mode);
      return { name: lane.name, sessionId: id };
    })
    .onRequest(ARENA_PREVIEW_METHOD, arenaPreviewRequest, async ({ params }): Promise<ArenaPreviewResponse> => {
      const n = arenaSizeOf(params.n, params);
      const repo = await laneRepo(params.cwd);
      const variants = await arenaVariants(repo.main, n, varietyOf(params.variety, params)).catch(refused({ cwd: params.cwd }));
      return { preview: await arenaPreview(store, io, n), variants };
    })
    .onRequest(ARENA_NEW_METHOD, arenaNewRequest, async ({ params }): Promise<ArenaNewResponse> => {
      const n = arenaSizeOf(params.n, params);
      let rootId: string | undefined;
      const repo = await laneRepo(params.cwd);
      const variants = await arenaVariants(repo.main, n, varietyOf(params.variety, params)).catch(refused({ cwd: params.cwd }));
      const started = await startArena(
        {
          repo,
          store,
          io,
          check: undefined,
          runLane: async (lane, variant, prompt, run) => {
            // The run's own task, which its lanes roll up into, starts with its first lane.
            if (tasks.get(run) === undefined) {
              rootId = run;
              tasks.start({ sessionId: run, kind: 'arena', parent: null, title: `Best of ${n}: ${params.task}`, workspace: repo.main, lane: null, startedAt: Date.now() });
            }
            const { id, turn } = await startLaneSession(lane, prompt, params.mode, variant, run);
            return { sessionId: id, ended: turn.then((response) => ARENA_ENDS[response.stopReason]) };
          },
          onUpdate: (run) => {
            const end = ARENA_TASK_ENDS[run.status];
            if (end !== undefined) tasks.end(run.id, end, undefined);
            for (const watch of arenaWatchers) watch({ run });
          },
        },
        params.task,
        variants,
        await arenaPreview(store, io, n),
      ).catch((error: unknown) => {
        if (rootId !== undefined) tasks.end(rootId, 'failed', undefined);
        return refused({ cwd: params.cwd })(error);
      });
      void started.finished.catch((error: unknown) => {
        tasks.end(started.run.id, 'failed', undefined);
        io.err(`arena ${started.run.id}: ${String(error)}`);
      });
      return { run: started.run };
    })
    .onRequest(ARENAS_METHOD, lanesRequest, async ({ params }): Promise<ArenasResponse> => ({ arenas: await listArenas(await laneRepo(params.cwd)) }))
    .onRequest(ARENA_COMPARE_METHOD, arenaRequest, async ({ params }): Promise<ArenaCompareResponse> => arenaCompare(await laneRepo(params.cwd), params.id).catch(refused({ id: params.id })))
    .onRequest(ARENA_PICK_METHOD, arenaPickRequest, async ({ params }) => {
      const run = await pickWinner(await laneRepo(params.cwd), params.id, params.lane).catch(refused({ lane: params.lane }));
      for (const watch of arenaWatchers) watch({ run });
      return { run };
    })
    .onRequest(LANE_DISCARD_METHOD, laneDiscardRequest, async ({ params }) => {
      const repo = await laneRepo(params.cwd);
      const lane = await requireLane(repo, params.name).catch(refused({ name: params.name }));
      await Promise.resolve()
        .then(() => idleLane(lane, tasks))
        .catch(refused({ name: params.name }));
      await discardLane(repo, lane, params.discardChanges).catch(refused({ name: params.name }));
      return {};
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
