import * as acp from '@agentclientprotocol/sdk';
import {
  FORK_AT_META,
  REWIND_PREVIEW_METHOD,
  REWIND_TURN_METHOD,
  type RewindPreviewRequest,
  type RewindPreviewResponse,
  type RewindTurnRequest,
  type RewindTurnResponse,
} from '@g-code/core';
import type { Connection } from './engine.js';
import { RESTORES_FILES, type RewindFromView, type RewindState, type RewindToView } from './rewind-model.js';

/** What rewinding and forking need of the chat. */
export type RewindChat = {
  readonly connection: () => Promise<Connection>;
  /** The session the panel shows and the folder it works in, undefined while a turn runs in it. */
  readonly idle: () => { readonly sessionId: string; readonly cwd: string | undefined } | undefined;
  readonly seqOf: (turn: string) => number | undefined;
  /** The turn whose prompt is `seq` in the transcript shown now, whose ids a reload renews. */
  readonly turnAt: (seq: number) => string | undefined;
  /** Loads the shown session again, so the transcript shows the cut and the hunks a restore undid. */
  readonly reload: () => Promise<void>;
  /** Shows the new fork in the panel. */
  readonly open: (sessionId: string) => Promise<void>;
  readonly post: (message: RewindToView) => void;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Runs the message menu's choices against the engine and tells the panel how each went, on the message it came from. */
export class RewindHost {
  constructor(private readonly chat: RewindChat) {}

  readonly handlers: { readonly [K in RewindFromView['type']]: (message: Extract<RewindFromView, { type: K }>) => void } = {
    rewind: (message) => void this.rewind(message),
    fork: (message) => void this.fork(message.turn),
  };

  private state(turn: string, state: RewindState | undefined): void {
    this.chat.post({ type: 'rewind-state', turn, state });
  }

  /** The shown session and the turn's prompt, or why the menu cannot act now. */
  private target(turn: string): { readonly sessionId: string; readonly cwd: string | undefined; readonly turnSeq: number } {
    const idle = this.chat.idle();
    if (idle === undefined) throw new Error('Stop the running turn first.');
    const turnSeq = this.chat.seqOf(turn);
    if (turnSeq === undefined) throw new Error('This message is not in the session log yet.');
    return { ...idle, turnSeq };
  }

  private async rewind({ turn, kind, confirmed }: Extract<RewindFromView, { type: 'rewind' }>): Promise<void> {
    try {
      const { sessionId, turnSeq } = this.target(turn);
      const { agent } = await this.chat.connection();
      if (RESTORES_FILES[kind] && !confirmed) {
        this.state(turn, { kind: 'working', action: kind });
        const preview = await agent.request<RewindPreviewResponse, RewindPreviewRequest>(REWIND_PREVIEW_METHOD, { sessionId, turnSeq });
        return this.state(turn, { kind: 'confirm', action: kind, files: preview.files, unsaved: preview.unsaved });
      }
      this.state(turn, { kind: 'working', action: kind });
      const done = await agent.request<RewindTurnResponse, RewindTurnRequest>(REWIND_TURN_METHOD, { sessionId, turnSeq, choice: { kind } });
      await this.chat.reload();
      if (kind === 'files') return this.state(this.chat.turnAt(turnSeq) ?? turn, { kind: 'restored', files: done.files });
      this.chat.post({ type: 'rewind-prompt', text: done.prompt });
    } catch (error) {
      this.state(turn, { kind: 'failed', message: messageOf(error) });
    }
  }

  private async fork(turn: string): Promise<void> {
    try {
      const { sessionId, cwd, turnSeq } = this.target(turn);
      const connection = await this.chat.connection();
      this.state(turn, { kind: 'working', action: 'fork' });
      const forked = await connection.agent.request(acp.methods.agent.session.fork, { sessionId, cwd: cwd ?? connection.cwd, mcpServers: [], _meta: { [FORK_AT_META]: turnSeq } });
      this.state(turn, undefined);
      await this.chat.open(forked.sessionId);
    } catch (error) {
      this.state(turn, { kind: 'failed', message: messageOf(error) });
    }
  }
}
