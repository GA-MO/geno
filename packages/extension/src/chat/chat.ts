import { randomBytes } from 'node:crypto';
import * as acp from '@agentclientprotocol/sdk';
import * as vscode from 'vscode';
import { z } from 'zod';
import { DIAGNOSTICS_METHOD, INLINE_EDIT_META, type FileChange, type InlineEditTarget } from '@g-code/core';
import { diagnostics, readTextFile, writeTextFile } from './bridge.js';
import { Engine, type Connection, type EngineSettings } from './engine.js';
import type { FromView, ToView } from './messages.js';

export const CHAT_VIEW = 'gcode.chat';
export const SEND_COMMAND = 'gcode.chat.send';
export const STOP_COMMAND = 'gcode.chat.stop';

const diagnosticsRequest = z.object({ sessionId: z.string(), paths: z.array(z.string()) });

type UpdateOf<K extends acp.SessionUpdate['sessionUpdate']> = Extract<acp.SessionUpdate, { sessionUpdate: K }>;

const UPDATES: { readonly [K in acp.SessionUpdate['sessionUpdate']]?: (update: UpdateOf<K>) => ToView | undefined } = {
  agent_message_chunk: ({ content }) => (content.type === 'text' ? { type: 'text', text: content.text } : undefined),
  tool_call: ({ toolCallId, title, status }) => ({ type: 'tool', id: toolCallId, title, status: status ?? 'pending' }),
  tool_call_update: ({ toolCallId, title, status }) => ({ type: 'tool', id: toolCallId, title: title ?? undefined, status: status ?? undefined }),
};

const viewOf = <K extends acp.SessionUpdate['sessionUpdate']>(update: UpdateOf<K>): ToView | undefined =>
  (UPDATES[update.sessionUpdate] as ((u: UpdateOf<K>) => ToView | undefined) | undefined)?.(update);

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
  /** Everything posted so far, replayed whenever the webview is created again. */
  private readonly transcript: ToView[] = [];
  private readonly sessions = new WeakMap<Connection, Promise<string>>();
  private turn: SessionLink | undefined;
  private readonly permissions = new Map<string, (optionId: string | undefined) => void>();
  private nextPermission = 0;

  constructor(
    settings: () => Promise<EngineSettings>,
    private readonly extensionUri: vscode.Uri,
    output: vscode.OutputChannel,
    private readonly memory: SessionMemory,
    private readonly onWrite: WriteListener,
  ) {
    this.engine = new Engine(settings, () => this.client(), output);
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
  }

  dispose(): void {
    this.engine.dispose();
  }

  /** The handlers the engine calls back into: the buffer and diagnostics bridges, permission prompts, and updates. */
  private client(): acp.ClientApp {
    return acp
      .client({ name: 'g-code' })
      .onRequest(acp.methods.client.fs.readTextFile, ({ params }) => readTextFile(params))
      .onRequest(acp.methods.client.fs.writeTextFile, ({ params }) => writeTextFile(params, this.onWrite))
      .onRequest(acp.methods.client.session.requestPermission, ({ params }) => this.askPermission(params))
      .onRequest(DIAGNOSTICS_METHOD, diagnosticsRequest, ({ params }) => diagnostics(params.paths))
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        const message = viewOf(params.update);
        if (message !== undefined) this.post(message);
      });
  }

  /** Runs one agent turn and resolves with its stop reason. */
  send(text: string): Promise<acp.StopReason> {
    return this.prompt(text, text, undefined);
  }

  /** Cmd-K: a one-shot edit of a selection, shown in the panel like a turn. */
  inlineEdit(target: InlineEditTarget, instruction: string, file: vscode.Uri): Promise<acp.StopReason> {
    const lines = target.startLine === target.endLine ? `line ${target.startLine}` : `lines ${target.startLine}-${target.endLine}`;
    const shown = `Edit ${lines} of ${vscode.workspace.asRelativePath(file)}: ${instruction}`;
    return this.prompt(shown, instruction, { [INLINE_EDIT_META]: target });
  }

  private async prompt(shown: string, text: string, meta: Record<string, unknown> | undefined): Promise<acp.StopReason> {
    if (this.turn !== undefined) throw new Error('a turn is already running; stop it first');
    this.post({ type: 'user', text: shown });
    this.post({ type: 'turn', running: true, stopReason: undefined });
    try {
      this.turn = await this.link();
      const { stopReason } = await this.turn.connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: this.turn.sessionId,
        prompt: [{ type: 'text', text }],
        ...(meta === undefined ? {} : { _meta: meta }),
      });
      this.post({ type: 'turn', running: false, stopReason });
      return stopReason;
    } catch (error) {
      this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      this.post({ type: 'turn', running: false, stopReason: undefined });
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
      this.post({ type: 'permission', id, title: toolCall.title ?? 'The agent asks for permission', options });
      void vscode.commands.executeCommand(`${CHAT_VIEW}.focus`);
    });
    this.permissions.delete(id);
    this.post({ type: 'permission-done', id });
    return { outcome: optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId } };
  }

  private post(message: ToView): void {
    this.transcript.push(message);
    void this.view?.webview.postMessage(message);
  }

  private handlers(view: vscode.WebviewView): { readonly [K in FromView['type']]: (message: Extract<FromView, { type: K }>) => void } {
    return {
      // Live messages start only once the replay is sent, so the webview sees each message once and in order.
      ready: () => {
        for (const message of this.transcript) void view.webview.postMessage(message);
        this.view = view;
      },
      send: ({ text }) => void this.send(text).catch(() => {}),
      stop: () => void this.stop(),
      permission: ({ id, optionId }) => this.permissions.get(id)?.(optionId),
    };
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    const dist = vscode.Uri.joinPath(this.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [dist] };
    const nonce = randomBytes(16).toString('base64');
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    view.webview.html = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
</head><body><script nonce="${nonce}" src="${script}"></script></body></html>`;
    const handlers = this.handlers(view);
    view.webview.onDidReceiveMessage((message: FromView) => (handlers[message.type] as (m: FromView) => void)(message));
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }
}
