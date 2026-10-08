import { realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import {
  BASE_HASH_META,
  CHECKPOINT_TEXT_METHOD,
  checkpointBefore,
  DIAGNOSTICS_CAPABILITY,
  EDITOR_ACTION_METHOD,
  EDITOR_ACTIONS_CAPABILITY,
  SPINOFF_CAPABILITY,
  localZone,
  parseScheduleCommand,
  runEndOf,
  SCHEDULE_ACT_METHOD,
  SCHEDULE_PANEL_ACTIONS,
  SCHEDULE_POLICY,
  SCHEDULE_REASON,
  SCHEDULE_USAGE,
  scheduleListText,
  scheduleQuestion,
  SCHEDULES_CAPABILITY,
  WORKFLOWS_CAPABILITY,
  WORKSPACE_TRUST_CAPABILITY,
  HOOKS_METHOD,
  hookRows,
  type HooksResponse,
  WORKFLOW_META,
  WORKFLOW_REASON,
  childReport,
  childrenUsage,
  previewQuestion,
  ratesOf,
  workflowEnd,
  workflowProgress,
  workflowReport,
  type AgentDefinition,
  type WorkflowOrigin,
  type Replay,
  type WorkflowPreview,
  type WorkflowSpec,
  SCHEDULES_METHOD,
  SCHEDULES_UPDATE_METHOD,
  taskLine,
  type RunEnd,
  type RunEndKind,
  type ScheduleChange,
  type ScheduledTask,
  type SchedulePolicy,
  type SchedulesResponse,
  CHAPTER_CAPABILITY,
  CHAPTER_MARK_METHOD,
  parseChapterMark,
  promptAt,
  type ChapterMarkResponse,
  SPINOFF_DISMISS_METHOD,
  SPINOFF_START_METHOD,
  laneNameFor,
  moveSpinoff,
  openSpinoffNamed,
  spinoffsOf,
  type Spinoff,
  type SpinoffDecision,
  type SpinoffResponse,
  type EditorActionRequest,
  READ_TERMINAL_CAPABILITY,
  READ_TERMINAL_METHOD,
  type ReadTerminalRequest,
  DIAGNOSTICS_METHOD,
  HUNK_STATUSES,
  INLINE_EDIT_META,
  RESUME_AGENT_META,
  nextSeq,
  REVIEW_METHOD,
  reviewState,
  REWIND_METHOD,
  REWIND_PREVIEW_METHOD,
  sessionSpend,
  USAGE_METHOD,
  type UsageResponse,
  PR_STATUS_METHOD,
  type PrStatusResponse,
  REWIND_TURN_METHOD,
  REWIND_KINDS,
  FORK_AT_META,
  TURN_END_META,
  TURN_SEQ_META,
  toolUsesFrom,
  SEVERITIES,
  spillNotice,
  STALE_BASE_ERROR,
  TOOL_CALL_META,
  TURN_USAGE_META,
  UNSAVED_BUFFERS_CAPABILITY,
  UNSAVED_BUFFERS_METHOD,
  addUsage,
  RENAME_SESSION_METHOD,
  SEARCH_SESSIONS_METHOD,
  type SearchSessionsResponse,
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
  COMMENT_OPTION,
  EXTERNAL_RULE_IDS,
  PERMISSION_COMMENT_META,
  isSessionMode,
  MCP_ENABLE_METHOD,
  MCP_RECONNECT_METHOD,
  MCP_SERVERS_METHOD,
  MCP_TOKEN_CAPABILITY,
  MCP_TOKEN_METHOD,
  MCP_TRUST_METHOD,
  type McpServersResponse,
  type McpTokenRequest,
  SESSION_MODES,
  sessionEffortOf,
  lastContextUse,
  spendOf,
  type CompactEvent,
  type Spend,
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
  type CheckpointRef,
  type ReviewDecision,
  type ReviewResponse,
  type RewindResponse,
  type ForkOrigin,
  type RewindPreviewResponse,
  type RewindTurnResponse,
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
  parseRule,
  patternText,
  PERMISSION_ADD_METHOD,
  PERMISSION_REMOVE_METHOD,
  PERMISSIONS_METHOD,
  RULE_EFFECTS,
  CATALOG_INSTALL_METHOD,
  CATALOG_KINDS,
  CATALOG_PREVIEW_METHOD,
  CATALOG_SEARCH_METHOD,
  CATALOG_UNINSTALL_METHOD,
  INSTALL_SCOPES,
  SKILLS_METHOD,
  type CatalogInstallResponse,
  type CatalogPreviewResponse,
  type CatalogSearchResponse,
  type CatalogUninstallResponse,
  type SkillsResponse,
  type Denial,
  type PermissionRule,
  type PermissionsResponse,
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
  TODO_META,
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
  BACKGROUND_STOP_METHOD,
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
  type TaskEnd,
  type TaskUsage,
  type TasksResponse,
  RETRY_NOW_METHOD,
  type RetryNowResponse,
  PROGRESS_META,
  progressLabel,
  type Waiting,
  BACKEND_ENV_CAPABILITY,
  BACKEND_ENV_METHOD,
  BACKEND_META,
  BACKENDS_METHOD,
  backendShown,
  EXTERNAL_BACKENDS,
  isExternalBackendId,
  MODEL_CONFIG_ID,
  type BackendBinding,
  type BackendsResponse,
  type ExternalBackendId,
  type ApprovalRuleId,
  STEER_META,
  startsTurn,
  isUsersOwn,
  lastUserPromptSeq,
  unwokenOf,
  wakeNotice,
  WAKE_CANCEL_METHOD,
  DRAFT_METHOD,
  type WakeTrigger,
  subagentModelsOf,
} from '@g-code/core';
import { runAgent } from './agent.js';
import { Steers, steerRunning } from './steer.js';
import { arenaCompare, arenaPreview, arenaVariants, listArenas, pickWinner, startArena } from './arena.js';
import { applyLaneTurn, idleLane, laneFor, laneInfos, takenLaneNames } from './lane-hooks.js';
import { bindSession, discardLane, laneAt, laneRepoOf, requireLane } from './lanes.js';
import { Tasks } from './tasks.js';
import { backgroundShared, backgroundStopRequest, logArrivals } from './background-hooks.js';
import { Viewers, type Viewer } from './viewers.js';
import { AttachmentError, attachmentsDir, incomingAttachments, loadAttachments, loadWidgets, readWidget, storeAttachments, widgetFile, type Incoming } from './attachments.js';
import { openSessionLog, resumeSession, startExternalSession, startSession, type OpenSession } from './chat.js';
import { backendInfos, findBackend } from './backends.js';
import { chosenModelOf, ExternalAgents, modelConfigOptions, runExternalTurn, type KeyOf } from './external.js';
import { fileAt, shadowRepoFor } from './checkpoints.js';
import { commandClassifier } from './classifier.js';
import { catalogService } from './catalog.js';
import { homeOf, homesOf, pluginLoader, runBuiltin, sessionCommands } from './commands.js';
import { MemoryError, memoryStore } from './memory.js';
import { permissionStore, rulesWorkspace } from './permissions.js';
import { ensureGlobalRules, globalRulesFile } from './project-context.js';
import { UsageError, type Io } from './command.js';
import type { Director, Limits, Surface } from './drive.js';
import { workspaceDir } from './workspace.js';
import { DISK_FILES, type Files } from './files.js';
import { runInlineEdit } from './inline.js';
import { contextItems, MentionError, mentionsOf } from './mentions.js';
import { checkpointsOf, forkSession, rewindPreview, rewindSession, rewindTo } from './rewind.js';
import { browserSettingsOf } from './mcp/browser.js';
import { mcpSessions, type McpSessions, type McpSessionTokens } from './mcp/sessions.js';
import { appendEvent, dropTornTail, logBesideTurn, logSettingChange, type SettingChange } from './sessions.js';
import { chosenEffort, effortConfigOptions } from './effort-option.js';
import { usageUpdate } from './usage-update.js';
import { compactAtOf, compactContext, numbered } from './compact.js';
import { wakeMetaOf, backgroundUpdate, compactUpdate, errorText, replayUpdates, steerUpdate, textUpdate, TOOL_KINDS, TOOL_STATUS, toolResultUpdate, type ShownWidget } from './session-replay.js';
import { listSessions, renameSession, trashSession } from './history.js';
import { sessionIndex } from './session-index.js';
import type { Store } from './store.js';
import { freshAuto, type Approval, type Approver, type Diagnostics, type PermissionAnswer } from './tools/agent.js';
import { ToolError } from './tools/context.js';
import type { Editor } from './tools/editor.js';
import { readTerminalResponse, type TerminalReader } from './tools/terminal.js';
import { EngineError } from './errors.js';
import { ruleAttacher } from './tools/rules.js';
import { acpChildHost } from './subagent-acp.js';
import { waitsLeft, waitUpdate } from './wait-hooks.js';
import { recoverInterrupted } from './interrupted.js';
import { draftNotice, wakeCancelRequest, WakeDriver, wakePolicyOf } from './wake-hooks.js';
import { ghCli, githubRemote, lookUpPr } from './gh.js';
import { Wake } from './waits.js';
import type { UserChannel } from './tools/user.js';
import type { ScheduleTools } from './tools/schedule.js';
import type { WorkflowTools } from './tools/workflow.js';
import { appendJournal, journalFile, readJournal, WORKFLOW_TURNS, workflowDriver, workflowTools } from './workflows.js';
import { loadAgents } from './subagents.js';
import { Scheduler, ScheduleError, SYSTEM_CLOCK, type Clock, type ScheduleRunner } from './schedules.js';
import { pidAlive } from './wait-hooks.js';
import { HookSessions } from './hooks.js';
import { loadHookConfig } from './hook-config.js';
import { claudeDirOf } from './plugins.js';

const RESOURCE_NOT_FOUND = -32002;

/** An external agent's question shows as the kind of call it asks about, so an edit's card reads as an edit. */
const PERMISSION_KINDS: Readonly<Partial<Record<ApprovalRuleId, acp.ToolKind>>> = { 'external-read': 'read', 'external-write': 'edit', 'external-command': 'execute', 'external-other': 'other' };

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
// A command with an offered rule can also be allowed for the workspace, from now on, as can a web_fetch host or an
// MCP tool. It comes last, after the once-only answers, so the card's first row stays Allow and Deny.
const WORKSPACE_PERMISSION_OPTION: acp.PermissionOption = { optionId: 'allow-workspace', name: 'Always allow in this workspace', kind: 'allow_always' };
const RULE_PERMISSION_OPTIONS: acp.PermissionOption[] = [...PERMISSION_OPTIONS, WORKSPACE_PERMISSION_OPTION];
const MCP_RULE_PERMISSION_OPTIONS: acp.PermissionOption[] = [...MCP_PERMISSION_OPTIONS, WORKSPACE_PERMISSION_OPTION];
// A read outside every directory Geno may read can also let the session read that directory, as Claude Code's card does.
const DIRECTORY_PERMISSION_OPTIONS: acp.PermissionOption[] = [
  PERMISSION_OPTIONS[0]!,
  { optionId: 'allow-session', name: 'Allow this directory for the session', kind: 'allow_always' },
  PERMISSION_OPTIONS[1]!,
];
const PERMISSION_ANSWERS: Readonly<Record<string, PermissionAnswer>> = { allow: 'allow', 'allow-session': 'allow-session', 'allow-workspace': 'allow-workspace' };

/** The user's answer to a permission card; a comment left empty is a plain no. */
function permissionAnswerOf(outcome: acp.RequestPermissionOutcome): PermissionAnswer {
  if (outcome.outcome !== 'selected') return 'reject';
  if (outcome.optionId !== COMMENT_OPTION) return PERMISSION_ANSWERS[outcome.optionId] ?? 'reject';
  const comment = outcome._meta?.[PERMISSION_COMMENT_META];
  return typeof comment === 'string' && comment.trim() !== '' ? { comment: comment.trim() } : 'reject';
}

// Last on every card, as on Claude Code's, but an external agent's: its answer has no room for the comment. The answer
// carries the comment in _meta, under PERMISSION_COMMENT_META.
const COMMENT_PERMISSION_OPTION: acp.PermissionOption = { optionId: COMMENT_OPTION, name: 'No, and tell the agent…', kind: 'reject_once' };

const choicesFor = (denial: Denial): acp.PermissionOption[] => {
  if (denial.directory !== undefined) return DIRECTORY_PERMISSION_OPTIONS;
  const keeps = denial.offer !== undefined || denial.keeps !== undefined;
  if (isMcpRule(denial.rule)) return keeps ? MCP_RULE_PERMISSION_OPTIONS : MCP_PERMISSION_OPTIONS;
  return keeps ? RULE_PERMISSION_OPTIONS : PERMISSION_OPTIONS;
};
const optionsFor = (denial: Denial): acp.PermissionOption[] =>
  (EXTERNAL_RULE_IDS as readonly string[]).includes(denial.rule) ? choicesFor(denial) : [...choicesFor(denial), COMMENT_PERMISSION_OPTION];

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

const backendEnvResponse = z.object({ env: z.record(z.string(), z.string()) });
const mcpTokenResponse = z.object({ accessToken: z.string().min(1).optional() });

/**
 * An HTTP MCP server's access token, asked of the editor that shows the session; with none, or one that cannot answer,
 * the server needs sign-in. The token is never logged.
 */
export const mcpTokensVia =
  (viewers: Viewers<Peer>): McpSessionTokens =>
  async (sessionId, server, rejected) => {
    const viewer = viewers.of(sessionId);
    if (viewer === undefined || !viewer.peer.mcpTokens || viewer.closed.aborted) return undefined;
    const request: McpTokenRequest = { sessionId, server: server.name, url: server.url, rejected };
    const parsed = mcpTokenResponse.safeParse(await viewer.client.request<unknown>(MCP_TOKEN_METHOD, request));
    return parsed.success ? parsed.data.accessToken : undefined;
  };
const backendRequest = z.object({ id: z.string() }).nullish();

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
  /** It answers BACKEND_ENV_METHOD with what the user chose for an external agent. */
  readonly backendEnv: boolean;
  /** It carries out EDITOR_ACTION_METHOD, so the model gets open_file, reveal and show_diff. */
  readonly editorActions: boolean;
  /** It answers READ_TERMINAL_METHOD, so the model gets read_terminal. */
  readonly terminals: boolean;
  /** It shows suggested tasks and starts them, so the model gets spawn_task and dismiss_task. */
  readonly spinoffs: boolean;
  /** It lists scheduled tasks and asks the user about a change, so the model gets schedule_task. */
  readonly schedules: boolean;
  /** It draws chapters, so the model gets mark_chapter. */
  readonly chapters: boolean;
  /** It shows a workflow's preview card and its progress in Tasks, so the model gets workflow and the user /workflow. */
  readonly workflows: boolean;
  /** Its workspace is one the user trusts, as VS Code's workspace trust says, so the workspace's own hooks may run. */
  readonly trusted: boolean;
  /** It answers MCP_TOKEN_METHOD from the user's sign-ins to HTTP MCP servers. */
  readonly mcpTokens: boolean;
};

const NO_PEER: Peer = {
  files: false,
  diagnostics: false,
  unsaved: false,
  notices: false,
  elicitation: false,
  memory: false,
  widgets: false,
  subagents: false,
  tasks: false,
  backendEnv: false,
  editorActions: false,
  terminals: false,
  spinoffs: false,
  schedules: false,
  chapters: false,
  workflows: false,
  trusted: false,
  mcpTokens: false,
};

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
  [/sent no response|stopped responding/i, 'the model went quiet'],
  [/timed? ?out|timeout/i, 'timed out'],
  [/connect|network|socket|fetch failed|ECONNRESET|EAI_AGAIN|closed|terminated|ended/i, 'connection dropped'],
];

/** The few words a status line gives for why a call is retried; the full message goes in the notice's description. */
const retryReason = (message: string): string => RETRY_REASONS.find(([pattern]) => pattern.test(message))?.[1] ?? 'server error';

const LOGGED: { readonly [K in TurnEvent['kind']]?: (event: EventOf<K>, peer: Peer) => acp.SessionUpdate | undefined } = {
  'tool-result': (event) => toolResultUpdate(event),
  user: (event) => (event.steer === true ? steerUpdate(event) : undefined),
  error: (event) => textUpdate(errorText(event)),
  compact: (event) => compactUpdate(event),
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

/** Carries out an editor action in the editor showing the session; a refusal the model reads while none does. */
function editorActions(route: Route): Editor {
  return async (action) => {
    const viewer = viewerThat(route, (peer) => peer.editorActions);
    if (viewer === undefined) throw new ToolError('no editor shows this session now, so there is nothing to show it in');
    await viewer.client.request<unknown, EditorActionRequest>(EDITOR_ACTION_METHOD, { sessionId: route.sessionId, action }).catch((error: unknown) => {
      throw new ToolError(`the editor could not show ${action.path}: ${error instanceof Error ? error.message : String(error)}`);
    });
  };
}

/** The terminals of the editor showing the session, as it redacted and capped them; a refusal the model reads while none does. */
function editorTerminals(route: Route): TerminalReader {
  return async (request) => {
    const viewer = viewerThat(route, (peer) => peer.terminals);
    if (viewer === undefined) throw new ToolError('no editor shows this session now, so there is no terminal to read');
    const raw = await viewer.client.request<unknown, ReadTerminalRequest>(READ_TERMINAL_METHOD, { sessionId: route.sessionId, ...request }).catch((error: unknown) => {
      throw new ToolError(`the editor could not read its terminals: ${error instanceof Error ? error.message : String(error)}`);
    });
    const parsed = readTerminalResponse.safeParse(raw);
    if (!parsed.success) throw new ToolError(`the editor sent a malformed terminal read: ${z.prettifyError(parsed.error)}`);
    return parsed.data;
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
  /** Asks the user about a change to a scheduled task, with its whole question; no rule or classifier answers it. */
  approveSchedule(question: string, signal: AbortSignal): Promise<ScheduleAnswer>;
  /** Asks the user to run a workflow, with its preview on the card. */
  approveWorkflow(preview: WorkflowPreview, signal: AbortSignal): Promise<boolean>;
  readonly updates: Updates;
  readonly live: LiveTurn;
  /** What the turn's model calls used so far, for the prompt response; nothing before the first call. */
  usage(): Pick<acp.PromptResponse, 'usage' | '_meta'>;
  taskUsage(): TaskUsage | undefined;
};

type Spent = { readonly tokens: TokenUsage; readonly model: string; readonly costUsd: number | null };

const addSpend = (spent: Spent | undefined, { usage, model, costUsd }: Spend): Spent => ({
  tokens: spent === undefined ? usage : addUsage(spent.tokens, usage),
  model,
  costUsd: spent?.costUsd === null || costUsd === null ? null : (spent?.costUsd ?? 0) + costUsd,
});

function usageOf(spent: Spent | undefined, backend: ExternalBackendId | undefined): Pick<acp.PromptResponse, 'usage' | '_meta'> {
  if (spent === undefined) return {};
  const { tokens, model, costUsd } = spent;
  const usage: acp.Usage = {
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cachedReadTokens: tokens.cacheRead,
    cachedWriteTokens: tokens.cacheWrite,
    totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
  };
  const meta: TurnUsage = { model, costUsd, ...(backend === undefined ? {} : { backend }) };
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
  backend?: ExternalBackendId,
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
    usage: () => usageOf(spent, backend),
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
        progress(progress) {
          if (peer.notices) sent.send({ sessionUpdate: 'notice', severity: 'info', title: progressLabel(progress, Date.now()), _meta: { [PROGRESS_META]: progress } });
        },
        toolStart(use, title) {
          running = use.id;
          runningDescription = use.name === 'bash' ? bashDescriptionOf(use.input) : undefined;
          sent.send({ sessionUpdate: 'tool_call', toolCallId: use.id, title, kind: TOOL_KINDS[use.name] ?? 'other', status: 'in_progress', rawInput: use.input });
        },
        toolSkipped(use, title) {
          sent.send({ sessionUpdate: 'tool_call', toolCallId: use.id, title, kind: TOOL_KINDS[use.name] ?? 'other', status: 'pending', rawInput: use.input });
        },
        toolEnd(use, status, todo) {
          sent.send({ sessionUpdate: 'tool_call_update', toolCallId: use.id, status: TOOL_STATUS[status], ...(todo === undefined ? {} : { _meta: { [TODO_META]: { items: todo } } }) });
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
          if (event.kind === 'backend-start' && backend !== undefined && event.lane !== null) {
            route.tasks.update(route.sessionId, { lane: event.lane });
            sent.send({ sessionUpdate: 'session_info_update', _meta: { [BACKEND_META]: backendShown(backend, event.lane) } });
          }
          if (event.kind === 'assistant' || event.kind === 'error') live.text = '';
          const spend = spendOf(event);
          if (spend !== undefined) {
            spent = addSpend(spent, spend);
            route.tasks.update(route.sessionId, { usage: taskUsageOf(spent) });
          }
          const update =
            event.kind === 'tool-result' && event.widget !== undefined
              ? widgetOf(event.widget).then((widget) => toolResultUpdate(event, {}, widget))
              : loggedUpdate(event, peer);
          if (update !== undefined) sent.send(update);
          const opened = session();
          // An external agent's window and token counts are its own; it reports them itself when it does.
          if (spend !== undefined && opened !== undefined && spent !== undefined && backend === undefined) {
            const context = lastContextUse(opened, [event]);
            if (context !== undefined) sent.send(usageUpdate(context, { model: spent.model, costUsd: spent.costUsd }));
          }
        },
        compacting() {
          if (peer.notices) sent.send({ sessionUpdate: 'notice', severity: 'info', title: 'Compacting the context' });
        },
      },
    },
    async approve(denial, classifier, asker) {
      await sent.flush();
      const description = asker === undefined ? runningDescription : undefined;
      const rawInput: PermissionInput = {
        command: denial.command,
        reason: denial.reason,
        ...(description === undefined ? {} : { description }),
        ...(denial.offer === undefined ? (denial.keeps === undefined ? {} : { rule: denial.keeps }) : { rule: patternText(denial.offer) }),
      };
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
              toolCall: { toolCallId, title, kind: PERMISSION_KINDS[denial.rule] ?? (isMcpRule(denial.rule) ? 'other' : 'execute'), status: 'pending', rawInput },
              ...(asker === undefined ? {} : { _meta: { [SUBAGENT_META]: asker } }),
              options: optionsFor(denial),
            }),
          asker?.sessionId,
        );
        return permissionAnswerOf(outcome);
      } catch (error) {
        // A turn stopped while its question waited for an editor: as if the editor had cancelled it.
        if (route.signal.aborted) return 'reject';
        throw error;
      }
    },
    async approveSchedule(question, signal) {
      await sent.flush();
      const rawInput: PermissionInput = { command: question, reason: SCHEDULE_REASON, description: 'Schedule a task' };
      const { outcome } = await askEditor(route, signal, 'permission', (viewer) =>
        viewer.client.request(
          acp.methods.client.session.requestPermission,
          { sessionId: route.sessionId, toolCall: { toolCallId: running, title: question, kind: 'other', status: 'pending', rawInput }, options: SCHEDULE_OPTIONS },
          { cancellationSignal: signal },
        ),
      );
      return (outcome.outcome === 'selected' && SCHEDULE_ANSWERS[outcome.optionId]) || 'reject';
    },
    async approveWorkflow(preview, signal) {
      await sent.flush();
      const question = previewQuestion(preview);
      const rawInput: PermissionInput = { command: question, reason: WORKFLOW_REASON, description: `Run workflow ${preview.name}` };
      const { outcome } = await askEditor(route, signal, 'permission', (viewer) =>
        viewer.client.request(
          acp.methods.client.session.requestPermission,
          { sessionId: route.sessionId, toolCall: { toolCallId: running, title: question, kind: 'other', status: 'pending', rawInput, _meta: { [WORKFLOW_META]: preview } }, options: WORKFLOW_OPTIONS },
          { cancellationSignal: signal },
        ),
      );
      return outcome.outcome === 'selected' && outcome.optionId === 'allow';
    },
  };
}

const WORKFLOW_OPTIONS: acp.PermissionOption[] = [
  { optionId: 'allow', name: 'Run', kind: 'allow_once' },
  { optionId: 'reject', name: "Don't run", kind: 'reject_once' },
];

type ScheduleAnswer = 'allow' | 'allow-session' | 'reject';

/**
 * A background turn the engine starts: a scheduled task's run, with its budget in place of the engine's limits and a
 * prompt that says nobody watches, or a workflow's, whose director issues its rounds in place of the model.
 */
type ScheduledTurn = { readonly limits?: Limits | undefined; readonly scheduled?: boolean | undefined; readonly director?: Director | undefined };

const schedulesRequest = z.object({ cwd: z.string() });
const scheduleActRequest = z.object({ cwd: z.string(), id: z.string().min(1), action: z.enum(SCHEDULE_PANEL_ACTIONS) });

const SCHEDULE_OPTIONS: acp.PermissionOption[] = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow-session', name: 'Allow schedule changes in this chat', kind: 'allow_always' },
  { optionId: 'reject', name: "Don't allow", kind: 'reject_once' },
];

const SCHEDULE_ANSWERS: Readonly<Record<string, ScheduleAnswer>> = { allow: 'allow', 'allow-session': 'allow-session' };

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
  const meta: SessionSummaryMeta = { turns: summary.turns, costUsd: summary.costUsd, createdAt: summary.createdAt, ...(summary.forkedFrom === undefined ? {} : { forkedFrom: summary.forkedFrom }) };
  return { sessionId: summary.id, cwd: summary.workspace, title: summary.title, updatedAt: summary.updatedAt, _meta: { [SESSION_SUMMARY_META]: meta } };
}

const renameRequest = z.object({ sessionId: z.string(), title: z.string() });
const searchRequest = z.object({ query: z.string().max(500), cwd: z.string().nullish() });

/** How the history's search answers: every word the user typed must occur, and a row shows a short line of it. */
const HISTORY_SEARCH = { match: 'all', limit: 50, snippetLength: 120 } as const;

/** The task's link back to the session it was forked from, if it was. */
const forkOf = (events: readonly TurnEvent[]): { readonly forkedFrom?: ForkOrigin } => {
  const head = events[0];
  return head?.kind === 'session-start' && head.fork !== undefined ? { forkedFrom: head.fork } : {};
};

const promptText = (blocks: readonly acp.ContentBlock[]): string =>
  blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim();

const reviewRequest = z.object({
  sessionId: z.string(),
  decisions: z.array(z.object({ hunk: z.string().min(1).transform((raw) => raw as HunkId), status: z.enum(HUNK_STATUSES) })),
});
const checkpointTextRequest = z.object({ sessionId: z.string(), path: z.string(), before: z.string().min(1).optional(), sha: z.string().min(1).optional() });
const rewindRequest = z.object({ sessionId: z.string(), before: z.string().min(1).optional() });
const usageRequest = z.object({ sessionId: z.string() });
const prStatusRequest = z.object({ cwd: z.string().min(1).refine(path.isAbsolute, 'an absolute folder') });
const rewindPreviewRequest = z.object({ sessionId: z.string(), turnSeq: z.number().int().positive() });
const rewindTurnRequest = z.object({ sessionId: z.string(), turnSeq: z.number().int().positive(), choice: z.object({ kind: z.enum(REWIND_KINDS) }) });
const forkAt = z.number().int().positive().optional();

/** The session's first checkpoint, or the one before the turn that made change `before`, which must be in the log. */
function checkpointFor(events: readonly TurnEvent[], { before }: { readonly before?: CheckpointRef['before'] | undefined }) {
  if (before === undefined) return checkpointsOf(events)[0];
  const checkpoint = checkpointBefore(events, { before });
  if (checkpoint === undefined) throw acp.RequestError.invalidParams({ before }, 'no checkpoint before the turn that made this change');
  return checkpoint;
}
const mcpServersRequest = z.object({ sessionId: z.string() });
const mcpTrustRequest = z.object({ sessionId: z.string(), name: z.string().min(1), hash: z.string().min(1) });
const mcpEnableRequest = z.object({ sessionId: z.string(), name: z.string().min(1), enabled: z.boolean() });
const mcpReconnectRequest = z.object({ sessionId: z.string(), name: z.string().min(1) });
const sessionRequest = z.object({ sessionId: z.string() });
const permissionsRequest = z.object({ cwd: z.string() });
const permissionAddRequest = z.object({ cwd: z.string(), effect: z.enum(RULE_EFFECTS), text: z.string() });
const permissionRemoveRequest = z.object({ cwd: z.string(), id: z.string().min(1) });
const skillsRequest = z.object({ cwd: z.string() });
const catalogSearchRequest = z.object({ cwd: z.string(), catalogs: z.array(z.string()).max(50), query: z.string().max(500) });
const catalogItemRequest = z.object({ cwd: z.string(), catalog: z.string().min(1), kind: z.enum(CATALOG_KINDS), name: z.string().min(1) });
const catalogInstallRequest = catalogItemRequest.extend({ scope: z.enum(INSTALL_SCOPES) });
const catalogUninstallRequest = z.object({ cwd: z.string(), id: z.string().min(1) });
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

/** A woken turn's first event: why it woke, from the engine and not the user. */
async function logWake(opened: OpenSession, triggers: readonly WakeTrigger[]): Promise<OpenSession> {
  const { log } = opened;
  const event: TurnEvent = { kind: 'user', seq: nextSeq(log.events), at: new Date().toISOString(), content: wakeNotice(triggers), from: 'wake', wake: triggers };
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
/** What tests replace: the clock the scheduler keeps time by, and its grace window. */
export type EngineOptions = { readonly clock?: Clock | undefined; readonly schedulePolicy?: SchedulePolicy | undefined };

export function engineShared(io: Io, options: EngineOptions = {}) {
  const viewers = new Viewers<Peer>(io.err);
  const tasks = new Tasks();
  const background = backgroundShared(viewers, tasks);
  const turns = new Map<string, AbortController | undefined>();
  // A turn and a review decision both append to the session log and number their events from what they read,
  // so each session's writers take turns.
  const writers = new Map<string, Promise<unknown>>();
  const serially = <T>(sessionId: string, work: () => Promise<T>): Promise<T> => {
    const next = (writers.get(sessionId) ?? Promise.resolve()).then(work, work);
    writers.set(sessionId, next.catch(() => {}));
    return next;
  };
  return {
    turns,
    // Running subagents by their own session ids, which `session/cancel` may name.
    childCancels: new Map<string, () => void>(),
    // Each session's Auto state, kept across its turns for as long as the engine runs.
    autos: new Map<string, { state: AutoState }>(),
    // Each known session's approval mode. A switch applies at once, even inside a running turn; the log catches up after it.
    modes: new Map<string, SessionMode>(),
    writers,
    serially,
    viewers,
    tasks,
    // Background commands, which outlive their turn and the window that started them.
    ...background,
    live: new Map<string, LiveTurn>(),
    // Each connection's way to hear of an Arena run's steps.
    arenaWatchers: new Set<(update: ArenaUpdate) => void>(),
    // Each session's Retry now, which cuts a wait of its running turn short.
    retries: new Map<string, Wake>(),
    // Whether a connection already took up the waits an engine that stopped left in the logs; the first one does.
    leftWaits: { taken: false },
    // Each external session's agent process.
    externals: new ExternalAgents(io),
    // Each running session's steers, children's included, arriving in the background commands' inbox.
    steers: new Steers(background.inbox),
    // Each session's latest turn's end, true when the user stopped it: a steer that missed the turn waits for it, and
    // runs as the next turn only if the turn was not stopped. Kept after the end, so a late steer still reads it.
    turnEnds: new Map<string, Promise<boolean>>(),
    // Each session's steers that missed their turn, run one turn after another in the order they came.
    nextTurns: new Map<string, Promise<unknown>>(),
    // What wakes each session after its turn ended, and the gate that decides when.
    wakes: new WakeDriver({
      ...background,
      tasks,
      turns,
      shownBy: (sessionId) => viewers.of(sessionId),
      serially,
      autoWake: io.env['GCODE_AUTO_WAKE'] !== 'off',
      policy: wakePolicyOf(io.env),
    }),
    schedules: new Scheduler({
      clock: options.clock ?? SYSTEM_CLOCK,
      policy: options.schedulePolicy ?? SCHEDULE_POLICY,
      zone: localZone,
      pid: process.pid,
      alive: pidAlive,
      random: Math.random,
    }),
    // Sessions whose user allowed every schedule change for the chat.
    scheduleAllowed: new Set<string>(),
    // The directories each session's user allowed it to read from a card, by session.
    sessionDirectories: new Map<string, Set<string>>(),
    // A scheduled run's budget, which the turns it wakes share.
    runLimits: new Map<string, Limits>(),
    // The hooks of each session a turn ran in this process; SessionEnd fires for them when the process ends.
    hooks: new HookSessions(),
  };
}

export type EngineShared = ReturnType<typeof engineShared>;

const lanePrompt = z.object({ cwd: z.string(), prompt: z.string().trim().min(1), mode: z.string().optional() });
const laneDiscardRequest = z.object({ cwd: z.string(), name: z.string().min(1), discardChanges: z.boolean() });
const lanesRequest = z.object({ cwd: z.string() });
const spinoffRequest = z.object({ sessionId: z.string(), id: z.string().min(1), mode: z.string().optional() });
const chapterRequest = z.object({ sessionId: z.string(), turnSeq: z.number().int().positive(), mark: z.unknown() });
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

const CHILD_TASK_ENDS: Readonly<Record<ChildEnd['kind'], TaskEnd>> = {
  done: 'done',
  failed: 'failed',
  cancelled: 'stopped',
  capped: 'done',
  interrupted: 'stopped',
};

/** An Arena run's own task ends as the run settles: ranked, with no lane that passed, or stopped. */
const ARENA_TASK_ENDS: { readonly [S in ArenaStatus]: TaskEnd | undefined } = {
  running: undefined,
  ranking: undefined,
  ranked: 'done',
  'no-winner': 'failed',
  stopped: 'stopped',
};

/** How a turn ends: the loop's reason, or the user's stop. A turn with no loop, such as a lane apply, ends `end_turn`. */
type TurnEnd = DoneReason | 'cancelled';

/**
 * What each end of a turn is to its task, to an Arena lane, to a scheduled run, and on ACP's wire. ACP has no stop for
 * a failed model call or for the budget, so those go out as the nearest stop, and TURN_END_META carries the task end.
 */
const TURN_ENDS: { readonly [E in TurnEnd]: { readonly task: TaskEnd; readonly lane: LaneEnd; readonly run: RunEndKind; readonly stop: acp.StopReason } } = {
  end_turn: { task: 'done', lane: 'done', run: 'done', stop: 'end_turn' },
  'max-turns': { task: 'failed', lane: 'capped', run: 'max-turns', stop: 'max_turn_requests' },
  budget: { task: 'failed', lane: 'capped', run: 'budget', stop: 'max_turn_requests' },
  refusal: { task: 'failed', lane: 'failed', run: 'failed', stop: 'refusal' },
  error: { task: 'failed', lane: 'failed', run: 'failed', stop: 'end_turn' },
  cancelled: { task: 'stopped', lane: 'stopped', run: 'stopped', stop: 'cancelled' },
};

/** ACP's answer for a turn that ended with `end`, with the task end under TURN_END_META. */
const turnResponse = (end: TurnEnd, spent: Pick<acp.PromptResponse, 'usage' | '_meta'>): acp.PromptResponse => ({
  stopReason: TURN_ENDS[end].stop,
  ...spent,
  _meta: { ...spent._meta, [TURN_END_META]: TURN_ENDS[end].task },
});

/** A turn's end, and ACP's answer for it. */
type Turned = { readonly end: TurnEnd; readonly response: acp.PromptResponse };

/**
 * The engine as an ACP agent, for one editor connection. Each prompt runs `gcode agent`'s loop on the session's log,
 * or a one-shot inline edit, or a lane apply. `shared` is the process's, so a turn started over one connection goes on
 * after it closes and shows in the next editor that loads its session.
 */
export function gcodeAgent(io: Io, store: Store, limits: Limits, mcp: McpSessions = mcpSessions(store, io.env), shared: EngineShared = engineShared(io)): acp.AgentApp {
  const { turns, childCancels, autos, modes, serially, viewers, tasks, live, arenaWatchers, retries, leftWaits, externals, jobs, inbox, steers, turnEnds, nextTurns, wakes, schedules, scheduleAllowed, sessionDirectories, runLimits, hooks } = shared;
  const wakeOf = (sessionId: string) => retries.get(sessionId) ?? retries.set(sessionId, new Wake()).get(sessionId)!;
  const directoriesOf = (sessionId: string) => sessionDirectories.get(sessionId) ?? sessionDirectories.set(sessionId, new Set()).get(sessionId)!;
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
  wakes.bind(store, io);
  const gh = ghCli(io.env);
  schedules.bind(homeOf(store), io.err);
  // An arrival waits behind a running turn's writes, which take it at their next safe point; what is left is logged
  // after, and may wake the session.
  inbox.arrived = (sessionId) =>
    void serially(sessionId, () => logArrivals(store, io, inbox, sessionId))
      .then(() => wakes.soon(sessionId))
      .catch((error: unknown) => io.err(`could not log what reached ${sessionId}: ${String(error)}`));
  const commands = sessionCommands(homesOf(store, io.env), io);
  const pluginsOf = pluginLoader(io);
  const catalog = catalogService(homesOf(store, io.env), (cwd) => workspaceDir(io.cwd, cwd), async (workspace) => (await pluginsOf(workspace)).plugins);
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
      await logSettingChange(log, change);
    }).catch((error: unknown) => io.err(`could not log the ${change.kind} of ${sessionId}: ${String(error)}`));
  };
  const switchMode = async (client: acp.AgentContext, sessionId: string, mode: SessionMode) => {
    modes.set(sessionId, mode);
    void externals.setMode(sessionId, mode).catch((error: unknown) => io.err(`could not set the agent mode of ${sessionId}: ${String(error)}`));
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
  // Keyed by folder, not session: Settings must not start a session, which would fix its provider before a role change.
  const permissionsOf = async (cwd: string) => {
    const workspace = await workspaceDir(io.cwd, cwd).catch(refused({ cwd }));
    const home = io.env['HOME'] || homedir();
    const rules = permissionStore(homeOf(store), await rulesWorkspace(workspace, home));
    const scope = { workspace: rules.workspace, tempDir: tmpdir(), home };
    const answer = async (list: Promise<readonly PermissionRule[]>): Promise<PermissionsResponse> => ({ workspace: rules.workspace, rules: await list });
    return { rules, scope, answer };
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
  /** Suggestions being started, by session and id, so a second click does not start a second lane. */
  const startingSpinoffs = new Set<string>();
  const openSpinoff = async (sessionId: string, id: string): Promise<Spinoff & { readonly workspace: string }> => {
    const log = await existing(sessionId);
    const open = openSpinoffNamed(spinoffsOf(log.events), id);
    if (!open.ok) throw acp.RequestError.invalidParams({ sessionId, id }, open.problem);
    return { ...open.value, workspace: log.session.workspace };
  };
  const decideSpinoff = async (sessionId: string, { workspace: _, ...spinoff }: Spinoff & { readonly workspace: string }, decision: SpinoffDecision): Promise<Spinoff> => {
    const moved = moveSpinoff(spinoff, decision);
    if (!moved.ok) throw acp.RequestError.invalidParams({ sessionId, id: spinoff.id }, moved.problem);
    const change = { kind: 'spinoff', id: spinoff.id, decision } as const;
    // Logged at once, turn or no turn, so the next request reads it; only a torn tail waits for the log's next writer.
    if (!(await logBesideTurn(await existing(sessionId), change))) await logSetting(sessionId, change);
    return moved.value;
  };
  const runningMeta = (sessionId: string) => (turns.get(sessionId) !== undefined ? { _meta: { [RUNNING_META]: true } } : {});
  /** The user's key for an agent, from the window showing the session, or from `asking` before one shows it. */
  const keyOf =
    (sessionId: string, asking?: Viewer<Peer>): KeyOf =>
    async (backend) => {
      if (backend.keyEnv === undefined) return undefined;
      const viewer = viewers.of(sessionId) ?? asking;
      if (viewer === undefined || !viewer.peer.backendEnv) return undefined;
      const raw = await viewer.client.request<unknown>(BACKEND_ENV_METHOD, { backend: backend.id });
      const parsed = backendEnvResponse.safeParse(raw);
      const key = parsed.success ? parsed.data.env[backend.keyEnv] : undefined;
      return key === undefined || key === '' ? undefined : key;
    };
  /** An external session's response fields: Geno's modes, the agent's models, and which backend it is. */
  const externalFields = async (sessionId: string, binding: BackendBinding, events: readonly TurnEvent[], asking?: Viewer<Peer>) => {
    const setup = await externals
      .ensure(sessionId, binding, keyOf(sessionId, asking))
      .then((link) => link.setup)
      .catch((error: unknown) => {
        io.err(`backend: ${binding.id} for ${sessionId} did not start: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      });
    const lane = events.findLast((e) => e.kind === 'backend-start')?.lane ?? null;
    return { configOptions: modelConfigOptions(setup, chosenModelOf(events)), meta: { [BACKEND_META]: backendShown(binding.id, lane) } };
  };

  /** The workspace whose scheduled tasks a folder or session sees: its main checkout, for a lane. */
  const scheduleWorkspace = async (cwd: string) => rulesWorkspace(await workspaceDir(io.cwd, cwd).catch(refused({ cwd })), io.env['HOME'] || homedir());
  const toolRefusal = <T>(work: Promise<T>): Promise<T> =>
    work.catch((error: unknown) => {
      throw error instanceof ScheduleError ? new ToolError(error.message) : error;
    });
  /** schedule_task for a session: the workspace's tasks, and a card for each change unless the user allowed them for the chat. */
  const scheduleToolsFor = async (sessionId: string, cwd: string, turn: Turn): Promise<ScheduleTools> => {
    const workspace = await scheduleWorkspace(cwd);
    return {
      list: async () => (await schedules.list(workspace)).tasks,
      create: (draft) => toolRefusal(schedules.create(workspace, draft, { kind: 'model', sessionId })),
      update: (id, change) => toolRefusal(schedules.update(workspace, id, change)),
      remove: (id) => toolRefusal(schedules.remove(workspace, id)),
      approve: async (change: ScheduleChange, signal) => {
        if (scheduleAllowed.has(sessionId)) return true;
        const answer = await turn.approveSchedule(scheduleQuestion(change, localZone(), schedules.now()), signal);
        if (answer === 'allow-session') scheduleAllowed.add(sessionId);
        return answer !== 'reject';
      },
      now: () => schedules.now(),
      zone: localZone,
    };
  };
  /** The workflow tool of a session's turn: its workspace's workflows, priced on its model, each run a background session. */
  const workflowToolsFor = (sessionId: string, session: Session, turn: Turn): WorkflowTools => {
    const homes = homesOf(store, io.env);
    return workflowTools({
      workspace: session.workspace,
      homes,
      model: session.model,
      rates: (model) => ratesOf(session.provider, model),
      mode: () => modes.get(sessionId) ?? DEFAULT_SESSION_MODE,
      agents: async () => (await loadAgents(session.workspace, homes, (await pluginsOf(session.workspace)).plugins, subagentModelsOf(io.env))).agents,
      approve: (preview, signal) => turn.approveWorkflow(preview, signal),
      run: (spec, input, agents, toolUseId, replay) => runWorkflow(sessionId, session, spec, input, agents, toolUseId, replay),
      earlier: async (run) => {
        const log = await openSessionLog(store, run, io).catch(() => undefined);
        if (log === undefined) return undefined;
        const origin = log.events[0]?.kind === 'session-start' ? log.events[0].workflow : undefined;
        return { name: origin?.name, input: origin?.input, entries: await readJournal(journalFile(store, log.session.id)) };
      },
    });
  };

  /**
   * A workflow's run, as a background session in the starting session's workspace and mode, its steps that session's
   * children. Its report goes to the starting session as a background child's does: it wakes it, or, with auto-wake
   * off, joins its running turn or its next one.
   */
  const runWorkflow = async (parentId: string, parent: Session, spec: WorkflowSpec, input: string, agents: readonly AgentDefinition[], toolUseId: string, replay: Replay | undefined) => {
    const driver = workflowDriver(spec, input, agents, parent.model, (run, sessionId) => tasks.workflow(sessionId, workflowProgress(run)), {
      replay,
      write: (sessionId, entries) => appendJournal(journalFile(store, sessionId), entries),
    });
    const prompt = `Run the workflow ${spec.name}${input === '' ? '.' : ` on: ${input}`}${replay === undefined ? '' : `\nIt resumes run ${replay.run}.`}`;
    const limits: Limits = { maxTurns: WORKFLOW_TURNS, maxCostUsd: spec.maxCostUsd };
    const workflow: WorkflowOrigin = { parentId: asSessionId(parentId), toolUseId, name: spec.name, input, ...(replay === undefined ? {} : { resumes: asSessionId(replay.run) }) };
    const { id, turn } = await startBackground(parent.workspace, undefined, prompt, modes.get(parentId), { title: `Workflow ${spec.name}`, run: { limits, director: driver.director }, workflow });
    let silent = false;
    let stoppedByModel = false;
    const paid = steers.of(parentId)?.owe() ?? (() => {});
    const report = turn
      .then(
        ({ end }) => end === 'cancelled',
        () => false,
      )
      .then(async (cancelled) => {
        const log = await existing(id);
        const run = await driver.finish(log.events, cancelled);
        const usage = childrenUsage(log.events, Date.now() - Date.parse(log.session.createdAt));
        const end = workflowEnd(run);
        return childReport(`workflow ${spec.name}`, asSessionId(id), stoppedByModel && end.kind === 'cancelled' ? { kind: 'cancelled', by: 'model' } : end, workflowReport(run), usage);
      });
    const reported = wakes.autoWake
      ? wakes.registry.child(parentId, id, {
          agent: `workflow ${spec.name}`,
          toolUseId,
          silence: () => {
            silent = true;
            turns.get(id)?.abort();
          },
          // task_stop's: the report is its result, so no message repeats it.
          stop: () => {
            silent = true;
            stoppedByModel = true;
            turns.get(id)?.abort();
            return report;
          },
        })
      : undefined;
    void report
      .then((text) => {
        if (!silent) steers.inbox.put(parentId, { kind: 'child-report', report: text });
      })
      .catch((error: unknown) => io.err(`workflow ${spec.name} (${id}): could not report: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        paid();
        reported?.();
      });
    return { sessionId: id };
  };

  /** `/schedule`: the user's own request, so it needs no card. With no arguments it says how, and lists the tasks. */
  const scheduleCommand = async (sessionId: string, args: string): Promise<string> => {
    const workspace = await scheduleWorkspace((await existing(sessionId)).session.workspace);
    const now = schedules.now();
    if (args.trim() === '') return `${SCHEDULE_USAGE}\n\n${scheduleListText((await schedules.list(workspace)).tasks, localZone(), now)}`;
    const draft = parseScheduleCommand(args, now, localZone());
    if (!draft.ok) return `Nothing was scheduled: ${draft.problem}.\n\n${SCHEDULE_USAGE}`;
    try {
      const task = await schedules.create(workspace, draft.value, { kind: 'user' });
      return `Scheduled ${task.id} ${taskLine(task, localZone(), now)}. It is in Tasks under Scheduled, with Run now, Pause and Delete; each run shows there as a task of its own.`;
    } catch (error) {
      if (error instanceof ScheduleError) return `Nothing was scheduled: ${error.message}.`;
      throw error;
    }
  };

  /**
   * `/compact` between turns: it holds the session as a turn does, so no prompt starts while the summary is written, and
   * Stop stops it. Every editor showing the session gets the divider and the smaller context. A string is the reply.
   */
  const compactBetweenTurns = async (sessionId: string, focus: string): Promise<CompactEvent | string> => {
    if (turns.get(sessionId) !== undefined) return 'A turn is running. /compact runs between turns; Geno also compacts on its own when the context fills.';
    const controller = new AbortController();
    turns.set(sessionId, controller);
    const notify = (update: acp.SessionUpdate) => viewers.notify(sessionId, acp.methods.client.session.update, { sessionId, update });
    try {
      return await serially(sessionId, async () => {
        const { log, gateway } = await resumeSession(store, io, sessionId);
        if (log.session.backend !== undefined) return `${EXTERNAL_BACKENDS[log.session.backend.id].label} keeps its own context, so /compact works on Geno's own sessions only.`;
        notify({ sessionUpdate: 'notice', severity: 'info', title: 'Compacting the context' });
        const outcome = await compactContext(gateway, log.session, log.events, {
          trigger: 'manual',
          focus,
          compactAt: compactAtOf(io.env, log.session),
          stored: await loadAttachments(attachmentsDir(store, log.session.id), log.events),
          signal: controller.signal,
        });
        if (outcome.kind === 'nothing') return 'Nothing to compact yet: the conversation is short enough to keep as it is.';
        if (outcome.kind === 'failed') return controller.signal.aborted ? 'Stopped. The context is as it was.' : `Could not compact, so the context is as it was: ${outcome.message}`;
        const event = numbered(outcome.event, log.events);
        await appendEvent(log.file, event);
        notify(compactUpdate(event));
        const told = await hooks.sessionStart(sessionId, 'compact');
        if (told !== undefined) await appendEvent(log.file, { ...told, seq: nextSeq([...log.events, event]) });
        const context = lastContextUse(log.session, [event]);
        if (context !== undefined) notify(usageUpdate(context, { model: event.model, costUsd: event.costUsd }));
        return event;
      });
    } finally {
      if (turns.get(sessionId) === controller) turns.set(sessionId, undefined);
    }
  };

  /**
   * One turn of a session, for a prompt from `from`, the editor that asked. It runs to its end whether or not any
   * editor still shows the session; the tasks list follows it. A `resume` turn has no prompt: it takes up the wait an
   * engine that stopped left in the log. A `wake` turn has none either: the engine starts it with what arrived.
   */
  const runTurn = async (
    sessionId: string,
    blocks: readonly acp.ContentBlock[],
    meta: Record<string, unknown> | null | undefined,
    from: Viewer<Peer>,
    start: 'prompt' | 'resume' | 'wake' = 'prompt',
    run: ScheduledTurn = {},
  ): Promise<Turned> => {
    known(sessionId);
    if (turns.get(sessionId) !== undefined) throw acp.RequestError.invalidRequest({ sessionId }, 'a turn is already running');
    const resume = start !== 'prompt';
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
    const resumeAgent = meta?.[RESUME_AGENT_META];
    if (resumeAgent !== undefined && (typeof resumeAgent !== 'string' || resumeAgent === '')) throw acp.RequestError.invalidParams({ sessionId }, `${RESUME_AGENT_META} must be a subagent's session id`);
    const slash = target === undefined && rawLane === undefined && resumeAgent === undefined ? await commands.expand(sessionId, text) : undefined;
    if (slash?.kind === 'builtin') {
      let spent: Spent | undefined;
      const reply = await runBuiltin(slash, {
        setMode: (mode) => switchMode(from.client, sessionId, mode),
        schedule: (args) => scheduleCommand(sessionId, args),
        compact: async (focus) => {
          const outcome = await compactBetweenTurns(sessionId, focus);
          if (typeof outcome === 'string') return outcome;
          spent = addSpend(undefined, outcome);
          return '';
        },
      });
      if (reply !== '') await from.client.notify(acp.methods.client.session.update, { sessionId, update: textUpdate(reply) });
      return { end: 'end_turn', response: turnResponse('end_turn', usageOf(spent, undefined)) };
    }
    if (slash?.content.trim() === '') throw acp.RequestError.invalidParams({ sessionId }, `/${slash.command.name} expands to no text`);

    const controller = new AbortController();
    turns.set(sessionId, controller);
    let turnEnded = (_stopped: boolean) => {};
    turnEnds.set(sessionId, new Promise<boolean>((resolve) => (turnEnded = resolve)));
    let session: Session | undefined;
    const route: Route = { viewers, tasks, sessionId, signal: controller.signal, wake: wakeOf(sessionId) };
    let turn: Turn | undefined;
    let ended: TaskEnd = 'failed';
    let firstSeq = Number.POSITIVE_INFINITY;
    try {
      const header = await openSessionLog(store, sessionId, io);
      firstSeq = nextSeq(header.events);
      const lane = await laneAt(header.session.workspace, undefined).catch(() => undefined);
      const backend = header.session.backend;
      if (backend !== undefined && target !== undefined) throw acp.RequestError.invalidParams({ sessionId }, `${EXTERNAL_BACKENDS[backend.id].label} sessions take no inline edits`);
      if (backend !== undefined && hasAttached(attached)) throw acp.RequestError.invalidParams({ sessionId }, `${EXTERNAL_BACKENDS[backend.id].label} sessions take the prompt's text only, without mentions or attachments`);
      const shown = editorTurn(route, sessionId, from.peer, io, () => session, shownWidget(sessionId), lane !== undefined, backend?.id);
      turn = shown;
      live.set(sessionId, shown.live);
      tasks.start({
        sessionId,
        title: titleOf(header.events) ?? (target !== undefined ? 'Inline edit' : titleFrom(resume ? (header.events.findLast((e) => startsTurn(e) && isUsersOwn(e))?.content ?? '') : text)),
        workspace: header.session.workspace,
        lane: lane?.record.name ?? null,
        startedAt: Date.now(),
        ...(backend === undefined ? {} : { backend: backend.id }),
        ...forkOf(header.events),
      });
      const turnIo = { ...io, interrupts: () => controller.signal };
      const diagnostics = from.peer.diagnostics ? editorDiagnostics(route) : undefined;
      const editor = from.peer.editorActions ? editorActions(route) : undefined;
      const terminal = from.peer.terminals ? editorTerminals(route) : undefined;
      const ran = await serially(sessionId, async (): Promise<{ readonly reason: DoneReason; readonly spent?: Pick<acp.PromptResponse, 'usage' | '_meta'> }> => {
        if (backend !== undefined) {
          const log = await openSessionLog(store, sessionId, io);
          await dropTornTail(log);
          session = log.session;
          shown.live.events.push(...log.events);
          if (titleOf(log.events) === undefined && rawLane === undefined && !resume) shown.updates.send({ sessionUpdate: 'session_info_update', title: titleFrom(text) });
          if (rawLane !== undefined) {
            const repo = await laneRepoOf(log.session.workspace).catch(refused({ sessionId }));
            await applyLaneTurn(store, { log }, repo, rawLane, shown.surface.files, shown.surface.watcher, tasks, graft?.data.hunks).catch(refused({ lane: rawLane }));
            await shown.updates.flush();
            return { reason: 'end_turn' };
          }
          const result = await runExternalTurn({
            io: turnIo,
            store,
            log,
            prompt: slash?.content ?? text,
            approval: {
              kind: 'interactive',
              mode: () => modes.get(sessionId) ?? DEFAULT_SESSION_MODE,
              approve: shown.approve,
              classify: commandClassifier(io.env, io.fetch),
              auto: autoOf(sessionId),
            },
            surface: shown.surface,
            signal: controller.signal,
            agents: externals,
            keyOf: keyOf(sessionId),
          });
          await shown.updates.flush();
          return { reason: result.reason, spent: shown.usage() };
        }
        const resumed = await resumeSession(store, io, sessionId);
        session = resumed.log.session;
        // What woke the session; another turn may have taken it since the gate opened.
        const woken = start === 'wake' ? unwokenOf(resumed.log.events, wakes.registry.wakes(sessionId)).triggers : [];
        if (start === 'wake' && woken.length === 0) return { reason: 'end_turn' };
        // A scheduled run's budget holds for the turns it wakes too; the user's own prompt starts afresh.
        if (start === 'prompt') runLimits.delete(sessionId);
        if (run.limits !== undefined) runLimits.set(sessionId, run.limits);
        const turnLimits = runLimits.get(sessionId) ?? limits;
        const wakeLimits = start === 'wake' ? { ...turnLimits, countFrom: lastUserPromptSeq(resumed.log.events) } : turnLimits;
        const base = start === 'wake' ? await logWake(resumed, woken) : resumed;
        shown.live.events.push(...base.log.events);
        const wake = base.log.events.at(-1);
        if (start === 'wake' && wake?.kind === 'user') {
          shown.updates.send({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: wake.content }, _meta: wakeMetaOf(wake) });
        }
        if (titleOf(resumed.log.events) === undefined && target === undefined && rawLane === undefined && !resume) shown.updates.send({ sessionUpdate: 'session_info_update', title: titleFrom(text) });
        if (rawLane !== undefined) {
          const repo = await laneRepoOf(resumed.log.session.workspace).catch(refused({ sessionId }));
          await applyLaneTurn(store, resumed, repo, rawLane, shown.surface.files, shown.surface.watcher, tasks, graft?.data.hunks).catch(refused({ lane: rawLane }));
          await shown.updates.flush();
          return { reason: 'end_turn' };
        }
        const opened =
          target === undefined && (hasAttached(attached) || slash !== undefined)
            ? await logPrompt(store, base, slash?.content ?? text, attached, shown.surface.files, sessionId, slash)
            : base;
        const prompt = opened === base ? text : '';
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
                limits: wakeLimits,
                check: undefined,
                checkAfterEdit: true,
                approval,
                surface: shown.surface,
                diagnostics,
                mcp: (approval, grant) => mcp.toolset(sessionId, approval, grant),
                // Nobody is at a scheduled run to answer a card, and nobody wants the editor moved by one at 9:00.
                user: run.scheduled === true ? {} : shown.user,
                widgets: from.peer.widgets,
                spinoffs: from.peer.spinoffs,
                chapters: from.peer.chapters,
                editor: run.scheduled === true ? undefined : editor,
                terminal: run.scheduled === true ? undefined : terminal,
                schedules: from.peer.schedules && run.scheduled !== true ? await scheduleToolsFor(sessionId, header.session.workspace, shown) : undefined,
                scheduled: run.scheduled,
                director: run.director,
                workflows: from.peer.workflows && run.scheduled !== true && run.director === undefined ? workflowToolsFor(sessionId, header.session, shown) : undefined,
                externals,
                keyOf: keyOf(sessionId),
                hooks,
                trustedWorkspace: from.peer.trusted,
                sessionDirectories: directoriesOf(sessionId),
                resumeAgent,
                engine: { jobs, steers, ...(wakes.autoWake ? { wakes: { registry: wakes.registry, waiter: { pid: process.pid, cwd: io.cwd }, secondMs: wakes.policy.secondMs } } : {}) },
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
        return { reason: result.reason, spent: shown.usage() };
      });
      const end: TurnEnd = controller.signal.aborted ? 'cancelled' : ran.reason;
      ended = TURN_ENDS[end].task;
      const response = turnResponse(end, ran.spent ?? {});
      const logged = turn.live.events.findLast(startsTurn);
      if (logged === undefined || logged.seq < firstSeq) return { end, response };
      return { end, response: { ...response, _meta: { ...response._meta, [TURN_SEQ_META]: logged.seq } } };
    } finally {
      turnEnded(controller.signal.aborted);
      live.delete(sessionId);
      tasks.end(sessionId, controller.signal.aborted ? 'stopped' : ended, turn?.taskUsage(), wakes.view(sessionId));
      inbox.arrived(sessionId);
      // A session closed during its turn stays closed.
      if (turns.has(sessionId)) turns.set(sessionId, undefined);
      release(sessionId);
    }
  };

  const prompt = (params: acp.PromptRequest): Promise<acp.PromptResponse> => {
    known(params.sessionId);
    if (!viewers.isShown(params.sessionId)) viewers.show(params.sessionId, self());
    return runTurn(params.sessionId, params.prompt, params._meta, self()).then(({ response }) => response);
  };

  /** A prompt for the running turn, at its next tool round; one the turn ended without taking runs as the next turn. */
  const steer = async (params: acp.PromptRequest): Promise<acp.PromptResponse> => {
    const outcome = await steerRunning(steers, params.sessionId, params.prompt);
    if (outcome.kind === 'delivered') return { stopReason: 'end_turn', _meta: { [STEER_META]: outcome } };
    const { sessionId } = params;
    const { [STEER_META]: _, ...meta } = params._meta ?? {};
    const turn = (nextTurns.get(sessionId) ?? Promise.resolve())
      .then(() => turnEnds.get(sessionId))
      .then((stopped) => {
        // Stop stops: like a queued follow-up, a steer the stopped turn never took goes back to the user.
        if (stopped === true) throw acp.RequestError.invalidRequest({ sessionId }, 'the turn was stopped before the steer landed, so it did not run');
        return prompt({ ...params, _meta: meta });
      });
    const queued = turn.catch(() => {});
    nextTurns.set(sessionId, queued);
    void queued.then(() => {
      if (nextTurns.get(sessionId) === queued) nextTurns.delete(sessionId);
    });
    const response = await turn;
    return { ...response, _meta: { ...response._meta, [STEER_META]: outcome } };
  };

  /**
   * A new session in `where` running `prompt` in the background, as Run in a new lane, each Arena lane, a started
   * suggestion and a scheduled run start one. A `title` names it before its first prompt, so its task shows that title
   * from the start. A session in a lane is bound to it now, so the Lanes pane names the task from the first update on.
   */
  const startBackground = async (
    where: string,
    lane: LaneRecord | undefined,
    prompt: string,
    rawMode: string | undefined,
    how: { readonly variant?: VariantSpec | undefined; readonly parent?: string | undefined; readonly title?: string | undefined; readonly run?: ScheduledTurn | undefined; readonly workflow?: WorkflowOrigin | undefined } = {},
  ) => {
    const { variant, parent, title } = how;
    const log =
      variant?.backend !== undefined
        ? await startExternalSession(store, io, where, { id: variant.backend })
        : (await startSession(store, io, { workspace: where, provider: undefined, model: variant?.model ?? undefined, effort: variant?.effort ?? undefined, workflow: how.workflow })).log;
    const { id } = log.session;
    if (title !== undefined) await renameSession(store, io, id, title);
    const bound = lane === undefined ? undefined : await laneAt(lane.path, undefined);
    if (bound !== undefined) await bindSession(bound, id);
    const mode = rawMode !== undefined && isSessionMode(rawMode) ? rawMode : DEFAULT_SESSION_MODE;
    turns.set(id, undefined);
    modes.set(id, mode);
    if (mode !== DEFAULT_SESSION_MODE) await logSetting(id, { kind: 'mode', mode });
    if (variant?.backend !== undefined && variant.model !== null) await logSetting(id, { kind: 'backend-model', model: variant.model });
    mcp.register(id, where, [], undefined);
    io.err(lane === undefined ? `background: session ${id} in ${where}` : `lane: ${lane.name} at ${lane.path}, session ${id}`);
    if (parent !== undefined) tasks.adopt(id, parent);
    const turn = runTurn(id, [{ type: 'text', text: prompt }], undefined, self(), 'prompt', how.run);
    void turn.catch((error: unknown) => io.err(`session ${id}${lane === undefined ? '' : ` in lane ${lane.name}`}: ${String(error)}`));
    return { id, turn };
  };

  const startLaneSession = (lane: LaneRecord, prompt: string, rawMode: string | undefined, variant?: VariantSpec, parent?: string, title?: string) =>
    startBackground(lane.path, lane, prompt, rawMode, { variant, parent, title });

  /**
   * A scheduled task's run, as a new session: read-only in Plan in the main checkout, or in its own lane in Auto when
   * the task makes edits, held to the task's budget. Its end is read from its log once its turn is over.
   */
  const startScheduled = async (workspace: string, task: ScheduledTask) => {
    const repo = task.edits ? await laneRepo(workspace) : undefined;
    const lane = repo === undefined ? undefined : await laneFor(repo, task.prompt, store, io, laneNameFor(task.title, await takenLaneNames(repo)));
    const where = lane?.path ?? workspace;
    const limits: Limits = { maxTurns: task.budget.maxTurns, maxCostUsd: task.budget.maxCostUsd };
    const { id, turn } = await startBackground(where, lane, task.prompt, task.edits ? 'auto' : 'plan', { title: task.title, run: { limits, scheduled: true } });
    const ended: Promise<RunEnd> = turn.then(
      async ({ end }) => runEndOf((await existing(id)).events, TURN_ENDS[end].run, schedules.now()),
      (error: unknown) => ({ kind: 'failed', at: schedules.now(), costUsd: null, message: error instanceof Error ? error.message : String(error) }),
    );
    return { sessionId: id, workspace: where, lane: lane?.name ?? null, ended };
  };

  /** A session the engine may not hold open any more, such as one its window closed, before a turn of its own. */
  const reopen = async (sessionId: string) => {
    if (turns.has(sessionId)) return;
    const log = await existing(sessionId);
    turns.set(sessionId, undefined);
    if (!modes.has(sessionId)) modes.set(sessionId, sessionModeOf(log.events));
    mcp.register(sessionId, log.session.workspace, [], undefined);
  };

  /** A woken turn, which the gate opened; a turn that started meanwhile takes what arrived instead. */
  const wakeTurn = (sessionId: string) => {
    if (turns.get(sessionId) !== undefined) return;
    void reopen(sessionId)
      .then(() => runTurn(sessionId, [], undefined, self(), 'wake'))
      .catch((error: unknown) => io.err(`session ${sessionId}: the woken turn did not run: ${error instanceof Error ? error.message : String(error)}`));
  };

  /** This connection's way to start scheduled runs, once it said what it can show. */
  let runner: ScheduleRunner | undefined;

  /**
   * Runs on in the background each turn an engine that stopped left waiting, as the first editor connects. First it
   * tells each session of its subagents that engine cut off, which nothing resumes by itself.
   */
  const takeUpWaits = async () => {
    const cut = await recoverInterrupted(store, io.cwd, { serially }).catch((error: unknown) => {
      io.err(`could not look for subagents cut off: ${String(error)}`);
      return [];
    });
    for (const session of cut) {
      tasks.interrupted(session);
      io.err(`session: ${session.sessionId} has ${session.children.length === 1 ? '1 subagent' : `${session.children.length} subagents`} cut off when its last engine stopped`);
    }
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
      void runTurn(id, [], undefined, self(), 'resume').catch((error: unknown) => io.err(`session ${id}: ${String(error)}`));
    }
    const woken = await wakes.takeUp(store, io, io.cwd, { pid: process.pid, cwd: io.cwd }).catch((error: unknown) => {
      io.err(`could not look for wake-ups to take up: ${String(error)}`);
      return [];
    });
    for (const id of woken) io.err(`session: ${id} takes up the wake-ups its last engine left`);
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
      wakes.connected({ connection: shows, run: wakeTurn });
      const unlistenSchedules = schedules.listen((update) => {
        if (peer.schedules) void connection.client.notify(SCHEDULES_UPDATE_METHOD, update).catch(() => {});
      });
      void connection.closed.then(() => {
        unlisten();
        unlistenSchedules();
        arenaWatchers.delete(watch);
        wakes.disconnected(shows);
        schedules.disconnected(shows);
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
        backendEnv: _meta?.[BACKEND_ENV_CAPABILITY] === true,
        editorActions: _meta?.[EDITOR_ACTIONS_CAPABILITY] === true,
        terminals: _meta?.[READ_TERMINAL_CAPABILITY] === true,
        spinoffs: _meta?.[SPINOFF_CAPABILITY] === true,
        schedules: _meta?.[SCHEDULES_CAPABILITY] === true,
        chapters: _meta?.[CHAPTER_CAPABILITY] === true,
        workflows: _meta?.[WORKFLOWS_CAPABILITY] === true,
        trusted: _meta?.[WORKSPACE_TRUST_CAPABILITY] === true,
        mcpTokens: _meta?.[MCP_TOKEN_CAPABILITY] === true,
      };
      runner ??= { connection: self(), start: startScheduled };
      schedules.connected(runner);
      void rulesWorkspace(io.cwd, io.env['HOME'] || homedir())
        .then((workspace) => schedules.watch(workspace))
        .catch((error: unknown) => io.err(`schedules: could not watch ${io.cwd}: ${String(error)}`));
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {}, list: {}, delete: {}, close: {}, fork: {} },
          promptCapabilities: { embeddedContext: true, image: true },
          mcpCapabilities: { http: true, sse: true },
        },
        agentInfo: { name: 'gcode', version: '0.0.0' },
      };
    })
    .onRequest(acp.methods.agent.session.new, async ({ params, client }) => {
      const workspace = await workspaceDir(io.cwd, params.cwd);
      const asked = backendRequest.safeParse(params._meta?.[BACKEND_META]);
      const backendId = asked.success ? asked.data?.id : undefined;
      if (backendId !== undefined && !isExternalBackendId(backendId)) throw acp.RequestError.invalidParams({ backend: backendId }, `no backend ${backendId}`);
      if (backendId !== undefined) {
        const found = await findBackend(EXTERNAL_BACKENDS[backendId], io.env);
        if (found.kind === 'missing') throw acp.RequestError.invalidParams({ backend: backendId }, found.reason);
        const binding: BackendBinding = { id: backendId };
        const log = await startExternalSession(store, io, workspace, binding);
        const { id } = log.session;
        turns.set(id, undefined);
        modes.set(id, DEFAULT_SESSION_MODE);
        viewers.show(id, self());
        commands.attach(client, id, workspace);
        mcp.register(id, workspace, [], undefined);
        io.err(`session: ${id} on ${backendId} log: ${log.file}`);
        const fields = await externalFields(id, binding, log.events, self());
        return { sessionId: id, modes: modeState(DEFAULT_SESSION_MODE), configOptions: fields.configOptions, _meta: fields.meta };
      }
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
      if (context !== undefined && log.session.backend === undefined) await client.notify(acp.methods.client.session.update, { sessionId: id, update: usageUpdate(context) });
      io.err(`session: ${id} resumed, log: ${log.file}`);
      if (log.session.backend !== undefined) {
        const fields = await externalFields(id, log.session.backend, log.events);
        return { modes: modeState(modes.get(id)!), configOptions: fields.configOptions, _meta: { ...runningMeta(id)._meta, ...fields.meta } };
      }
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
        for (const job of jobs.views(id)) await notify(backgroundUpdate(job));
        const context = lastContextUse(log.session, events);
        if (context !== undefined && log.session.backend === undefined) await notify(usageUpdate(context));
        await notify(sessionInfo(summarizeSession(log.session, events)));
      } finally {
        replayed();
      }
      io.err(`session: ${id} loaded, log: ${log.file}`);
      if (log.session.backend !== undefined) {
        const fields = await externalFields(id, log.session.backend, log.events);
        return { modes: modeState(modes.get(id)!), configOptions: fields.configOptions, _meta: { ...runningMeta(id)._meta, ...fields.meta } };
      }
      return { modes: modeState(modes.get(id)!), configOptions: effortConfigOptions(sessionEffortOf(log.session, log.events)), ...runningMeta(id) };
    })
    .onRequest(acp.methods.agent.session.list, async ({ params }): Promise<acp.ListSessionsResponse> => {
      const scope: SessionScope = params.cwd == null ? { kind: 'all' } : { kind: 'project', workspace: await workspaceDir(io.cwd, params.cwd) };
      const sessions = await listSessions(store, io, scope);
      return { sessions: sessions.map(sessionInfoOf) };
    })
    .onRequest(SEARCH_SESSIONS_METHOD, searchRequest, async ({ params }): Promise<SearchSessionsResponse> => {
      const scope: SessionScope = params.cwd == null ? { kind: 'all' } : { kind: 'project', workspace: await workspaceDir(io.cwd, params.cwd) };
      return { hits: await sessionIndex(store).search(params.query, scope, HISTORY_SEARCH, io.err) };
    })
    .onRequest(acp.methods.agent.session.delete, async ({ params }) => {
      const { sessionId } = params;
      if (turns.get(sessionId) !== undefined) throw acp.RequestError.invalidRequest({ sessionId }, 'stop the running turn before deleting its session');
      await existing(sessionId);
      wakes.registry.forget(sessionId);
      await jobs.kill('session-deleted', { sessionId });
      const trashed = await serially(sessionId, () => trashSession(store, io, sessionId));
      turns.delete(sessionId);
      modes.delete(sessionId);
      viewers.hide(sessionId);
      externals.close(sessionId);
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
      externals.close(sessionId);
      await mcp.close(sessionId);
      return {};
    })
    .onRequest(RETRY_NOW_METHOD, sessionRequest, async ({ params }): Promise<RetryNowResponse> => ({ retried: retries.get(params.sessionId)?.wake() ?? false }))
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
      const log = await existing(sessionId);
      if (log.session.backend !== undefined) {
        if (params.configId !== MODEL_CONFIG_ID || typeof params.value !== 'string') throw acp.RequestError.invalidParams({ configId: params.configId }, `an external session sets only ${MODEL_CONFIG_ID}`);
        const setup = externals.setupOf(sessionId);
        if (setup?.models !== undefined && !setup.models.available.some((m) => m.id === params.value)) throw acp.RequestError.invalidParams({ value: params.value }, `${EXTERNAL_BACKENDS[log.session.backend.id].label} offers no model ${String(params.value)}`);
        await logSetting(sessionId, { kind: 'backend-model', model: params.value });
        await externals.setModel(sessionId, params.value);
        return { configOptions: modelConfigOptions(setup, params.value) };
      }
      const effort = chosenEffort(params);
      await logSetting(sessionId, { kind: 'effort', effort });
      return { configOptions: effortConfigOptions(effort) };
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params }) => {
      if (params._meta?.[STEER_META] === true) return steer(params);
      return prompt(params);
    })
    .onNotification(DRAFT_METHOD, draftNotice, ({ params }) => wakes.draft(params.sessionId, self(), params.typing))
    .onRequest(WAKE_CANCEL_METHOD, wakeCancelRequest, async ({ params }) => {
      const { sessionId } = params;
      known(sessionId);
      wakes.registry.cancel(sessionId);
      // Logged, so what arrived before the Cancel wakes nothing either, and a wake-up is not taken up after a restart.
      await serially(sessionId, async () => {
        const log = await openSessionLog(store, sessionId, io);
        await dropTornTail(log);
        await appendEvent(log.file, { kind: 'wake', seq: nextSeq(log.events), at: new Date().toISOString(), note: { kind: 'cancelled' } });
      });
      wakes.soon(sessionId);
      return {};
    })
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      turns.get(params.sessionId)?.abort();
      childCancels.get(params.sessionId)?.();
    })
    .onRequest(TASKS_METHOD, z.object({}).loose(), async (): Promise<TasksResponse> => tasks.list())
    .onRequest(SCHEDULES_METHOD, schedulesRequest, async ({ params }): Promise<SchedulesResponse> => schedules.list(await scheduleWorkspace(params.cwd)))
    .onRequest(SCHEDULE_ACT_METHOD, scheduleActRequest, async ({ params }): Promise<SchedulesResponse> =>
      schedules.act(await scheduleWorkspace(params.cwd), params.id, params.action, runner).catch(refused(params)),
    )
    .onRequest(BACKENDS_METHOD, z.object({}).loose(), async (): Promise<BackendsResponse> => ({ backends: await backendInfos(io.env) }))
    .onRequest(BACKGROUND_STOP_METHOD, backgroundStopRequest, async ({ params }) => {
      await jobs.stop(params.sessionId, params.id, 'user').catch((error: unknown) => {
        if (error instanceof ToolError) throw acp.RequestError.invalidParams(params, error.message);
        throw error;
      });
      return {};
    })
    .onRequest(LANES_METHOD, lanesRequest, async ({ params }): Promise<LanesResponse> => ({ lanes: await laneInfos(await laneRepo(params.cwd), store, io, tasks) }))
    .onRequest(LANE_NEW_METHOD, lanePrompt, async ({ params }): Promise<LaneNewResponse> => {
      const repo = await laneRepo(params.cwd);
      const lane = await laneFor(repo, params.prompt, store, io).catch(refused({ cwd: params.cwd }));
      const { id } = await startLaneSession(lane, params.prompt, params.mode);
      return { name: lane.name, sessionId: id };
    })
    .onRequest(SPINOFF_START_METHOD, spinoffRequest, async ({ params }): Promise<SpinoffResponse> => {
      const { sessionId } = params;
      const spinoff = await openSpinoff(sessionId, params.id);
      const key = `${sessionId}/${spinoff.id}`;
      if (startingSpinoffs.has(key)) throw acp.RequestError.invalidParams(params, `${spinoff.id} is already starting`);
      startingSpinoffs.add(key);
      try {
        const repo = await laneRepo(spinoff.workspace);
        const lane = await laneFor(repo, spinoff.prompt, store, io, laneNameFor(spinoff.title, await takenLaneNames(repo))).catch(refused(params));
        const { id } = await startLaneSession(lane, spinoff.prompt, params.mode, undefined, undefined, spinoff.title);
        return { spinoff: await decideSpinoff(sessionId, spinoff, { kind: 'started', sessionId: id, lane: lane.name }) };
      } finally {
        startingSpinoffs.delete(key);
      }
    })
    .onRequest(SPINOFF_DISMISS_METHOD, spinoffRequest, async ({ params }): Promise<SpinoffResponse> => ({
      spinoff: await decideSpinoff(params.sessionId, await openSpinoff(params.sessionId, params.id), { kind: 'dismissed' }),
    }))
    .onRequest(CHAPTER_MARK_METHOD, chapterRequest, async ({ params }): Promise<ChapterMarkResponse> => {
      const parsed = params.mark === null ? ({ ok: true, value: null } as const) : parseChapterMark(params.mark);
      if (!parsed.ok) throw acp.RequestError.invalidParams(params, parsed.problem);
      const log = await existing(params.sessionId);
      if (promptAt(log.events, params.turnSeq) === undefined) throw acp.RequestError.invalidParams(params, `no message of the user's starts a turn at ${params.turnSeq}`);
      const change = { kind: 'chapter', turnSeq: params.turnSeq, mark: parsed.value } as const;
      // Logged at once, turn or no turn, as a spin-off decision is; only a torn tail waits for the log's next writer.
      if (!(await logBesideTurn(log, change))) await logSetting(params.sessionId, change);
      return { mark: parsed.value };
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
            return { sessionId: id, ended: turn.then(({ end }) => TURN_ENDS[end].lane) };
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
      await jobs.kill('lane-discarded', { cwd: lane.path });
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
      const checkpoint = params.sha === undefined ? checkpointFor(log.events, params) : checkpointsOf(log.events).find((c) => c.sha === params.sha);
      if (params.sha !== undefined && checkpoint === undefined) throw acp.RequestError.invalidParams({ sha: params.sha }, 'no such checkpoint in this session');
      const file = await realpath(params.path).catch(() => params.path);
      const relative = path.relative(log.session.workspace, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw acp.RequestError.invalidParams({ path: params.path }, 'outside the workspace');
      if (checkpoint === undefined) return { text: await DISK_FILES.read(file) };
      return { text: await fileAt(shadowRepoFor(store, log.session.workspace), checkpoint.sha, relative) };
    })
    .onRequest(REWIND_METHOD, rewindRequest, async ({ params }): Promise<RewindResponse> => {
      const { sessionId } = params;
      known(sessionId);
      if (turns.get(sessionId) !== undefined) throw acp.RequestError.invalidRequest({ sessionId }, 'stop the running turn before undoing the session');
      return serially(sessionId, async () => {
        const log = await openSessionLog(store, sessionId, io);
        const checkpoint = checkpointFor(log.events, params);
        if (checkpoint === undefined) return { files: [] };
        const { files } = await rewindTo(store, log, checkpoint.turnSeq);
        return { files: files.map((file) => path.join(log.session.workspace, file)) };
      });
    })
    .onRequest(USAGE_METHOD, usageRequest, async ({ params }): Promise<UsageResponse> => {
      known(params.sessionId);
      return sessionSpend((await openSessionLog(store, params.sessionId, io)).events);
    })
    .onRequest(PR_STATUS_METHOD, prStatusRequest, async ({ params }): Promise<PrStatusResponse> => {
      if (!(await stat(params.cwd).then((s) => s.isDirectory(), () => false))) throw acp.RequestError.invalidParams({ cwd: params.cwd }, 'not a folder');
      return lookUpPr(gh, params.cwd, githubRemote);
    })
    .onRequest(REWIND_PREVIEW_METHOD, rewindPreviewRequest, async ({ params }): Promise<RewindPreviewResponse> => {
      const { sessionId, turnSeq } = params;
      known(sessionId);
      return serially(sessionId, async () => {
        const log = await openSessionLog(store, sessionId, io);
        return rewindPreview(store, log, turnSeq).catch(refused({ turnSeq }));
      });
    })
    .onRequest(REWIND_TURN_METHOD, rewindTurnRequest, async ({ params }): Promise<RewindTurnResponse> => {
      const { sessionId, turnSeq, choice } = params;
      known(sessionId);
      if (turns.get(sessionId) !== undefined) throw acp.RequestError.invalidRequest({ sessionId }, 'stop the running turn before rewinding the session');
      return serially(sessionId, async () => {
        const log = await openSessionLog(store, sessionId, io);
        if (choice.kind !== 'files') {
          // A cut turn's background commands have no turn left to report to.
          const cut = toolUsesFrom(log.events, turnSeq);
          wakes.registry.cancel(sessionId, cut);
          for (const job of jobs.views(sessionId)) if (cut.has(job.toolUseId)) await jobs.stop(sessionId, job.id, 'user').catch(() => {});
        }
        return rewindSession(store, log, turnSeq, choice).catch(refused({ turnSeq }));
      });
    })
    .onRequest(acp.methods.agent.session.fork, async ({ params }): Promise<acp.ForkSessionResponse> => {
      const { sessionId } = params;
      const source = await existing(sessionId);
      if (turns.get(sessionId) !== undefined) throw acp.RequestError.invalidRequest({ sessionId }, 'stop the running turn before forking the session');
      const at = forkAt.safeParse(params._meta?.[FORK_AT_META]);
      if (!at.success) throw acp.RequestError.invalidParams({ [FORK_AT_META]: params._meta?.[FORK_AT_META] }, `${FORK_AT_META} must be an event number`);
      const turnSeq = at.data ?? source.events.findLast(startsTurn)?.seq;
      if (turnSeq === undefined) throw acp.RequestError.invalidRequest({ sessionId }, 'the session has no turn to fork');
      const log = await serially(sessionId, () => forkSession(store, source, turnSeq)).catch(refused({ turnSeq }));
      const id = log.session.id;
      const mode = sessionModeOf(log.events);
      turns.set(id, undefined);
      modes.set(id, mode);
      mcp.register(id, log.session.workspace, params.mcpServers ?? [], browserSettingsOf(params._meta));
      io.err(`session: ${id} forked from ${sessionId} at ${turnSeq}, log: ${log.file}`);
      return { sessionId: id, modes: modeState(mode), configOptions: effortConfigOptions(sessionEffortOf(log.session, log.events)) };
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
    .onRequest(HOOKS_METHOD, permissionsRequest, async ({ params }): Promise<HooksResponse> => {
      const workspace = await workspaceDir(io.cwd, params.cwd).catch(refused({ cwd: params.cwd }));
      const config = await loadHookConfig({ claudeDir: claudeDirOf(io.env), appHome: homeOf(store), workspace, plugins: (await pluginsOf(workspace)).plugins });
      return { workspace, trusted: peer.trusted, hooks: hookRows(config.entries, peer.trusted), problems: config.problems };
    })
    .onRequest(PERMISSIONS_METHOD, permissionsRequest, async ({ params }): Promise<PermissionsResponse> => {
      const { rules, answer } = await permissionsOf(params.cwd);
      return answer(rules.list());
    })
    .onRequest(PERMISSION_ADD_METHOD, permissionAddRequest, async ({ params }): Promise<PermissionsResponse> => {
      const { rules, scope, answer } = await permissionsOf(params.cwd);
      const parsed = parseRule(params.effect, params.text, scope);
      if (!parsed.ok) throw acp.RequestError.invalidParams({ text: params.text }, parsed.reason);
      return answer(rules.add(parsed.rule));
    })
    .onRequest(PERMISSION_REMOVE_METHOD, permissionRemoveRequest, async ({ params }): Promise<PermissionsResponse> => {
      const { rules, answer } = await permissionsOf(params.cwd);
      return answer(rules.remove(params.id));
    })
    .onRequest(SKILLS_METHOD, skillsRequest, ({ params }): Promise<SkillsResponse> => catalog.skills(params.cwd).catch(refused({ cwd: params.cwd })))
    .onRequest(CATALOG_SEARCH_METHOD, catalogSearchRequest, ({ params }): Promise<CatalogSearchResponse> =>
      catalog.search(params.cwd, params.catalogs, params.query).catch(refused({ cwd: params.cwd })),
    )
    .onRequest(CATALOG_PREVIEW_METHOD, catalogItemRequest, ({ params }): Promise<CatalogPreviewResponse> => catalog.preview(params).catch(refused({ name: params.name })))
    .onRequest(CATALOG_INSTALL_METHOD, catalogInstallRequest, ({ params }): Promise<CatalogInstallResponse> => catalog.install(params).catch(refused({ name: params.name })))
    .onRequest(CATALOG_UNINSTALL_METHOD, catalogUninstallRequest, ({ params }): Promise<CatalogUninstallResponse> =>
      catalog.uninstall(params.cwd, params.id).catch(refused({ id: params.id })),
    )
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
    })
    .onRequest(MCP_RECONNECT_METHOD, mcpReconnectRequest, async ({ params }): Promise<McpServersResponse> => {
      known(params.sessionId);
      return mcp.reconnect(params.sessionId, params.name).catch((error: unknown) => {
        throw acp.RequestError.invalidParams({ name: params.name }, error instanceof Error ? error.message : String(error));
      });
    });
}
