import { realpath } from 'node:fs/promises';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { z } from 'zod';
import {
  afterLines,
  DIAGNOSTICS_METHOD,
  EDITOR_ACTION_METHOD,
  HUNK_STATUSES,
  hunkIdOf,
  APPROVAL_META,
  askUserContent,
  ASK_USER_META,
  askUserTitle,
  parseAskUser,
  BROWSER_SERVER,
  INLINE_EDIT_META,
  MEMORY_SCOPES,
  REMEMBER_META,
  RENAME_SESSION_METHOD,
  SEARCH_SESSIONS_METHOD,
  type SearchSessionsRequest,
  REPLAYED_AT_META,
  REPLAYED_CHANGE_META,
  REPLAYED_TURN_META,
  WAKE_META,
  DRAFT_METHOD,
  type DraftNotice,
  SESSION_SUMMARY_META,
  TOOL_CALL_META,
  TURN_USAGE_META,
  TURN_SEQ_META,
  UNSAVED_BUFFERS_METHOD,
  type AskUserAnswer,
  type FileChange,
  type HunkId,
  type HunkStatus,
  type InlineEditTarget,
  type RenameSessionRequest,
  DETACH_METHOD,
  isLive,
  LANE_APPLY_META,
  LANE_ROOT,
  laneApplyPrompt,
  NOT_SHOWN_ERROR,
  RUNNING_META,
  TASK_STATUSES,
  TASK_KINDS,
  TASK_UPDATE_METHOD,
  ARENA_UPDATE_METHOD,
  LANE_GRAFT_META,
  laneGraftPrompt,
  type DetachRequest,
  type TaskRecord,
  WAIT_KINDS,
  WAITING_META,
  BACKGROUND_META,
  BACKGROUND_STOP_METHOD,
  isJobId,
  isWakeId,
  type BackgroundStopRequest,
  RETRY_NOW_METHOD,
  type RetryNowRequest,
  type RetryNowResponse,
  BACKEND_ENV_METHOD,
  BACKEND_META,
  BACKENDS_METHOD,
  EXTERNAL_BACKEND_IDS,
  type BackendEnvResponse,
  type BackendId,
  type BackendShown,
  type BackendsResponse,
  type ExternalBackendId,
  asSessionId,
} from '@g-code/core';
import { KEEP_COMMAND, OPEN_CHANGE_COMMAND, UNDO_COMMAND, UNDO_TURN_COMMAND } from '../review/controller.js';
import { DEFAULT_REVIEW_MODE, REVIEW_MODE_SETTING, REVIEW_MODES, type ReviewMode } from '../review/mode.js';
import { REVEAL_COMMAND } from '../review/tree.js';
import { currentBranch } from '../git-branch.js';
import type { AttachmentView, OutgoingAttachment } from './attachment-model.js';
import { droppedUris, imagesOf, openTarget, pickFiles, promptBlocks, readForComposer, sessionsDir, viewsOf, webviewRoots } from './attachments.js';
import { diagnostics, readTextFile, unsavedBuffers, writeTextFile } from './bridge.js';
import { openDiagram } from './diagram-tab.js';
import { Engine, type Connection, type EngineSettings } from './engine.js';
import { formatCost, formatTokens } from './format.js';
import { ContextPanes } from './context-host.js';
import { PermissionsHost } from './permissions-host.js';
import { browserMeta, browserSettings } from './browser.js';
import { McpServers } from './mcp-host.js';
import { setRole, type SettingsPage } from './settings-host.js';
import { ComposerHost } from './composer-host.js';
import type { SeenStore } from './seen.js';
import { TaskHost } from './tasks-host.js';
import { ArenaHost, arenaUpdate } from './arena-host.js';
import type { SettingsToView } from './settings-model.js';
import { Mentions } from './context.js';
import {
  TOOL_KINDS,
  CHAT_DETAILS,
  UI_STYLES,
  type Action,
  type FileDiff,
  type FromView,
  type Header,
  type HistoryHit,
  type HistoryRow,
  type HistoryScope,
  type Modes,
  type ToView,
  type ToolKind,
  type ToolStatus,
  type Transcript,
  type TurnStatus,
  type ChatDetail,
  type Look,
  type UiStyle,
  type Usage,
} from './messages.js';
import { pageHtml } from './page.js';
import { BUILTIN_OPTIONS, commandOptions, routeText, type EditorAction } from './slash-route.js';
import type { CommandOption, SentCommand } from './slash.js';
import { isChildAction, subagentAction } from './subagent-host.js';
import { SteerHost, steerActionOf } from './steer-host.js';
import { RewindHost } from './rewind-host.js';
import { UsageHost } from './usage-host.js';
import { childOf, emptyTranscript, reduce, totalsOf } from './transcript.js';
import { widgetHost } from './widget-host.js';
import { widgetOf } from './widget-model.js';
import { editorActionOf, editorActionRequest, runEditorAction } from './editor-actions.js';
import { todoOfUpdate } from './todo-model.js';

export const CHAT_VIEW = 'gcode.chat';
export const SEND_COMMAND = 'gcode.chat.send';
export const STOP_COMMAND = 'gcode.chat.stop';
export const NEW_CHAT_COMMAND = 'gcode.chat.new';
export const HISTORY_COMMAND = 'gcode.chat.history';
export const MCP_COMMAND = 'gcode.chat.mcp';
export const LANES_COMMAND = 'gcode.chat.lanes';
export const TASKS_COMMAND = 'gcode.chat.tasks';
/** The settings the panel's look comes from. */
export const LOOK_SETTINGS = ['gcode.ui.style', 'gcode.chat.detail', REVIEW_MODE_SETTING] as const;
export const APPROVAL_MODE_SETTING = 'gcode.approvalMode';

/** What Start building sends once the session has left Plan. */
export const START_BUILDING_PROMPT = 'Go ahead with the plan.';

/** The approval modes the engine advertises, until it says so itself. */
const MODE_FALLBACK: Modes['available'] = [
  { id: 'plan', name: 'Plan', description: 'Read the code and plan the change without changing anything.' },
  { id: 'ask', name: 'Ask', description: 'Ask before risky commands.' },
  { id: 'auto', name: 'Auto', description: 'Run safe commands on its own and let a classifier judge the rest.' },
];

/** The mode new sessions start in, from settings; anything but auto is ask. */
export function approvalModeOf(configuration: vscode.WorkspaceConfiguration): 'ask' | 'auto' {
  return configuration.get<string>('approvalMode') === 'auto' ? 'auto' : 'ask';
}

const known = <T extends string>(values: readonly T[], value: string | undefined, fallback: T): T =>
  (values as readonly (string | undefined)[]).includes(value) ? (value as T) : fallback;

/** The panel's look from settings; an unknown value falls back to the default, glass, compact and auto review. */
export const lookOf = (configuration: vscode.WorkspaceConfiguration): Look => ({
  style: known<UiStyle>(UI_STYLES, configuration.get<string>('ui.style'), 'glass'),
  detail: known<ChatDetail>(CHAT_DETAILS, configuration.get<string>('chat.detail'), 'compact'),
  review: reviewModeOf(configuration),
});

export const reviewModeOf = (configuration: vscode.WorkspaceConfiguration): ReviewMode =>
  known<ReviewMode>(REVIEW_MODES, configuration.get<string>('review.mode'), DEFAULT_REVIEW_MODE);

const diagnosticsRequest = z.object({ sessionId: z.string(), paths: z.array(z.string()) });
const unsavedBuffersRequest = z.object({ sessionId: z.string() });
const turnUsage = z.object({ model: z.string(), costUsd: z.number().nullable() });
const permissionInput = z.object({ command: z.string(), reason: z.string(), description: z.string().optional(), rule: z.string().optional() });

const bashInput = z.object({ description: z.string() });

/** A bash call's description, from the model's own input; display only. */
const descriptionOf = (name: string, rawInput: unknown): { readonly description?: string } => {
  const input = name === 'bash' ? bashInput.safeParse(rawInput) : undefined;
  return input?.success === true ? { description: input.data.description } : {};
};
const rememberInput = z.object({ text: z.string(), scope: z.enum(MEMORY_SCOPES) });
const replayedTurn = z.object({
  seq: z.number().int().optional(),
  mode: z.string().optional(),
  startedAt: z.number(),
  endedAt: z.number(),
  status: z.enum(['done', 'stopped', 'failed']),
  usage: z.object({ model: z.string(), inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number().nullable() }).nullable(),
  command: z.object({ name: z.string(), args: z.string() }).optional(),
});
const replayedChange = z.object({
  id: z.string(),
  path: z.string(),
  hunks: z.array(z.object({ startLine: z.number(), lineCount: z.number(), oldText: z.string(), newText: z.string(), status: z.enum(HUNK_STATUSES) })),
});
const sessionSummary = z.object({ turns: z.number(), costUsd: z.number().nullable(), forkedFrom: z.object({ sessionId: z.string(), title: z.string() }).optional() });
const waitingSchema = z.object({ kind: z.enum(WAIT_KINDS), since: z.number(), retryAt: z.number().nullable(), resetAt: z.number().nullable(), message: z.string() });
const killCause = z.enum(['session-deleted', 'lane-discarded', 'engine-exit']);
const stopBy = z.enum(['model', 'user']);
const jobState = z.discriminatedUnion('status', [
  z.object({ status: z.literal('running'), ending: z.discriminatedUnion('kind', [z.object({ kind: z.literal('stop'), by: stopBy }), z.object({ kind: z.literal('kill'), cause: killCause })]).optional() }),
  z.object({ status: z.literal('exited'), exitCode: z.number().nullable(), signal: z.string().nullable() }),
  z.object({ status: z.literal('stopped'), by: stopBy }),
  z.object({ status: z.literal('killed'), cause: killCause }),
]);
const backgroundView = z.object({ id: z.string(), toolUseId: z.string(), state: jobState, tail: z.string() });
const taskJob = z.object({ id: z.string().refine(isJobId), command: z.string(), description: z.string().optional(), startedAt: z.number() });

const wakeMark = z.object({ seq: z.number(), label: z.string() });
const forkOrigin = z.object({ sessionId: z.string().transform(asSessionId), turnSeq: z.number(), title: z.string() });
const searchHits = z.object({
  hits: z.array(
    z.object({
      sessionId: z.string(),
      turn: z.object({ turn: z.number(), seq: z.number(), at: z.string() }).nullable(),
      snippet: z.object({ text: z.string(), marks: z.array(z.tuple([z.number(), z.number()])) }),
      matchingTurns: z.number(),
    }),
  ),
});
const wakeId = z.string().refine(isWakeId);
const jobId = z.string().refine(isJobId);
const wakeSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('children'), child: z.string(), agent: z.string() }),
  z.object({ kind: z.literal('jobs'), job: jobId }),
  z.object({ kind: z.literal('monitor'), id: wakeId, job: jobId, pattern: z.string() }),
  z.object({ kind: z.literal('schedule'), id: wakeId, dueAt: z.number() }),
]);
const wakeView = z.object({ waitsFor: z.array(wakeSource), paused: z.enum(['cap', 'limit', 'stopped', 'failed']).optional() });

const taskUpdate = z.object({
  task: z.object({
    sessionId: z.string(),
    title: z.string(),
    workspace: z.string(),
    lane: z.string().nullable(),
    status: z.enum(TASK_STATUSES),
    startedAt: z.number(),
    endedAt: z.number().nullable(),
    usage: z.object({ model: z.string(), inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number().nullable() }).optional(),
    waiting: waitingSchema.optional(),
    asking: z.enum(['permission', 'question']).optional(),
    parent: z.string().nullable().optional(),
    kind: z.enum(TASK_KINDS).optional(),
    returnedAt: z.number().nullable().optional(),
    backend: z.enum(EXTERNAL_BACKEND_IDS).optional(),
    jobs: z.array(taskJob).optional(),
    forkedFrom: forkOrigin.optional(),
    wake: wakeView.optional(),
  }),
  notice: z.enum(['done', 'needs-input', 'failed']).nullable(),
});
// The parse drops a field it does not name, so a field TaskRecord gains must be named above; U43 lost `parent` that way.
const namesEveryTaskField: Exclude<keyof TaskRecord, keyof z.infer<typeof taskUpdate>['task']> extends never ? true : never = true;
void namesEveryTaskField;

const backendShown = z.object({ id: z.enum(EXTERNAL_BACKEND_IDS), label: z.string(), plan: z.string(), lane: z.string().nullable() });
const backendEnvRequest = z.object({ backend: z.enum(EXTERNAL_BACKEND_IDS) });

/** The backend a session response or info update names under BACKEND_META; undefined for Geno's own loop. */
const backendOf = (meta: Record<string, unknown> | null | undefined): BackendShown | undefined => {
  const parsed = backendShown.safeParse(meta?.[BACKEND_META]);
  return parsed.success ? parsed.data : undefined;
};

/** How a turn the panel adopted after a reload ends, by the status its task ended in. */
const ADOPTED_ENDS: Readonly<Record<TaskRecord['status'], Exclude<TurnStatus, 'streaming'> | undefined>> = {
  running: undefined,
  'needs-input': undefined,
  waiting: undefined,
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
};

const approvalRecord = z.object({
  decidedBy: z.enum(['rule', 'classifier', 'user']),
  verdict: z.enum(['allow', 'deny']),
  classifier: z.object({ reason: z.string() }).optional(),
});

/** A flagged command the classifier settled, which the step shows; one the user or a rule settled shows nothing more. */
function autoOf(meta: Record<string, unknown> | null | undefined): Extract<Action, { type: 'tool' }>['auto'] {
  const record = approvalRecord.safeParse(meta?.[APPROVAL_META]);
  if (!record.success || record.data.decidedBy !== 'classifier' || record.data.classifier === undefined) return undefined;
  return { verdict: record.data.verdict, reason: record.data.classifier.reason };
}

/** The classifier's reason in a permission question it would not answer itself, as the engine words it. */
const classifierReasonOf = (title: string | null | undefined): string | undefined => /The classifier says: (.+)\.$/.exec(title ?? '')?.[1];

const modesOf = (state: acp.SessionModeState | null | undefined): Modes | undefined =>
  state == null
    ? undefined
    : { current: state.currentModeId, available: state.availableModes.map(({ id, name, description }) => ({ id, name, description: description ?? undefined })) };

const TOOL_STATUSES: Readonly<Record<acp.ToolCallStatus, ToolStatus>> = { pending: 'running', in_progress: 'running', completed: 'completed', failed: 'failed' };

const kindOf = (kind: acp.ToolKind | null | undefined): ToolKind => ((TOOL_KINDS as readonly string[]).includes(kind ?? '') ? (kind as ToolKind) : 'other');

/** The engine titles a call as the CLI shows it, `<tool> <target>`, as in `edit math.ts`. */
function callOf(title: string): { readonly name: string; readonly target: string } {
  const space = title.indexOf(' ');
  return space === -1 ? { name: title, target: '' } : { name: title.slice(0, space), target: title.slice(space + 1) };
}

function outputOf(content: readonly acp.ToolCallContent[] | null | undefined): string | undefined {
  const texts = (content ?? []).flatMap((c) => (c.type === 'content' && c.content.type === 'text' ? [c.content.text] : []));
  return texts.length === 0 ? undefined : texts.join('\n');
}

type UpdateOf<K extends acp.SessionUpdate['sessionUpdate']> = Extract<acp.SessionUpdate, { sessionUpdate: K }>;

const UPDATES: { readonly [K in acp.SessionUpdate['sessionUpdate']]?: (update: UpdateOf<K>, at: number) => Action | undefined } = {
  user_message_chunk: (update) => steerActionOf(update),
  agent_message_chunk: ({ content }) => (content.type === 'text' ? { type: 'text', text: content.text } : undefined),
  notice: ({ title, _meta }, at) => {
    if (_meta == null || !(WAITING_META in _meta)) return { type: 'notice', text: title };
    const waiting = waitingSchema.nullable().safeParse(_meta[WAITING_META]);
    return waiting.success ? { type: 'waiting', at, waiting: waiting.data } : undefined;
  },
  tool_call: ({ toolCallId, title, kind, status, rawInput }, at) => {
    const call = callOf(title);
    return { type: 'tool', id: toolCallId, at, ...call, ...descriptionOf(call.name, rawInput), toolKind: kindOf(kind), status: TOOL_STATUSES[status ?? 'pending'] };
  },
  tool_call_update: ({ toolCallId, title, status, content, _meta }, at) => {
    const output = outputOf(content);
    const images = imagesOf(content);
    const auto = autoOf(_meta);
    return {
      type: 'tool',
      id: toolCallId,
      at,
      ...(title == null ? {} : callOf(title)),
      ...(status == null ? {} : { status: TOOL_STATUSES[status] }),
      ...(output === undefined ? {} : { output }),
      ...(images.length === 0 ? {} : { images }),
      ...(auto === undefined ? {} : { auto }),
    };
  },
};

function actionOf<K extends acp.SessionUpdate['sessionUpdate']>(update: UpdateOf<K>, at: number): Action | undefined {
  const action = (UPDATES[update.sessionUpdate] as ((u: UpdateOf<K>, at: number) => Action | undefined) | undefined)?.(update, at);
  if (action?.type !== 'tool') return action;
  const widget = widgetOf(update);
  const editorAction = update.sessionUpdate === 'tool_call_update' ? editorActionOf(update._meta) : undefined;
  const todo = todoOfUpdate(update);
  return { ...action, ...(widget === undefined ? {} : { widget }), ...(editorAction === undefined ? {} : { editorAction }), ...(todo === undefined ? {} : { todo }) };
}

/** When an update happened: now, or for a replayed tool call, when it was logged. */
const timeOf = (update: acp.SessionUpdate): number => {
  const at = update._meta?.[REPLAYED_AT_META];
  return typeof at === 'number' ? at : Date.now();
};

/** How a turn's stop reason shows: its status, and what to tell the user when it did not simply finish. */
const ENDINGS: Readonly<Record<acp.StopReason, { readonly status: Exclude<TurnStatus, 'streaming'>; readonly message?: string }>> = {
  end_turn: { status: 'done' },
  cancelled: { status: 'stopped' },
  refusal: { status: 'failed', message: 'The model declined to continue.' },
  max_tokens: { status: 'failed', message: 'The model reached its output limit.' },
  max_turn_requests: { status: 'failed', message: 'The turn reached its limit on model calls or cost. Send a message to continue.' },
};

/** The engine's account of a turn: ACP's token counts, and the model and cost it adds under `_meta`. */
function usageOf(response: acp.PromptResponse): Usage | undefined {
  const meta = turnUsage.safeParse(response._meta?.[TURN_USAGE_META]);
  if (response.usage == null || !meta.success) return undefined;
  const { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens } = response.usage;
  return { model: meta.data.model, inputTokens: inputTokens + (cachedReadTokens ?? 0) + (cachedWriteTokens ?? 0), outputTokens, costUsd: meta.data.costUsd };
}

const linesOf = (text: string): string[] => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));

function diffOf(file: vscode.Uri, change: FileChange): FileDiff {
  const lines = afterLines(change);
  return {
    path: vscode.workspace.asRelativePath(file),
    change: change.id,
    hunks: change.hunks.map((hunk, i) => ({ id: hunkIdOf(change, i), line: lines[i]!, removed: linesOf(hunk.oldText), added: linesOf(hunk.newText), status: hunk.status })),
  };
}

async function headerOf(title: string | undefined): Promise<Header> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return { project: folder?.name ?? 'No folder', title, branch: folder === undefined ? undefined : await currentBranch(folder.uri.fsPath) };
}

/** A replayed turn's end, which ACP has no update for: the engine sends it with the prompt that starts the turn. */
function replayedEnd(update: acp.SessionUpdate): Action | undefined {
  const turn = replayedTurn.safeParse(update._meta?.[REPLAYED_TURN_META]);
  if (!turn.success) return undefined;
  const { endedAt, status, usage } = turn.data;
  return { type: 'turn-end', at: endedAt, status, usage: usage ?? undefined };
}

/**
 * A session being loaded: its replayed turns build a transcript of their own, shown in one piece when the load ends.
 * The SDK delivers a session's updates in order but apart from the load's response, so the replay is over once the
 * title the engine sends last arrives.
 */
type Replay = { readonly id: string; transcript: Transcript; end: Action | undefined; title: string | undefined; readonly finished: () => void };

/** How long a load waits for the rest of its replay after the engine answered. */
const REPLAY_TAIL_MS = 5000;

/** The session total shown beside the view's title; empty until a turn reports usage. */
function totalsLabel(transcript: Transcript): string {
  const totals = totalsOf(transcript);
  if (totals.turns === 0) return '';
  // An external agent counts no tokens through Geno, and its plan pays when it names no price.
  if (transcript.backend !== undefined && totals.inputTokens + totals.outputTokens === 0) return totals.costUsd === null ? transcript.backend.plan : formatCost(totals.costUsd);
  const tokens = `${formatTokens(totals.inputTokens + totals.outputTokens)} tokens`;
  return totals.costUsd === null ? tokens : `${formatCost(totals.costUsd)} · ${tokens}`;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const warn = (error: unknown): void => void vscode.window.showWarningMessage(messageOf(error));

/** An open question of a session the panel left; the engine asks the next window that shows the session. */
const NOT_SHOWN = Symbol('not shown');
const notShown = (sessionId: string) => new acp.RequestError(NOT_SHOWN_ERROR.code, `the panel no longer shows ${sessionId}`, { reason: NOT_SHOWN_ERROR.reason });

/** The engine session that chat turns, inline edits and review share. */
export type SessionLink = { readonly connection: Connection; readonly sessionId: string };

/** Where the extension hears about edits the engine writes, so it can put them under review. */
export type WriteListener = (document: vscode.TextDocument, change: FileChange) => void;

/**
 * The session id, kept in a file in the extension's workspace storage so review state and the conversation
 * survive a window reload. A file rather than workspaceState: VS Code keeps workspaceState in memory under
 * extension tests, so a test could not reload into it.
 */
export function sessionMemory(storage: vscode.Uri | undefined) {
  if (storage === undefined) return { load: async (): Promise<StoredSession | undefined> => undefined, save: async (_id: string, _cwd?: string) => {} };
  const file = vscode.Uri.joinPath(storage, 'session-id');
  return {
    /** The id, and on a second line the folder the session works in when that is one of the folder's lanes. */
    async load(): Promise<StoredSession | undefined> {
      const [id, cwd] = (await vscode.workspace.fs.readFile(file).then((bytes) => new TextDecoder().decode(bytes), () => '')).trim().split('\n');
      return id === undefined || id === '' ? undefined : { id, cwd: cwd || undefined };
    },
    async save(id: string, cwd?: string): Promise<void> {
      await vscode.workspace.fs.createDirectory(storage);
      await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(cwd === undefined ? id : `${id}\n${cwd}`));
    },
  };
}

export type StoredSession = { readonly id: string; readonly cwd: string | undefined };

/** Whether `folder` is one of `main`'s lanes, whose sessions this window shows as its own. */
export const isLaneOf = (folder: string, main: string): boolean => {
  const relative = path.relative(path.join(main, LANE_ROOT), folder);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) && !relative.includes(path.sep);
};

export type SessionMemory = ReturnType<typeof sessionMemory>;

/**
 * The view's badge counts the tasks that need the user. VS Code draws it on the view's icon in the activity bar, or on
 * its tab, so it shows while the panel is closed and takes no room in a narrow one.
 */
const needsYouBadge = (n: number): vscode.ViewBadge | undefined => (n === 0 ? undefined : { value: n, tooltip: n === 1 ? '1 task needs you' : `${n} tasks need you` });

/** The chat panel and its one conversation with the engine. */
export class Chat implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly engine: Engine;
  private view: vscode.WebviewView | undefined;
  /** The conversation as the panel shows it; a webview created again starts from it. */
  private transcript: Transcript;
  private nextTurn = 0;
  private readonly sessions = new WeakMap<Connection, Promise<string>>();
  private turn: SessionLink | undefined;
  private readonly permissions = new Map<string, (optionId: string | undefined | typeof NOT_SHOWN) => void>();
  /** Open question cards, each settled with the user's answers or refusal, or undefined when cancelled. */
  private readonly questions = new Map<string, (answer: AskUserAnswer | undefined | typeof NOT_SHOWN) => void>();
  private nextPermission = 0;
  private readonly mentions = new Mentions();
  /** The session of the latest turn, whose attachments folder a pasted image opens from. */
  private lastSession: string | undefined;
  /** Files outside the workspace the user attached, which their chips may open. */
  private readonly attachedPaths = new Set<string>();
  /** The session the panel shows, and its title. */
  private shown: string | undefined;
  private title: string | undefined;
  private replay: Replay | undefined;
  /** The shown session's approval modes; before it exists, the mode it will start in. */
  private modes: Modes;
  /** The `/` commands the engine lists; until it does, the built-ins every session has. */
  private commands: readonly CommandOption[] = BUILTIN_OPTIONS;
  private readonly switched = new vscode.EventEmitter<void>();
  /** Fires when the panel moves to another session: at startup, for a new chat, or one loaded from the history. */
  readonly onDidSwitch = this.switched.event;
  /** The shown session's MCP servers, for the MCP panel. */
  private readonly mcp: McpServers;
  /** The MCP action ran before the webview was ready; it opens the panel once it is. */
  private mcpAsked = false;
  /** The rules and memory panes. */
  private readonly panes: ContextPanes;
  private readonly permissionRules: PermissionsHost;
  /** The providers, keys and roles page. */
  private readonly settingsPage: SettingsPage;
  /** The settings action ran before the webview was ready; it opens the page once it is. */
  private settingsAsked = false;
  /** The Lanes or Tasks action ran before the webview was ready; it opens that pane once it is. */
  private paneAsked: 'show-lanes' | 'show-tasks' | undefined;
  /** The composer's effort, context, running cost and model choices. */
  private readonly composer: ComposerHost;
  private readonly widgets: ReturnType<typeof widgetHost>;
  /** The engine's tasks and this folder's lanes, for their panes and their notices. */
  private readonly background: TaskHost;
  /** How many top-level tasks need the user, for the view's badge. */
  private needsYou = 0;
  /** This folder's best-of-n runs, for the Arena pane. */
  private readonly arena: ArenaHost;
  /** Messages for a running turn, a subagent or a task, which land at its next tool round. */
  private readonly steers: SteerHost;
  /** The message menu's rewinds and forks. */
  private readonly rewinds: RewindHost;
  private readonly usage: UsageHost;
  /** The folder the shown session works in, when it is one of the folder's lanes. */
  private shownCwd: string | undefined;
  /** The running turn of the shown session that another window started, or Geno woke it for, which the panel took over. */
  private adopted: string | undefined;
  /** The composer holds a draft. */
  private typing = false;

  constructor(
    settings: () => Promise<EngineSettings>,
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel,
    private readonly memory: SessionMemory,
    private readonly onWrite: WriteListener,
    private readonly modelName: () => string,
    private readonly look: () => Look,
    private readonly openElsewhere: (workspace: string, sessionId: string) => Promise<void>,
    private readonly defaultMode: () => 'ask' | 'auto',
    /** The MCP servers the user owns, from VS Code's user mcp.json; never the workspace's, which skip no approval this way. */
    private readonly forwardedServers: () => Promise<acp.McpServer[]>,
    settingsPage: (post: (message: SettingsToView) => void) => SettingsPage,
    /** When the user last opened each task, kept across reloads. */
    seen: SeenStore,
    /** What the user chose for an external agent, such as its API key, for the engine that starts it. */
    private readonly backendEnv: (backend: ExternalBackendId) => Promise<BackendEnvResponse>,
  ) {
    this.engine = new Engine(settings, () => this.client(), output);
    this.mcp = new McpServers(() => this.link(), (message) => void this.view?.webview.postMessage(message satisfies ToView));
    this.panes = new ContextPanes(() => this.link(), (message) => void this.view?.webview.postMessage(message satisfies ToView));
    // The folder alone: opening Settings must not start a session before the user picks its provider.
    this.permissionRules = new PermissionsHost(async () => {
      const connection = await this.engine.connection();
      return { connection, cwd: this.shownCwd ?? connection.cwd };
    },(message) => void this.view?.webview.postMessage(message satisfies ToView));
    this.widgets = widgetHost(this.extensionUri, (toolId) =>
      this.transcript.turns.flatMap((turn) => turn.blocks).flatMap((block) => (block.kind === 'tool' && block.id === toolId ? [block] : []))[0]?.widget,
    );
    this.settingsPage = settingsPage((message) => void this.view?.webview.postMessage(message satisfies ToView));
    this.composer = new ComposerHost(
      () => this.link(),
      (message) => void this.view?.webview.postMessage(message satisfies ToView),
      () => this.settingsPage.listing(),
      modelName,
      (provider, model) => setRole('chat', provider, model),
      async () => (await (await this.engine.connection()).agent.request<BackendsResponse>(BACKENDS_METHOD, {})).backends,
      (backend) => this.newChatOn(backend),
    );
    this.background = new TaskHost(
      () => this.engine.connection(),
      (message) => void this.view?.webview.postMessage(message satisfies ToView),
      {
        shown: () => this.shown,
        panelVisible: () => this.view?.visible === true,
        openTask: (sessionId, workspace) => this.openChat(sessionId, workspace),
        openArena: (id) => this.arena.show(id),
        applyLane: (name) => this.applyLane(name),
        ended: (task) => this.adoptedEnded(task),
        defaultMode,
      },
      (needsYou) => {
        this.needsYou = needsYou;
        if (this.view !== undefined) this.view.badge = needsYouBadge(needsYou);
      },
      seen,
    );
    void seen.load().then(() => this.background.reshow());
    this.arena = new ArenaHost(() => this.engine.connection(), (message) => void this.view?.webview.postMessage(message satisfies ToView), {
      applyLane: (name) => this.applyLane(name),
      graftLane: (name, hunks) => this.graftLane(name, hunks),
      defaultMode,
    });
    this.steers = new SteerHost({
      running: () => this.turn,
      connection: () => this.engine.connection(),
      send: (text) => this.send(text),
      adopt: (text, response) => this.prompt(text, text, undefined, async () => [], [], undefined, response),
      post: (message) => void this.view?.webview.postMessage(message satisfies ToView),
    });
    this.rewinds = new RewindHost({
      connection: () => this.engine.connection(),
      idle: () => (this.shown === undefined || this.turn !== undefined ? undefined : { sessionId: this.shown, cwd: this.shownCwd }),
      seqOf: (turn) => this.transcript.turns.find((t) => t.id === turn)?.seq,
      turnAt: (seq) => this.transcript.turns.find((t) => t.seq === seq)?.id,
      reload: () => this.reshow(),
      open: (sessionId) => this.moveTo((connection) => this.load(connection, sessionId, this.shownCwd).then(() => sessionId)),
      post: (message) => void this.view?.webview.postMessage(message satisfies ToView),
    });
    this.usage = new UsageHost({
      connection: () => this.engine.connection(),
      shown: () => this.shown,
      post: (message) => void this.view?.webview.postMessage(message satisfies ToView),
    });
    this.transcript = emptyTranscript(modelName());
    this.modes = { current: defaultMode(), available: MODE_FALLBACK };
  }

  /** Loads the shown session again, as the engine now has it. */
  private async reshow(): Promise<void> {
    const shown = this.shown;
    if (shown === undefined) return;
    const cwd = this.shownCwd;
    await this.moveTo((connection) => this.load(connection, shown, cwd).then(() => shown));
  }

  /** The session a previous window left, if any. */
  storedSession(): Promise<StoredSession | undefined> {
    return this.memory.load();
  }

  async link(): Promise<SessionLink> {
    const connection = await this.engine.connection();
    return { connection, sessionId: await this.sessionFor(connection) };
  }

  /** Restarts the engine, for a changed model, endpoint or key. */
  resetEngine(): void {
    this.engine.reset();
    this.dispatch({ type: 'model', model: this.modelName() });
    this.composer.refreshModels();
  }

  /** Tells a shown panel the look the settings now ask for; a panel created later reads it itself. */
  restyle(): void {
    void this.view?.webview.postMessage({ type: 'look', look: this.look() } satisfies ToView);
  }

  /** Mirrors review decisions made anywhere, the editor's CodeLens included, onto the diff cards. */
  reviewed(hunks: readonly { readonly id: HunkId; readonly status: HunkStatus }[]): void {
    this.dispatch({ type: 'review', hunks: Object.fromEntries(hunks.map((h) => [h.id, h.status])) });
  }

  /** Turns the open chat's browser on or off as the setting now says; a new chat reads the setting itself. */
  syncBrowser(): void {
    this.mcp.setEnabled(BROWSER_SERVER, browserSettings().enabled);
  }

  dispose(): void {
    this.mcp.dispose();
    this.settingsPage.dispose();
    this.composer.dispose();
    this.switched.dispose();
    this.engine.dispose();
  }

  /** The handlers the engine calls back into: the buffer and diagnostics bridges, permission prompts, and updates. */
  private client(): acp.ClientApp {
    return acp
      .client({ name: 'g-code' })
      .onRequest(acp.methods.client.fs.readTextFile, ({ params }) => readTextFile(params))
      .onRequest(acp.methods.client.fs.writeTextFile, ({ params }) =>
        writeTextFile(params, (document, change) => {
          if (!this.isOurs(params.sessionId)) return;
          this.onWrite(document, change);
          const toolId = params._meta?.[TOOL_CALL_META];
          if (typeof toolId !== 'string') return;
          const diff = { type: 'diff', toolId, at: Date.now(), diff: diffOf(document.uri, change) } as const;
          this.dispatch(childOf(this.transcript, params.sessionId) === undefined ? diff : { type: 'child', id: params.sessionId, action: diff });
        }),
      )
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => this.askPermission(params))
      .onRequest(acp.methods.client.elicitation.create, ({ params, signal }) => this.askQuestion(params, signal))
      .onRequest(DIAGNOSTICS_METHOD, diagnosticsRequest, ({ params }) => diagnostics(params.paths))
      .onRequest(UNSAVED_BUFFERS_METHOD, unsavedBuffersRequest, () => unsavedBuffers())
      .onRequest(EDITOR_ACTION_METHOD, editorActionRequest, async ({ params }) => {
        await runEditorAction(params.action);
        return {};
      })
      .onRequest(BACKEND_ENV_METHOD, backendEnvRequest, ({ params }) => this.backendEnv(params.backend))
      .onNotification(acp.methods.client.session.update, ({ params }) => this.updated(params.sessionId, params.update))
      .onNotification(TASK_UPDATE_METHOD, taskUpdate, ({ params }) => this.background.updated(params))
      .onNotification(ARENA_UPDATE_METHOD, arenaUpdate, ({ params }) => this.arena.updated(params));
  }

  /** The shown session, the one being loaded, or one of the shown session's subagents. */
  private isOurs(sessionId: string): boolean {
    return sessionId === this.shown || this.replay?.id === sessionId || childOf(this.transcript, sessionId) !== undefined;
  }

  private updated(sessionId: string, update: acp.SessionUpdate): void {
    // A session the panel just left can still send what was on its way; it belongs to that session's log, not here.
    if (!this.isOurs(sessionId) && update.sessionUpdate !== 'available_commands_update') return;
    if (update.sessionUpdate === 'subagent_update') {
      const action = subagentAction(update, Date.now());
      if (action !== undefined && sessionId === this.shown) this.dispatch(action);
      return;
    }
    if (childOf(this.transcript, sessionId) !== undefined) {
      const action = actionOf(update, timeOf(update));
      if (isChildAction(action)) this.dispatch({ type: 'child', id: sessionId, action });
      return;
    }
    if (this.composer.updated(sessionId, update)) return;
    // Every session of this window shares its workspace, so any session's list is the panel's.
    if (update.sessionUpdate === 'available_commands_update') return this.recommand(commandOptions(update.availableCommands));
    if (update.sessionUpdate === 'current_mode_update') {
      if (sessionId === this.shown) this.remode({ ...this.modes, current: update.currentModeId });
      return;
    }
    if (update.sessionUpdate === 'session_info_update') {
      const backend = backendOf(update._meta);
      if (backend !== undefined && this.shown === sessionId) this.dispatch({ type: 'backend', backend });
      if (update.title === undefined) return;
      if (this.replay?.id === sessionId) {
        this.replay.title = update.title ?? undefined;
        this.replay.finished();
      } else if (this.shown === sessionId) this.retitle(update.title ?? undefined);
      return;
    }
    if (update.sessionUpdate === 'user_message_chunk') {
      const steer = steerActionOf(update);
      if (steer !== undefined) return this.dispatch(steer);
      const woke = wakeMark.safeParse(update._meta?.[WAKE_META]);
      if (this.replay === undefined && woke.success && sessionId === this.shown) return this.woken(sessionId, woke.data.label);
      if (this.replay === undefined || update.content.type !== 'text') return;
      if (this.replay.end !== undefined) this.dispatch(this.replay.end);
      const start = replayedTurn.safeParse(update._meta?.[REPLAYED_TURN_META]);
      this.dispatch({
        type: 'turn-start',
        id: `t${this.nextTurn++}`,
        at: start.success ? start.data.startedAt : Date.now(),
        prompt: update.content.text,
        mode: start.success ? start.data.mode : undefined,
        command: start.success ? this.sentCommand(start.data.command) : undefined,
        // A woken turn has no message of the user's to rewind to.
        seq: start.success && !woke.success ? start.data.seq : undefined,
        wake: woke.success ? woke.data.label : undefined,
      });
      this.replay.end = replayedEnd(update);
      return;
    }
    const job = update.sessionUpdate === 'tool_call_update' ? backgroundView.safeParse(update._meta?.[BACKGROUND_META]) : undefined;
    if (job?.success === true) {
      const { id, state, tail } = job.data;
      return this.dispatch({ type: 'background', toolId: job.data.toolUseId, job: { id, state, tail } });
    }
    const at = timeOf(update);
    const action = actionOf(update, at);
    if (action !== undefined) this.dispatch(action);
    const change = replayedChange.safeParse(update._meta?.[REPLAYED_CHANGE_META]);
    if (update.sessionUpdate === 'tool_call_update' && change.success) {
      this.dispatch({ type: 'diff', toolId: update.toolCallId, at, diff: diffOf(vscode.Uri.file(change.data.path), change.data) });
    }
  }

  /** Runs one agent turn and resolves with its stop reason. Its `@file` and `@selection` mentions and its attachments go along as context. */
  async send(text: string, attachments: readonly OutgoingAttachment[] = []): Promise<acp.StopReason> {
    const routed = routeText(this.commands, text);
    if (routed.kind === 'editor') {
      await this.editorActions[routed.action](routed.args);
      return 'end_turn';
    }
    for (const a of attachments) if (a.path !== undefined) this.attachedPaths.add(a.path);
    const blocks = async () => [...(await this.mentions.blocks(text)), ...promptBlocks(attachments)];
    return this.prompt(text, text, undefined, blocks, viewsOf(attachments), routed.command);
  }

  /** What the editor's own `/` built-ins do: the same as the view's New Chat and History actions and the model button. */
  private readonly editorActions: Readonly<Record<EditorAction, (args: string) => Promise<void>>> = {
    'new-chat': () => this.newChat(),
    history: async () => this.showHistory(),
    model: async () => this.showSettings(),
    rules: async () => void this.view?.webview.postMessage({ type: 'show-rules' } satisfies ToView),
    memory: async () => void this.view?.webview.postMessage({ type: 'show-memory' } satisfies ToView),
    'best-of-n': (args) => this.arena.begin(args),
  };

  /** A logged command as its chip shows it; a command no longer listed shows as a prompt template. */
  private sentCommand(command: { readonly name: string; readonly args: string } | undefined): SentCommand | undefined {
    if (command === undefined) return undefined;
    return { ...command, route: this.commands.find((c) => c.name === command.name)?.route ?? 'prompt' };
  }

  private recommand(commands: readonly CommandOption[]): void {
    this.commands = commands;
    void this.view?.webview.postMessage({ type: 'commands', commands } satisfies ToView);
  }

  /** Cmd-K: a one-shot edit of a selection, shown in the panel like a turn. */
  inlineEdit(target: InlineEditTarget, instruction: string, file: vscode.Uri): Promise<acp.StopReason> {
    const lines = target.startLine === target.endLine ? `line ${target.startLine}` : `lines ${target.startLine}-${target.endLine}`;
    const shown = `Edit ${lines} of ${vscode.workspace.asRelativePath(file)}: ${instruction}`;
    return this.prompt(shown, instruction, { [INLINE_EDIT_META]: target }, async () => []);
  }

  private async prompt(
    shown: string,
    text: string,
    meta: Record<string, unknown> | undefined,
    attachments: () => Promise<acp.ContentBlock[]>,
    attached: readonly AttachmentView[] = [],
    command?: SentCommand,
    /** A steer's own answer, for the turn it runs as when the turn it was sent to ended first. */
    sent?: Promise<acp.PromptResponse>,
  ): Promise<acp.StopReason> {
    if (this.turn !== undefined) throw new Error('a turn is already running; stop it first');
    this.dispatch({ type: 'turn-start', id: `t${this.nextTurn++}`, at: Date.now(), prompt: shown, attachments: attached, mode: this.modes.current, command });
    this.composer.turnStarted();
    // The turn this call runs; the panel may leave it for another session, and it then ends in the background.
    let mine: SessionLink | undefined;
    let stopped = false;
    const left = () => mine === undefined || this.turn !== mine;
    try {
      mine = await this.link();
      this.turn = mine;
      this.lastSession = mine.sessionId;
      const response = await (sent ??
        mine.connection.agent.request(acp.methods.agent.session.prompt, {
          sessionId: mine.sessionId,
          prompt: [{ type: 'text', text }, ...(await attachments())],
          ...(meta === undefined ? {} : { _meta: meta }),
        }));
      stopped = response.stopReason === 'cancelled';
      if (left()) return response.stopReason;
      const ending = ENDINGS[response.stopReason];
      if (ending.message !== undefined) this.dispatch({ type: 'error', message: ending.message });
      const seq = response._meta?.[TURN_SEQ_META];
      this.dispatch({ type: 'turn-end', at: Date.now(), status: ending.status, usage: usageOf(response), seq: typeof seq === 'number' ? seq : undefined });
      return response.stopReason;
    } catch (error) {
      if (mine !== undefined && left()) throw error;
      this.dispatch({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      this.dispatch({ type: 'turn-end', at: Date.now(), status: 'failed', usage: undefined });
      throw error;
    } finally {
      if (mine === undefined || this.turn === mine) {
        this.turn = undefined;
        this.mcp.refresh();
        if (mine !== undefined) this.steers.turnEnded(mine, stopped);
      }
    }
  }

  /** Applies a lane into the main checkout as a turn of the shown chat, whose edit steps put each file's hunks under review. */
  async applyLane(name: string): Promise<acp.StopReason> {
    if (this.shownCwd !== undefined) throw new Error('Open a chat of the main checkout to apply a lane into it.');
    const prompt = laneApplyPrompt(name);
    return this.prompt(prompt, prompt, { [LANE_APPLY_META]: name }, async () => []);
  }

  /** Grafts some of a lane's hunks into the main checkout as a turn of the shown chat, under review as an apply's are. */
  async graftLane(name: string, hunks: readonly string[]): Promise<acp.StopReason> {
    if (this.shownCwd !== undefined) throw new Error('Open a chat of the main checkout to graft a lane into it.');
    const prompt = laneGraftPrompt(name, hunks.length);
    return this.prompt(prompt, prompt, { [LANE_GRAFT_META]: { lane: name, hunks } }, async () => []);
  }

  /** The composer's draft, which the engine hears of for the shown session: no woken turn starts while the user types. */
  private drafting(typing: boolean): void {
    if (this.typing === typing) return;
    this.typing = typing;
    this.tellDraft(this.shown, typing);
  }

  private tellDraft(sessionId: string | undefined, typing: boolean): void {
    if (sessionId === undefined) return;
    void this.engine
      .connection()
      .then(({ agent }) => agent.notify(DRAFT_METHOD, { sessionId, typing } satisfies DraftNotice))
      .catch(() => {});
  }

  /**
   * Geno woke the shown session for a turn of its own. The panel shows it as a turn it took over, as after a reload:
   * Stop stops it, and its task's end ends it.
   */
  private woken(sessionId: string, label: string): void {
    if (this.turn !== undefined || this.adopted !== undefined) return;
    this.dispatch({ type: 'turn-start', id: `t${this.nextTurn++}`, at: Date.now(), prompt: '', mode: this.modes.current, wake: label });
    this.adopted = sessionId;
    this.composer.turnStarted();
    void this.engine.connection().then((connection) => {
      if (this.adopted === sessionId && this.turn === undefined) this.turn = { connection, sessionId };
    });
  }

  /** The adopted turn ended: its end shows as a sent one's would, with the usage the task reports. */
  private adoptedEnded(task: TaskRecord): void {
    const status = ADOPTED_ENDS[task.status];
    if (this.adopted !== task.sessionId || status === undefined) return;
    this.adopted = undefined;
    this.turn = undefined;
    this.dispatch({ type: 'turn-end', at: task.endedAt ?? Date.now(), status, usage: task.usage });
    this.mcp.refresh();
  }

  /**
   * The panel moves away from a session whose turn still runs: the turn goes on in the background, and the questions
   * it waits on go back to the engine, which asks again when a window shows the session.
   */
  private leaveRunning(): SessionLink | undefined {
    const running = this.turn;
    this.turn = undefined;
    this.adopted = undefined;
    for (const answer of this.permissions.values()) answer(NOT_SHOWN);
    for (const answer of this.questions.values()) answer(NOT_SHOWN);
    return running;
  }

  async stop(): Promise<void> {
    const turn = this.turn;
    if (turn === undefined) return;
    // ACP: a client that cancels a turn answers its open permission requests as cancelled.
    for (const answer of this.permissions.values()) answer(undefined);
    for (const answer of this.questions.values()) answer(undefined);
    await turn.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: turn.sessionId });
  }

  /** Sends the running turn's waiting model call at once. */
  async retryNow(): Promise<void> {
    const turn = this.turn;
    if (turn === undefined) return;
    await turn.connection.agent.request<RetryNowResponse, RetryNowRequest>(RETRY_NOW_METHOD, { sessionId: turn.sessionId });
  }

  /** Stops a background command of the shown session; its step hears the end from the engine. */
  async stopBackground(id: string): Promise<void> {
    if (this.shown === undefined) return;
    const { agent } = await this.engine.connection();
    await agent.request<unknown, BackgroundStopRequest>(BACKGROUND_STOP_METHOD, { sessionId: this.shown, id });
  }

  /** Stops one subagent of the running turn by its session id; the engine ends it, and the parent goes on. */
  async cancelChild(id: string): Promise<void> {
    const turn = this.turn;
    if (turn === undefined || childOf(this.transcript, id)?.status.kind !== 'running') return;
    await turn.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: id });
  }

  private sessionFor(connection: Connection): Promise<string> {
    let session = this.sessions.get(connection);
    if (session === undefined) {
      void this.background.connected(connection).catch((error: unknown) => this.output.appendLine(`tasks: ${messageOf(error)}`));
      void this.arena.connected(connection).catch((error: unknown) => this.output.appendLine(`arenas: ${messageOf(error)}`));
      session = this.openSession(connection);
      this.sessions.set(connection, session);
      session.catch(() => this.sessions.delete(connection));
    }
    return session;
  }

  /**
   * The session for a new engine connection. The one the panel shows is resumed; at startup the stored one is
   * loaded, its transcript drawn. A new session starts when there is none or the engine no longer has it.
   */
  private async openSession(connection: Connection): Promise<string> {
    const cwd = this.shownCwd ?? connection.cwd;
    if (this.shown !== undefined) {
      try {
        const { modes, configOptions, _meta } = await connection.agent.request(acp.methods.agent.session.resume, { sessionId: this.shown, cwd, mcpServers: await this.forwardedServers(), _meta: browserMeta() });
        this.dispatch({ type: 'backend', backend: backendOf(_meta) });
        this.remode(modesOf(modes) ?? this.modes);
        this.composer.switched(this.shown, configOptions);
        return this.shown;
      } catch {
        // The log went away while the engine restarted; start over.
      }
    }
    const stored = this.shown === undefined ? await this.storedSession() : undefined;
    if (stored !== undefined) {
      try {
        await this.load(connection, stored.id, stored.cwd);
        return stored.id;
      } catch {
        // A log deleted or from another machine; start over.
      }
    }
    // The window's first session: a turn being sent may already show, so the transcript stays, and so does a mode
    // picked before the session existed.
    return this.fresh(connection, this.transcript, this.modes.current);
  }

  /** Starts a session in `mode`, by default the one the settings give new sessions, on Geno's own loop unless `backend` names an agent. */
  private async fresh(connection: Connection, transcript = emptyTranscript(this.modelName()), mode: string = this.defaultMode(), backend: BackendId = 'geno'): Promise<string> {
    const on = backend === 'geno' ? {} : { [BACKEND_META]: { id: backend } };
    const { sessionId, modes, configOptions, _meta } = await connection.agent.request(acp.methods.agent.session.new, { cwd: connection.cwd, mcpServers: await this.forwardedServers(), _meta: { ...browserMeta(), ...on } });
    let state = modesOf(modes) ?? { current: mode, available: MODE_FALLBACK };
    if (state.current !== mode && state.available.some((m) => m.id === mode)) {
      await connection.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId: mode });
      state = { ...state, current: mode };
    }
    await this.show(sessionId, { ...transcript, backend: backendOf(_meta) }, undefined, state, configOptions);
    return sessionId;
  }

  /**
   * Loads a session the engine logged, replaying its turns into a transcript the panel then shows. `cwd` is the lane
   * the session works in, if it is a lane's. A turn still running, such as one sent before the window reloaded, stays
   * open: its updates follow the replay, and its task's end ends it.
   */
  private async load(connection: Connection, sessionId: string, cwd?: string): Promise<void> {
    let finished = () => {};
    const tail = new Promise<void>((resolve) => (finished = resolve));
    const replay: Replay = { id: sessionId, transcript: emptyTranscript(this.modelName()), end: undefined, title: undefined, finished };
    this.replay = replay;
    let modes: Modes | undefined;
    let options: acp.LoadSessionResponse['configOptions'];
    let running = false;
    let backend: BackendShown | undefined;
    try {
      const loaded = await connection.agent.request(acp.methods.agent.session.load, { sessionId, cwd: cwd ?? connection.cwd, mcpServers: await this.forwardedServers(), _meta: browserMeta() });
      modes = modesOf(loaded.modes);
      backend = backendOf(loaded._meta);
      options = loaded.configOptions;
      running = loaded._meta?.[RUNNING_META] === true;
      await Promise.race([tail, new Promise((resolve) => setTimeout(resolve, REPLAY_TAIL_MS))]);
    } finally {
      this.replay = undefined;
    }
    const replayed = replay.end === undefined || running ? replay.transcript : reduce(replay.transcript, replay.end);
    const transcript = { ...replayed, backend };
    // The engine may have ended the turn between its answer and now; its task says so.
    const task = this.background.get(sessionId);
    const adopt = running && (task === undefined || isLive(task.status));
    await this.show(sessionId, transcript, replay.title, modes ?? { current: 'ask', available: MODE_FALLBACK }, options, cwd);
    if (running && !adopt && task !== undefined) {
      this.adopted = sessionId;
      this.adoptedEnded(task);
    } else if (adopt) {
      this.adopted = sessionId;
      this.turn = { connection, sessionId };
      this.composer.turnStarted();
    }
  }

  /** Makes the session the panel's: remembered for the next window, its transcript and title shown. */
  private async show(sessionId: string, transcript: Transcript, title: string | undefined, modes: Modes, options: acp.NewSessionResponse['configOptions'], cwd?: string): Promise<void> {
    // The draft stays in the composer, so it now holds back this session's wake instead of the last one's.
    if (this.typing && this.shown !== sessionId) {
      this.tellDraft(this.shown, false);
      this.tellDraft(sessionId, true);
    }
    this.shown = sessionId;
    this.shownCwd = cwd;
    this.background.reshow();
    this.composer.switched(sessionId, options);
    this.dispatch({ type: 'reset', transcript });
    this.retitle(title);
    this.remode(modes);
    await this.memory.save(sessionId, cwd);
    this.switched.fire();
    this.mcp.refresh();
  }

  private retitle(title: string | undefined): void {
    this.title = title;
    void headerOf(title).then((header) => this.view?.webview.postMessage({ type: 'header', header } satisfies ToView));
  }

  private remode(modes: Modes): void {
    this.modes = modes;
    void this.view?.webview.postMessage({ type: 'modes', modes } satisfies ToView);
  }

  /**
   * Switches the shown session's approval mode; the engine confirms with `current_mode_update`. Before the window
   * has a session, the choice waits for the one it starts.
   */
  async setMode(modeId: string): Promise<void> {
    if (this.shown === undefined) return this.remode({ ...this.modes, current: modeId });
    const { connection, sessionId } = await this.link();
    await connection.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId });
    // The engine switched when it answered; its notice can come later than a prompt sent right after.
    if (sessionId === this.shown) this.remode({ ...this.modes, current: modeId });
  }

  /** Leaves Plan for the mode the settings give new chats, Ask unless they say Auto, and has the agent carry out the plan. */
  async startBuilding(): Promise<acp.StopReason> {
    this.idle();
    await this.setMode(this.defaultMode());
    return this.send(START_BUILDING_PROMPT);
  }

  private idle(): void {
    if (this.turn !== undefined) throw new Error('Stop the running turn first.');
  }

  /** Runs `open` for the engine's connection as the session it uses from now on, and closes the one it leaves, which stops its MCP servers. */
  private async moveTo(open: (connection: Connection) => Promise<string>): Promise<void> {
    const connection = await this.engine.connection();
    const left = this.shown;
    // A turn still running goes on in the background; the engine stops sending it here before the next session loads.
    const running = this.turn !== undefined && this.turn.sessionId === left ? this.leaveRunning() : undefined;
    if (running !== undefined) await connection.agent.request<unknown, DetachRequest>(DETACH_METHOD, { sessionId: running.sessionId }).catch(() => {});
    const session = open(connection);
    this.sessions.set(connection, session);
    const now = await session;
    if (left !== undefined && left !== now && running === undefined) void connection.agent.request(acp.methods.agent.session.close, { sessionId: left }).catch(() => {});
  }

  /** Opens the MCP servers panel. */
  showMcp(): void {
    if (this.view === undefined) this.mcpAsked = true;
    else void this.view.webview.postMessage({ type: 'show-mcp' } satisfies ToView);
  }

  /** Opens the Lanes or the Tasks pane. */
  showPane(pane: 'show-lanes' | 'show-tasks'): void {
    if (this.view === undefined) this.paneAsked = pane;
    else void this.view.webview.postMessage({ type: pane } satisfies ToView);
  }

  /** Opens the providers, keys and roles page. */
  showSettings(): void {
    if (this.view === undefined) this.settingsAsked = true;
    else void this.view.webview.postMessage({ type: 'show-settings' } satisfies ToView);
  }

  /** Starts a fresh session; the current one stays on disk. A chat with no turns yet is already fresh. */
  async newChat(): Promise<void> {
    void this.view?.webview.postMessage({ type: 'hide-history' } satisfies ToView);
    if (this.shown !== undefined && this.transcript.turns.length === 0) return;
    await this.moveTo((connection) => this.fresh(connection));
  }

  /** Starts a chat on `backend`, which the session keeps for its life, even when the shown chat has no turns yet. */
  async newChatOn(backend: BackendId): Promise<void> {
    void this.view?.webview.postMessage({ type: 'hide-history' } satisfies ToView);
    if (this.shown !== undefined && this.transcript.turns.length === 0 && (this.transcript.backend?.id ?? 'geno') === backend) return;
    await this.moveTo((connection) => this.fresh(connection, undefined, undefined, backend));
  }

  /** Opens the History list in the panel. */
  showHistory(): void {
    void this.view?.webview.postMessage({ type: 'show-history' } satisfies ToView);
  }

  async listSessions(scope: HistoryScope): Promise<HistoryRow[]> {
    const { agent, cwd } = await this.engine.connection();
    const here = await realpath(cwd).catch(() => cwd);
    const { sessions } = await agent.request(acp.methods.agent.session.list, scope === 'project' ? { cwd } : {});
    return sessions.map((info) => {
      const summary = sessionSummary.safeParse(info._meta?.[SESSION_SUMMARY_META]);
      return {
        id: info.sessionId,
        title: info.title ?? 'New chat',
        workspace: info.cwd,
        project: path.basename(info.cwd),
        here: info.cwd === here,
        updatedAt: info.updatedAt == null ? 0 : Date.parse(info.updatedAt),
        turns: summary.success ? summary.data.turns : 0,
        costUsd: summary.success ? summary.data.costUsd : null,
        current: info.sessionId === this.shown,
        ...(summary.success && summary.data.forkedFrom !== undefined ? { forkedFrom: { id: summary.data.forkedFrom.sessionId, title: summary.data.forkedFrom.title } } : {}),
      };
    });
  }

  /** Searches the text of the scope's sessions, as the History's search field asks. */
  async searchSessions(scope: HistoryScope, query: string): Promise<HistoryHit[]> {
    const { agent, cwd } = await this.engine.connection();
    const raw = await agent.request<unknown, SearchSessionsRequest>(SEARCH_SESSIONS_METHOD, scope === 'project' ? { query, cwd } : { query });
    return searchHits.parse(raw).hits.map((hit) => ({
      id: hit.sessionId,
      turn: hit.turn === null ? null : { number: hit.turn.turn, seq: hit.turn.seq, at: Date.parse(hit.turn.at) },
      snippet: hit.snippet,
      matchingTurns: hit.matchingTurns,
    }));
  }

  /**
   * Loads a session of this project into the panel, where the chat continues from it, scrolled to the turn at
   * `turnSeq` when given. Another project's session opens in that project's window, since its tools run in its own
   * workspace, and there it opens at its end.
   */
  async openChat(sessionId: string, workspace: string, turnSeq?: number): Promise<void> {
    const { cwd } = await this.engine.connection();
    const main = await realpath(cwd).catch(() => cwd);
    const lane = isLaneOf(workspace, main);
    if (workspace !== main && !lane) return this.openElsewhere(workspace, sessionId);
    void this.view?.webview.postMessage({ type: 'hide-history' } satisfies ToView);
    void vscode.commands.executeCommand(`${CHAT_VIEW}.focus`);
    if (sessionId !== this.shown) await this.moveTo((connection) => this.load(connection, sessionId, lane ? workspace : undefined).then(() => sessionId));
    const turn = turnSeq === undefined || sessionId !== this.shown ? undefined : this.transcript.turns.find((t) => t.seq === turnSeq)?.id;
    if (turn !== undefined) void this.view?.webview.postMessage({ type: 'reveal-turn', turn } satisfies ToView);
  }

  async renameChat(sessionId: string, title: string): Promise<void> {
    const { agent } = await this.engine.connection();
    await agent.request<unknown, RenameSessionRequest>(RENAME_SESSION_METHOD, { sessionId, title });
  }

  /** Moves a session's log to the trash. Deleting the panel's own session starts a fresh one. */
  async deleteChat(sessionId: string): Promise<void> {
    if (sessionId === this.shown) this.idle();
    const { agent } = await this.engine.connection();
    await agent.request(acp.methods.agent.session.delete, { sessionId });
    if (sessionId === this.shown) await this.moveTo((connection) => this.fresh(connection));
  }

  private async askPermission({ sessionId, toolCall, options }: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    if (!this.isOurs(sessionId)) throw notShown(sessionId);
    const id = String(this.nextPermission++);
    const optionId = await new Promise<string | undefined | typeof NOT_SHOWN>((resolve) => {
      this.permissions.set(id, resolve);
      const input = permissionInput.safeParse(toolCall.rawInput);
      const { command, reason, description, rule } = input.success ? input.data : { command: toolCall.title ?? 'a command', reason: '', description: undefined, rule: undefined };
      const memory = rememberInput.safeParse(toolCall._meta?.[REMEMBER_META]);
      this.dispatch({
        type: 'permission',
        id,
        command: memory.success ? memory.data.text : command,
        reason,
        ...(description === undefined ? {} : { description }),
        options: options.map(({ optionId, name, kind }) => ({ optionId, name, kind })),
        classifier: classifierReasonOf(toolCall.title),
        ...(memory.success ? { ask: { kind: 'memory', ...memory.data } } : {}),
        toolId: toolCall.toolCallId,
        ...(toolCall.kind === 'edit' ? { toolKind: 'edit' as const } : {}),
        ...(rule === undefined ? {} : { rule }),
      });
      void vscode.commands.executeCommand(`${CHAT_VIEW}.focus`);
    });
    this.permissions.delete(id);
    if (optionId === NOT_SHOWN) throw notShown(sessionId);
    this.dispatch({ type: 'permission-done', id, optionId });
    return { outcome: optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId } };
  }

  /**
   * An ask_user card: the request rides in the elicitation's `_meta`, and goes through the same parser as the model's
   * input, so the card shows exactly what the engine asked. The engine cancels it when the turn stops, which takes
   * the card down.
   */
  private async askQuestion(params: acp.CreateElicitationRequest, signal: AbortSignal): Promise<acp.CreateElicitationResponse> {
    const parsed = parseAskUser(params._meta?.[ASK_USER_META], 'wire');
    if (params.mode !== 'form' || !parsed.ok) return { action: 'decline' };
    const scoped = (params as { readonly sessionId?: unknown }).sessionId;
    const sessionId = typeof scoped === 'string' ? scoped : undefined;
    if (sessionId !== undefined && !this.isOurs(sessionId)) throw notShown(sessionId);
    const request = parsed.value;
    const id = String(this.nextPermission++);
    const answer = await new Promise<AskUserAnswer | undefined | typeof NOT_SHOWN>((resolve) => {
      this.questions.set(id, resolve);
      signal.addEventListener('abort', () => resolve(undefined), { once: true });
      this.dispatch({ type: 'permission', id, command: askUserTitle(request), reason: '', options: [], ask: { kind: 'question', request } });
      void vscode.commands.executeCommand(`${CHAT_VIEW}.focus`);
    });
    this.questions.delete(id);
    if (answer === NOT_SHOWN) throw notShown(sessionId ?? 'the session');
    this.dispatch({ type: 'permission-done', id, optionId: undefined, ...(answer === undefined ? {} : { answer }) });
    if (answer === undefined) return { action: 'cancel' };
    if (answer.kind === 'declined') return { action: 'decline' };
    return { action: 'accept', content: askUserContent(request, answer.answers) };
  }

  /** Applies a change to the transcript and sends it to the webview, which applies the same change. */
  private dispatch(action: Action): void {
    if (this.replay !== undefined) {
      this.replay.transcript = reduce(this.replay.transcript, action);
      return;
    }
    const next = reduce(this.transcript, action);
    if (next === this.transcript) return;
    this.transcript = next;
    void this.view?.webview.postMessage(action);
    if (this.view !== undefined) this.view.description = totalsLabel(next);
  }

  private handlers(view: vscode.WebviewView): { readonly [K in FromView['type']]: (message: Extract<FromView, { type: K }>) => void } {
    return {
      // Live messages start only once the replay is sent, so the webview sees each message once and in order.
      ready: () => {
        void view.webview.postMessage({ type: 'roots', roots: webviewRoots(view.webview) } satisfies ToView);
        void view.webview.postMessage({ type: 'reset', transcript: this.transcript } satisfies Action);
        void headerOf(this.title).then((header) => view.webview.postMessage({ type: 'header', header } satisfies ToView));
        void view.webview.postMessage({ type: 'window-focus', focused: vscode.window.state.focused } satisfies ToView);
        void view.webview.postMessage({ type: 'modes', modes: this.modes } satisfies ToView);
        void view.webview.postMessage({ type: 'commands', commands: this.commands } satisfies ToView);
        void view.webview.postMessage({ type: 'mcp', listing: this.mcp.current() } satisfies ToView);
        void view.webview.postMessage({ type: 'composer', facts: this.composer.current() } satisfies ToView);
        const background = this.background.current();
        void view.webview.postMessage({ type: 'tasks', tasks: background.tasks, shown: this.shown, seen: background.seen } satisfies ToView);
        void view.webview.postMessage({ type: 'lanes', listing: background.lanes } satisfies ToView);
        void view.webview.postMessage({ type: 'arena', state: this.arena.current() } satisfies ToView);
        this.composer.refreshModels();
        if (this.mcpAsked) void view.webview.postMessage({ type: 'show-mcp' } satisfies ToView);
        this.mcpAsked = false;
        if (this.settingsAsked) void view.webview.postMessage({ type: 'show-settings' } satisfies ToView);
        this.settingsAsked = false;
        if (this.paneAsked !== undefined) void view.webview.postMessage({ type: this.paneAsked } satisfies ToView);
        this.paneAsked = undefined;
        view.description = totalsLabel(this.transcript);
        // The count can come before the view does, as after a reload.
        view.badge = needsYouBadge(this.needsYou);
        this.view = view;
      },
      send: ({ text, attachments }) => void this.send(text, attachments).catch(() => {}),
      'attach-uris': ({ uris }) => void this.attach(view, droppedUris(uris)),
      'pick-files': () => void pickFiles().then((uris) => this.attach(view, uris)),
      open: ({ target }) => void openTarget(target, this.lastSession, this.attachedPaths),
      complete: ({ id, query }) =>
        void this.mentions.completions(query).then(
          (items) => view.webview.postMessage({ type: 'completions', id, items } satisfies ToView),
          () => view.webview.postMessage({ type: 'completions', id, items: [] } satisfies ToView),
        ),
      'want-commands': () => void this.link().catch(() => {}),
      stop: () => void this.stop(),
      'retry-now': () => void this.retryNow().catch(warn),
      'cancel-child': ({ id }) => void this.cancelChild(id).catch(warn),
      'stop-background': ({ id }) => void this.stopBackground(id).catch(warn),
      drafting: ({ typing }) => this.drafting(typing),
      permission: ({ id, optionId }) => this.permissions.get(id)?.(optionId),
      answer: ({ id, answer }) => this.questions.get(id)?.(answer),
      keep: ({ hunks }) => void vscode.commands.executeCommand(KEEP_COMMAND, hunks),
      undo: ({ hunks }) => void vscode.commands.executeCommand(UNDO_COMMAND, hunks),
      reveal: ({ hunk }) => void vscode.commands.executeCommand(REVEAL_COMMAND, hunk),
      'undo-turn': ({ checkpoint, later }) => void vscode.commands.executeCommand(UNDO_TURN_COMMAND, checkpoint, later).then(undefined, warn),
      'editor-action': ({ action }) => void runEditorAction(action).then(undefined, warn),
      'open-change': ({ path, checkpoint }) => void vscode.commands.executeCommand(OPEN_CHANGE_COMMAND, path, checkpoint),
      copy: ({ text }) => void vscode.env.clipboard.writeText(text),
      'choose-model': () => this.showSettings(),
      'open-diagram': ({ source }) => openDiagram(this.extensionUri, source),
      'set-mode': ({ modeId }) => void this.setMode(modeId).catch(warn),
      'start-building': () => void this.startBuilding().catch(warn),
      'list-sessions': ({ scope }) => this.postHistory(view, scope),
      'search-sessions': ({ scope, query }) =>
        void this.searchSessions(scope, query).then(
          (hits) => view.webview.postMessage({ type: 'history-hits', scope, query, hits } satisfies ToView),
          (error: unknown) => view.webview.postMessage({ type: 'history-hits-failed', scope, query, message: messageOf(error) } satisfies ToView),
        ),
      'open-session': ({ id, workspace, turnSeq }) => void this.openChat(id, workspace, turnSeq).catch(warn),
      'rename-session': ({ id, title, scope }) => void this.renameChat(id, title).then(() => this.postHistory(view, scope), warn),
      'delete-session': ({ id, scope }) => void this.deleteChat(id).then(() => this.postHistory(view, scope), warn),
      ...this.mcp.handlers,
      ...this.panes.handlers,
      ...this.settingsPage.handlers,
      ...this.permissionRules.handlers,
      ...this.composer.handlers,
      ...this.widgets.handlers,
      ...this.background.handlers,
      ...this.arena.handlers,
      ...this.steers.handlers,
      ...this.rewinds.handlers,
      ...this.usage.handlers,
    };
  }

  private async attach(view: vscode.WebviewView, uris: readonly vscode.Uri[]): Promise<void> {
    if (uris.length === 0) return;
    const { files, refused } = await readForComposer(uris);
    await view.webview.postMessage({ type: 'picked', files, refused } satisfies ToView);
  }

  private postHistory(view: vscode.WebviewView, scope: HistoryScope): void {
    void this.listSessions(scope).then(
      (rows) => view.webview.postMessage({ type: 'history', scope, rows } satisfies ToView),
      (error: unknown) => view.webview.postMessage({ type: 'history-failed', scope, message: messageOf(error) } satisfies ToView),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist, ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri), vscode.Uri.file(sessionsDir())] };
    view.webview.html = pageHtml(view.webview, dist, 'webview.js', this.look());
    const handlers = this.handlers(view);
    view.webview.onDidReceiveMessage((message: FromView) => (handlers[message.type] as (m: FromView) => void)(message));
    const focus = vscode.window.onDidChangeWindowState(({ focused }) => {
      void view.webview.postMessage({ type: 'window-focus', focused } satisfies ToView);
      this.background.reshow();
    });
    const visible = view.onDidChangeVisibility(() => this.background.reshow());
    view.onDidDispose(() => {
      focus.dispose();
      visible.dispose();
      if (this.view === view) this.view = undefined;
    });
  }
}
