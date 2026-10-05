import * as vscode from 'vscode';
import {
  GLOBAL_RULES_METHOD,
  MEMORY_DELETE_METHOD,
  MEMORY_EDIT_METHOD,
  MEMORY_METHOD,
  RULES_METHOD,
  type GlobalRulesResponse,
  type MemoryDeleteRequest,
  type MemoryEditRequest,
  type MemoryRequest,
  type MemoryResponse,
  type RulesRequest,
  type RulesResponse,
} from '@g-code/core';
import type { Connection } from './engine.js';
import type { ContextFromView, ContextToView, MemoryListing, RulesListing } from './messages.js';

type Link = { readonly connection: Connection; readonly sessionId: string };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The rules and memory panes' side in the extension: each request goes to the shown session, and its answer to the webview. */
export class ContextPanes {
  constructor(
    private readonly link: () => Promise<Link>,
    private readonly post: (message: ContextToView) => void,
  ) {}

  private async rules(): Promise<void> {
    let listing: RulesListing;
    try {
      const { connection, sessionId } = await this.link();
      listing = { kind: 'loaded', ...(await connection.agent.request<RulesResponse, RulesRequest>(RULES_METHOD, { sessionId })) };
    } catch (error) {
      listing = { kind: 'failed', message: messageOf(error) };
    }
    this.post({ type: 'rules', listing });
  }

  /** `request` answers with the memory, which the pane shows; a refused change leaves the pane as it was and says why. */
  private async memory(request: (link: Link) => Promise<MemoryResponse>, warn = false): Promise<void> {
    let listing: MemoryListing;
    try {
      listing = { kind: 'loaded', ...(await request(await this.link())) };
    } catch (error) {
      if (warn) {
        void vscode.window.showWarningMessage(messageOf(error));
        return this.memory((link) => link.connection.agent.request<MemoryResponse, MemoryRequest>(MEMORY_METHOD, { sessionId: link.sessionId }));
      }
      listing = { kind: 'failed', message: messageOf(error) };
    }
    this.post({ type: 'memory', listing });
  }

  readonly handlers: { readonly [K in ContextFromView['type']]: (message: Extract<ContextFromView, { type: K }>) => void } = {
    'rules-list': () => void this.rules(),
    'open-file': ({ file }) => void vscode.window.showTextDocument(vscode.Uri.file(file)).then(undefined, (error: unknown) => vscode.window.showWarningMessage(messageOf(error))),
    'edit-global-rules': () =>
      void this.link()
        .then(({ connection, sessionId }) => connection.agent.request<GlobalRulesResponse, RulesRequest>(GLOBAL_RULES_METHOD, { sessionId }))
        .then(({ file }) => vscode.window.showTextDocument(vscode.Uri.file(file)))
        .then(undefined, (error: unknown) => vscode.window.showWarningMessage(messageOf(error))),
    'memory-list': () => void this.memory((link) => link.connection.agent.request<MemoryResponse, MemoryRequest>(MEMORY_METHOD, { sessionId: link.sessionId })),
    'memory-edit': ({ id, text }) =>
      void this.memory((link) => link.connection.agent.request<MemoryResponse, MemoryEditRequest>(MEMORY_EDIT_METHOD, { sessionId: link.sessionId, id, text }), true),
    'memory-delete': ({ id }) =>
      void this.memory((link) => link.connection.agent.request<MemoryResponse, MemoryDeleteRequest>(MEMORY_DELETE_METHOD, { sessionId: link.sessionId, id }), true),
  };
}
