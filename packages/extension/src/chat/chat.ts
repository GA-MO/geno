import * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { z } from 'zod';
import {
  afterLines,
  DIAGNOSTICS_METHOD,
  hunkIdOf,
  INLINE_EDIT_META,
  TOOL_CALL_META,
  TURN_USAGE_META,
  UNSAVED_BUFFERS_METHOD,
  type FileChange,
  type HunkId,
  type HunkStatus,
  type InlineEditTarget,
} from '@g-code/core';
import { KEEP_COMMAND, UNDO_COMMAND } from '../review/controller.js';
import { REVEAL_COMMAND } from '../review/tree.js';
import { diagnostics, readTextFile, unsavedBuffers, writeTextFile } from './bridge.js';
import { openDiagram } from './diagram-tab.js';
import { Engine, type Connection, type EngineSettings } from './engine.js';
import { formatCost, formatTokens } from './format.js';
import { Mentions } from './context.js';
import { TOOL_KINDS, type Action, type FileDiff, type FromView, type ToView, type ToolKind, type ToolStatus, type Transcript, type TurnStatus, type Usage } from './messages.js';
import { pageHtml } from './page.js';
import { emptyTranscript, reduce, totalsOf } from './transcript.js';

export const CHAT_VIEW = 'gcode.chat';
export const SEND_COMMAND = 'gcode.chat.send';
export const STOP_COMMAND = 'gcode.chat.stop';

const diagnosticsRequest = z.object({ sessionId: z.string(), paths: z.array(z.string()) });
const unsavedBuffersRequest = z.object({ sessionId: z.string() });
const turnUsage = z.object({ model: z.string(), costUsd: z.number().nullable() });
const permissionInput = z.object({ command: z.string(), reason: z.string() });

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
  tool_call_update: ({ toolCallId, title, status, content }, at) => {
    const output = outputOf(content);
    return {
      type: 'tool',
      id: toolCallId,
      at,
      ...(title == null ? {} : callOf(title)),
      ...(status == null ? {} : { status: TOOL_STATUSES[status] }),
      ...(output === undefined ? {} : { output }),
    };
  },
};

const actionOf = <K extends acp.SessionUpdate['sessionUpdate']>(update: UpdateOf<K>, at: number): Action | undefined =>
  (UPDATES[update.sessionUpdate] as ((u: UpdateOf<K>, at: number) => Action | undefined) | undefined)?.(update, at);

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

function diffOf(document: vscode.TextDocument, change: FileChange): FileDiff {
  const lines = afterLines(change);
  return {
    path: vscode.workspace.asRelativePath(document.uri),
    hunks: change.hunks.map((hunk, i) => ({ id: hunkIdOf(change, i), line: lines[i]!, removed: linesOf(hunk.oldText), added: linesOf(hunk.newText), status: 'pending' })),
  };
}

/** The session total shown beside the view's title; empty until a turn reports usage. */
function totalsLabel(transcript: Transcript): string {
  const totals = totalsOf(transcript);
  if (totals.turns === 0) return '';
  const tokens = `${formatTokens(totals.inputTokens + totals.outputTokens)} tokens`;
  return totals.costUsd === null ? tokens : `${formatCost(totals.costUsd)} · ${tokens}`;
}

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
  private nextPermission = 0;
  private readonly mentions = new Mentions();

  constructor(
    settings: () => Promise<EngineSettings>,
    private readonly extensionUri: vscode.Uri,
    output: vscode.OutputChannel,
    private readonly memory: SessionMemory,
    private readonly onWrite: WriteListener,
    private readonly modelName: () => string,
  ) {
    this.engine = new Engine(settings, () => this.client(), output);
    this.transcript = emptyTranscript(modelName());
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
  }

  /** Mirrors review decisions made anywhere, the editor's CodeLens included, onto the diff cards. */
  reviewed(hunks: readonly { readonly id: HunkId; readonly status: HunkStatus }[]): void {
    this.dispatch({ type: 'review', hunks: Object.fromEntries(hunks.map((h) => [h.id, h.status])) });
  }

  dispose(): void {
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
          if (typeof toolId === 'string') this.dispatch({ type: 'diff', toolId, at: Date.now(), diff: diffOf(document, change) });
        }),
      )
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => this.askPermission(params))
      .onRequest(DIAGNOSTICS_METHOD, diagnosticsRequest, ({ params }) => diagnostics(params.paths))
      .onRequest(UNSAVED_BUFFERS_METHOD, unsavedBuffersRequest, () => unsavedBuffers())
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        const action = actionOf(params.update, Date.now());
        if (action !== undefined) this.dispatch(action);
      });
  }

  /** Runs one agent turn and resolves with its stop reason. Its `@file` and `@selection` mentions go along as context. */
  send(text: string): Promise<acp.StopReason> {
    return this.prompt(text, text, undefined, () => this.mentions.blocks(text));
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
  ): Promise<acp.StopReason> {
    if (this.turn !== undefined) throw new Error('a turn is already running; stop it first');
    this.dispatch({ type: 'turn-start', id: `t${this.nextTurn++}`, prompt: shown });
    try {
      this.turn = await this.link();
      const response = await this.turn.connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: this.turn.sessionId,
        prompt: [{ type: 'text', text }, ...(await attachments())],
        ...(meta === undefined ? {} : { _meta: meta }),
      });
      const ending = ENDINGS[response.stopReason];
      if (ending.message !== undefined) this.dispatch({ type: 'error', message: ending.message });
      this.dispatch({ type: 'turn-end', status: ending.status, usage: usageOf(response) });
      return response.stopReason;
    } catch (error) {
      this.dispatch({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      this.dispatch({ type: 'turn-end', status: 'failed', usage: undefined });
      throw error;
    } finally {
      this.turn = undefined;
    }
  }

  async stop(): Promise<void> {
    const turn = this.turn;
    if (turn === undefined) return;
    // ACP: a client that cancels a turn answers its open permission requests as cancelled.
    for (const answer of this.permissions.values()) answer(undefined);
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

  /** Resumes the stored session, or starts one when there is none or the engine no longer has it. */
  private async openSession(connection: Connection): Promise<string> {
    const { cwd } = connection;
    const stored = await this.storedSession();
    if (stored !== undefined) {
      try {
        await connection.agent.request(acp.methods.agent.session.resume, { sessionId: stored, cwd });
        return stored;
      } catch {
        // A log deleted or from another machine; start over.
      }
    }
    const { sessionId } = await connection.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    await this.memory.save(sessionId);
    return sessionId;
  }

  private async askPermission({ toolCall, options }: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const id = String(this.nextPermission++);
    const optionId = await new Promise<string | undefined>((resolve) => {
      this.permissions.set(id, resolve);
      const input = permissionInput.safeParse(toolCall.rawInput);
      const { command, reason } = input.success ? input.data : { command: toolCall.title ?? 'a command', reason: '' };
      this.dispatch({ type: 'permission', id, command, reason, options: options.map(({ optionId, name, kind }) => ({ optionId, name, kind })) });
      void vscode.commands.executeCommand(`${CHAT_VIEW}.focus`);
    });
    this.permissions.delete(id);
    this.dispatch({ type: 'permission-done', id, optionId });
    return { outcome: optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId } };
  }

  /** Applies a change to the transcript and sends it to the webview, which applies the same change. */
  private dispatch(action: Action): void {
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
        void view.webview.postMessage({ type: 'reset', transcript: this.transcript } satisfies Action);
        view.description = totalsLabel(this.transcript);
        this.view = view;
      },
      send: ({ text }) => void this.send(text).catch(() => {}),
      complete: ({ id, query }) =>
        void this.mentions.completions(query).then(
          (items) => view.webview.postMessage({ type: 'completions', id, items } satisfies ToView),
          () => view.webview.postMessage({ type: 'completions', id, items: [] } satisfies ToView),
        ),
      stop: () => void this.stop(),
      permission: ({ id, optionId }) => this.permissions.get(id)?.(optionId),
      keep: ({ hunk }) => void vscode.commands.executeCommand(KEEP_COMMAND, hunk),
      undo: ({ hunk }) => void vscode.commands.executeCommand(UNDO_COMMAND, hunk),
      reveal: ({ hunk }) => void vscode.commands.executeCommand(REVEAL_COMMAND, hunk),
      copy: ({ text }) => void vscode.env.clipboard.writeText(text),
      'open-diagram': ({ source }) => openDiagram(this.extensionUri, source),
    };
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    view.webview.html = pageHtml(view.webview, dist, 'webview.js');
    const handlers = this.handlers(view);
    view.webview.onDidReceiveMessage((message: FromView) => (handlers[message.type] as (m: FromView) => void)(message));
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }
}
