import { realpath } from 'node:fs/promises';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { z } from 'zod';
import {
  afterLines,
  DIAGNOSTICS_METHOD,
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
  REPLAYED_AT_META,
  REPLAYED_CHANGE_META,
  REPLAYED_TURN_META,
  SESSION_SUMMARY_META,
  TOOL_CALL_META,
  TURN_USAGE_META,
  UNSAVED_BUFFERS_METHOD,
  type AskUserAnswer,
  type FileChange,
  type HunkId,
  type HunkStatus,
  type InlineEditTarget,
  type RenameSessionRequest,
} from '@g-code/core';
import { KEEP_COMMAND, UNDO_COMMAND } from '../review/controller.js';
import { REVEAL_COMMAND } from '../review/tree.js';
import { currentBranch } from '../git-branch.js';
import type { AttachmentView, OutgoingAttachment } from './attachment-model.js';
import { droppedUris, imagesOf, openTarget, pickFiles, promptBlocks, readForComposer, sessionsDir, viewsOf, webviewRoots } from './attachments.js';
import { diagnostics, readTextFile, unsavedBuffers, writeTextFile } from './bridge.js';
import { openDiagram } from './diagram-tab.js';
import { Engine, type Connection, type EngineSettings } from './engine.js';
import { formatCost, formatTokens } from './format.js';
import { ContextPanes } from './context-host.js';
import { browserMeta, browserSettings } from './browser.js';
import { McpServers } from './mcp-host.js';
import { setRole, type SettingsPage } from './settings-host.js';
import { ComposerHost } from './composer-host.js';
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
import { emptyTranscript, reduce, totalsOf } from './transcript.js';

export const CHAT_VIEW = 'gcode.chat';
export const SEND_COMMAND = 'gcode.chat.send';
export const STOP_COMMAND = 'gcode.chat.stop';
export const NEW_CHAT_COMMAND = 'gcode.chat.new';
export const HISTORY_COMMAND = 'gcode.chat.history';
export const MCP_COMMAND = 'gcode.chat.mcp';
/** The settings the panel's look comes from. */
export const LOOK_SETTINGS = ['gcode.ui.style', 'gcode.chat.detail'] as const;
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

/** The panel's look from settings; an unknown value falls back to the default, glass and compact. */
export const lookOf = (configuration: vscode.WorkspaceConfiguration): Look => ({
  style: known<UiStyle>(UI_STYLES, configuration.get<string>('ui.style'), 'glass'),
  detail: known<ChatDetail>(CHAT_DETAILS, configuration.get<string>('chat.detail'), 'compact'),
});

const diagnosticsRequest = z.object({ sessionId: z.string(), paths: z.array(z.string()) });
const unsavedBuffersRequest = z.object({ sessionId: z.string() });
const turnUsage = z.object({ model: z.string(), costUsd: z.number().nullable() });
const permissionInput = z.object({ command: z.string(), reason: z.string() });
const rememberInput = z.object({ text: z.string(), scope: z.enum(MEMORY_SCOPES) });
const replayedTurn = z.object({
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
const sessionSummary = z.object({ turns: z.number(), costUsd: z.number().nullable() });
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
  agent_message_chunk: ({ content }) => (content.type === 'text' ? { type: 'text', text: content.text } : undefined),
  notice: ({ title }) => ({ type: 'notice', text: title }),
  tool_call: ({ toolCallId, title, kind, status }, at) => ({
    type: 'tool',
    id: toolCallId,
    at,
    ...callOf(title),
    toolKind: kindOf(kind),
    status: TOOL_STATUSES[status ?? 'pending'],
  }),
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

const actionOf = <K extends acp.SessionUpdate['sessionUpdate']>(update: UpdateOf<K>, at: number): Action | undefined =>
  (UPDATES[update.sessionUpdate] as ((u: UpdateOf<K>, at: number) => Action | undefined) | undefined)?.(update, at);

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
  const tokens = `${formatTokens(totals.inputTokens + totals.outputTokens)} tokens`;
  return totals.costUsd === null ? tokens : `${formatCost(totals.costUsd)} · ${tokens}`;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const warn = (error: unknown): void => void vscode.window.showWarningMessage(messageOf(error));

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
  if (storage === undefined) return { load: async (): Promise<string | undefined> => undefined, save: async (_id: string) => {} };
  const file = vscode.Uri.joinPath(storage, 'session-id');
  return {
    load: async (): Promise<string | undefined> =>
      (await vscode.workspace.fs.readFile(file).then((bytes) => new TextDecoder().decode(bytes).trim(), () => '')) || undefined,
    async save(id: string): Promise<void> {
      await vscode.workspace.fs.createDirectory(storage);
      await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(id));
    },
  };
}

export type SessionMemory = ReturnType<typeof sessionMemory>;

/** The chat panel and its one conversation with the engine. */
export class Chat implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly engine: Engine;
  private view: vscode.WebviewView | undefined;
  /** The conversation as the panel shows it; a webview created again starts from it. */
  private transcript: Transcript;
  private nextTurn = 0;
  private readonly sessions = new WeakMap<Connection, Promise<string>>();
  private turn: SessionLink | undefined;
  private readonly permissions = new Map<string, (optionId: string | undefined) => void>();
  /** Open question cards, each settled with the user's answers or refusal, or undefined when cancelled. */
  private readonly questions = new Map<string, (answer: AskUserAnswer | undefined) => void>();
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
  /** The providers, keys and roles page. */
  private readonly settingsPage: SettingsPage;
  /** The settings action ran before the webview was ready; it opens the page once it is. */
  private settingsAsked = false;
  /** The composer's effort, context, running cost and model choices. */
  private readonly composer: ComposerHost;

  constructor(
    settings: () => Promise<EngineSettings>,
    private readonly extensionUri: vscode.Uri,
    output: vscode.OutputChannel,
    private readonly memory: SessionMemory,
    private readonly onWrite: WriteListener,
    private readonly modelName: () => string,
    private readonly look: () => Look,
    private readonly openElsewhere: (workspace: string, sessionId: string) => Promise<void>,
    private readonly defaultMode: () => 'ask' | 'auto',
    /** The MCP servers the user owns, from VS Code's user mcp.json; never the workspace's, which skip no approval this way. */
    private readonly forwardedServers: () => Promise<acp.McpServer[]>,
    settingsPage: (post: (message: SettingsToView) => void) => SettingsPage,
  ) {
    this.engine = new Engine(settings, () => this.client(), output);
    this.mcp = new McpServers(() => this.link(), (message) => void this.view?.webview.postMessage(message satisfies ToView));
    this.panes = new ContextPanes(() => this.link(), (message) => void this.view?.webview.postMessage(message satisfies ToView));
    this.settingsPage = settingsPage((message) => void this.view?.webview.postMessage(message satisfies ToView));
    this.composer = new ComposerHost(
      () => this.link(),
      (message) => void this.view?.webview.postMessage(message satisfies ToView),
      () => this.settingsPage.listing(),
      modelName,
      (provider, model) => setRole('chat', provider, model),
    );
    this.transcript = emptyTranscript(modelName());
    this.modes = { current: defaultMode(), available: MODE_FALLBACK };
  }

  /** The session id a previous window left, if any. */
  storedSession(): Promise<string | undefined> {
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
          this.onWrite(document, change);
          const toolId = params._meta?.[TOOL_CALL_META];
          if (typeof toolId === 'string') this.dispatch({ type: 'diff', toolId, at: Date.now(), diff: diffOf(document.uri, change) });
        }),
      )
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => this.askPermission(params))
      .onRequest(acp.methods.client.elicitation.create, ({ params, signal }) => this.askQuestion(params, signal))
      .onRequest(DIAGNOSTICS_METHOD, diagnosticsRequest, ({ params }) => diagnostics(params.paths))
      .onRequest(UNSAVED_BUFFERS_METHOD, unsavedBuffersRequest, () => unsavedBuffers())
      .onNotification(acp.methods.client.session.update, ({ params }) => this.updated(params.sessionId, params.update));
  }

  private updated(sessionId: string, update: acp.SessionUpdate): void {
    if (this.composer.updated(sessionId, update)) return;
    // Every session of this window shares its workspace, so any session's list is the panel's.
    if (update.sessionUpdate === 'available_commands_update') return this.recommand(commandOptions(update.availableCommands));
    if (update.sessionUpdate === 'current_mode_update') {
      if (sessionId === this.shown) this.remode({ ...this.modes, current: update.currentModeId });
      return;
    }
    if (update.sessionUpdate === 'session_info_update') {
      if (update.title === undefined) return;
      if (this.replay?.id === sessionId) {
        this.replay.title = update.title ?? undefined;
        this.replay.finished();
      } else if (this.shown === sessionId) this.retitle(update.title ?? undefined);
      return;
    }
    if (update.sessionUpdate === 'user_message_chunk') {
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
      });
      this.replay.end = replayedEnd(update);
      return;
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
      await this.editorActions[routed.action]();
      return 'end_turn';
    }
    for (const a of attachments) if (a.path !== undefined) this.attachedPaths.add(a.path);
    const blocks = async () => [...(await this.mentions.blocks(text)), ...promptBlocks(attachments)];
    return this.prompt(text, text, undefined, blocks, viewsOf(attachments), routed.command);
  }

  /** What the editor's own `/` built-ins do: the same as the view's New Chat and History actions and the model button. */
  private readonly editorActions: Readonly<Record<EditorAction, () => Promise<void>>> = {
    'new-chat': () => this.newChat(),
    history: async () => this.showHistory(),
    model: async () => this.showSettings(),
    rules: async () => void this.view?.webview.postMessage({ type: 'show-rules' } satisfies ToView),
    memory: async () => void this.view?.webview.postMessage({ type: 'show-memory' } satisfies ToView),
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
  ): Promise<acp.StopReason> {
    if (this.turn !== undefined) throw new Error('a turn is already running; stop it first');
    this.dispatch({ type: 'turn-start', id: `t${this.nextTurn++}`, at: Date.now(), prompt: shown, attachments: attached, mode: this.modes.current, command });
    this.composer.turnStarted();
    try {
      this.turn = await this.link();
      this.lastSession = this.turn.sessionId;
      const response = await this.turn.connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: this.turn.sessionId,
        prompt: [{ type: 'text', text }, ...(await attachments())],
        ...(meta === undefined ? {} : { _meta: meta }),
      });
      const ending = ENDINGS[response.stopReason];
      if (ending.message !== undefined) this.dispatch({ type: 'error', message: ending.message });
      this.dispatch({ type: 'turn-end', at: Date.now(), status: ending.status, usage: usageOf(response) });
      return response.stopReason;
    } catch (error) {
      this.dispatch({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      this.dispatch({ type: 'turn-end', at: Date.now(), status: 'failed', usage: undefined });
      throw error;
    } finally {
      this.turn = undefined;
      this.mcp.refresh();
    }
  }

  async stop(): Promise<void> {
    const turn = this.turn;
    if (turn === undefined) return;
    // ACP: a client that cancels a turn answers its open permission requests as cancelled.
    for (const answer of this.permissions.values()) answer(undefined);
    for (const answer of this.questions.values()) answer(undefined);
    await turn.connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: turn.sessionId });
  }

  private sessionFor(connection: Connection): Promise<string> {
    let session = this.sessions.get(connection);
    if (session === undefined) {
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
    const { cwd } = connection;
    if (this.shown !== undefined) {
      try {
        const { modes, configOptions } = await connection.agent.request(acp.methods.agent.session.resume, { sessionId: this.shown, cwd, mcpServers: await this.forwardedServers(), _meta: browserMeta() });
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
        await this.load(connection, stored);
        return stored;
      } catch {
        // A log deleted or from another machine; start over.
      }
    }
    // The window's first session: a turn being sent may already show, so the transcript stays, and so does a mode
    // picked before the session existed.
    return this.fresh(connection, this.transcript, this.modes.current);
  }

  /** Starts a session in `mode`, by default the one the settings give new sessions. */
  private async fresh(connection: Connection, transcript = emptyTranscript(this.modelName()), mode: string = this.defaultMode()): Promise<string> {
    const { sessionId, modes, configOptions } = await connection.agent.request(acp.methods.agent.session.new, { cwd: connection.cwd, mcpServers: await this.forwardedServers(), _meta: browserMeta() });
    let state = modesOf(modes) ?? { current: mode, available: MODE_FALLBACK };
    if (state.current !== mode && state.available.some((m) => m.id === mode)) {
      await connection.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId: mode });
      state = { ...state, current: mode };
    }
    await this.show(sessionId, transcript, undefined, state, configOptions);
    return sessionId;
  }

  /** Loads a session the engine logged, replaying its turns into a transcript the panel then shows. */
  private async load(connection: Connection, sessionId: string): Promise<void> {
    let finished = () => {};
    const tail = new Promise<void>((resolve) => (finished = resolve));
    const replay: Replay = { id: sessionId, transcript: emptyTranscript(this.modelName()), end: undefined, title: undefined, finished };
    this.replay = replay;
    let modes: Modes | undefined;
    let options: acp.LoadSessionResponse['configOptions'];
    try {
      const loaded = await connection.agent.request(acp.methods.agent.session.load, { sessionId, cwd: connection.cwd, mcpServers: await this.forwardedServers(), _meta: browserMeta() });
      modes = modesOf(loaded.modes);
      options = loaded.configOptions;
      await Promise.race([tail, new Promise((resolve) => setTimeout(resolve, REPLAY_TAIL_MS))]);
    } finally {
      this.replay = undefined;
    }
    const transcript = replay.end === undefined ? replay.transcript : reduce(replay.transcript, replay.end);
    await this.show(sessionId, transcript, replay.title, modes ?? { current: 'ask', available: MODE_FALLBACK }, options);
  }

  /** Makes the session the panel's: remembered for the next window, its transcript and title shown. */
  private async show(sessionId: string, transcript: Transcript, title: string | undefined, modes: Modes, options: acp.NewSessionResponse['configOptions']): Promise<void> {
    this.shown = sessionId;
    this.composer.switched(sessionId, options);
    this.dispatch({ type: 'reset', transcript });
    this.retitle(title);
    this.remode(modes);
    await this.memory.save(sessionId);
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
    const session = open(connection);
    this.sessions.set(connection, session);
    const now = await session;
    if (left !== undefined && left !== now) void connection.agent.request(acp.methods.agent.session.close, { sessionId: left }).catch(() => {});
  }

  /** Opens the MCP servers panel. */
  showMcp(): void {
    if (this.view === undefined) this.mcpAsked = true;
    else void this.view.webview.postMessage({ type: 'show-mcp' } satisfies ToView);
  }

  /** Opens the providers, keys and roles page. */
  showSettings(): void {
    if (this.view === undefined) this.settingsAsked = true;
    else void this.view.webview.postMessage({ type: 'show-settings' } satisfies ToView);
  }

  /** Starts a fresh session; the current one stays on disk. A chat with no turns yet is already fresh. */
  async newChat(): Promise<void> {
    this.idle();
    void this.view?.webview.postMessage({ type: 'hide-history' } satisfies ToView);
    if (this.shown !== undefined && this.transcript.turns.length === 0) return;
    await this.moveTo((connection) => this.fresh(connection));
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
      };
    });
  }

  /**
   * Loads a session of this project into the panel, where the chat continues from it. Another project's session
   * opens in that project's window, since its tools run in its own workspace.
   */
  async openChat(sessionId: string, workspace: string): Promise<void> {
    const { cwd } = await this.engine.connection();
    if (workspace !== (await realpath(cwd).catch(() => cwd))) return this.openElsewhere(workspace, sessionId);
    this.idle();
    void this.view?.webview.postMessage({ type: 'hide-history' } satisfies ToView);
    if (sessionId === this.shown) return;
    await this.moveTo((connection) => this.load(connection, sessionId).then(() => sessionId));
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

  private async askPermission({ toolCall, options }: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const id = String(this.nextPermission++);
    const optionId = await new Promise<string | undefined>((resolve) => {
      this.permissions.set(id, resolve);
      const input = permissionInput.safeParse(toolCall.rawInput);
      const { command, reason } = input.success ? input.data : { command: toolCall.title ?? 'a command', reason: '' };
      const memory = rememberInput.safeParse(toolCall._meta?.[REMEMBER_META]);
      this.dispatch({
        type: 'permission',
        id,
        command: memory.success ? memory.data.text : command,
        reason,
        options: options.map(({ optionId, name, kind }) => ({ optionId, name, kind })),
        classifier: classifierReasonOf(toolCall.title),
        ...(memory.success ? { ask: { kind: 'memory', ...memory.data } } : {}),
        toolId: toolCall.toolCallId,
      });
      void vscode.commands.executeCommand(`${CHAT_VIEW}.focus`);
    });
    this.permissions.delete(id);
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
    const request = parsed.value;
    const id = String(this.nextPermission++);
    const answer = await new Promise<AskUserAnswer | undefined>((resolve) => {
      this.questions.set(id, resolve);
      signal.addEventListener('abort', () => resolve(undefined), { once: true });
      this.dispatch({ type: 'permission', id, command: askUserTitle(request), reason: '', options: [], ask: { kind: 'question', request } });
      void vscode.commands.executeCommand(`${CHAT_VIEW}.focus`);
    });
    this.questions.delete(id);
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
        this.composer.refreshModels();
        if (this.mcpAsked) void view.webview.postMessage({ type: 'show-mcp' } satisfies ToView);
        this.mcpAsked = false;
        if (this.settingsAsked) void view.webview.postMessage({ type: 'show-settings' } satisfies ToView);
        this.settingsAsked = false;
        view.description = totalsLabel(this.transcript);
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
      permission: ({ id, optionId }) => this.permissions.get(id)?.(optionId),
      answer: ({ id, answer }) => this.questions.get(id)?.(answer),
      keep: ({ hunks }) => void vscode.commands.executeCommand(KEEP_COMMAND, hunks),
      undo: ({ hunks }) => void vscode.commands.executeCommand(UNDO_COMMAND, hunks),
      reveal: ({ hunk }) => void vscode.commands.executeCommand(REVEAL_COMMAND, hunk),
      copy: ({ text }) => void vscode.env.clipboard.writeText(text),
      'choose-model': () => this.showSettings(),
      'open-diagram': ({ source }) => openDiagram(this.extensionUri, source),
      'set-mode': ({ modeId }) => void this.setMode(modeId).catch(warn),
      'start-building': () => void this.startBuilding().catch(warn),
      'list-sessions': ({ scope }) => this.postHistory(view, scope),
      'open-session': ({ id, workspace }) => void this.openChat(id, workspace).catch(warn),
      'rename-session': ({ id, title, scope }) => void this.renameChat(id, title).then(() => this.postHistory(view, scope), warn),
      'delete-session': ({ id, scope }) => void this.deleteChat(id).then(() => this.postHistory(view, scope), warn),
      ...this.mcp.handlers,
      ...this.panes.handlers,
      ...this.settingsPage.handlers,
      ...this.composer.handlers,
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
    const focus = vscode.window.onDidChangeWindowState(({ focused }) => void view.webview.postMessage({ type: 'window-focus', focused } satisfies ToView));
    view.onDidDispose(() => {
      focus.dispose();
      if (this.view === view) this.view = undefined;
    });
  }
}
