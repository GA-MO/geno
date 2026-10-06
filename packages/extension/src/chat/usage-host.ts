import { USAGE_METHOD, type UsageRequest, type UsageResponse } from '@g-code/core';
import type { Connection } from './engine.js';
import type { UsageFromView, UsageToView } from './usage-model.js';

/** What the breakdown needs of the chat: the engine, and the session the panel shows. */
export type UsageChat = {
  readonly connection: () => Promise<Connection>;
  readonly shown: () => string | undefined;
  readonly post: (message: UsageToView) => void;
};

/** Asks the engine where the shown session's tokens went, the numbers `gcode usage` prints, for the breakdown a usage line opened. */
export class UsageHost {
  constructor(private readonly chat: UsageChat) {}

  readonly handlers: { readonly [K in UsageFromView['type']]: (message: Extract<UsageFromView, { type: K }>) => void } = {
    usage: ({ turn }) => void this.spend(turn),
  };

  private async spend(turn: string): Promise<void> {
    try {
      const sessionId = this.chat.shown();
      if (sessionId === undefined) throw new Error('No session is shown.');
      const { agent } = await this.chat.connection();
      const spend = await agent.request<UsageResponse, UsageRequest>(USAGE_METHOD, { sessionId });
      this.chat.post({ type: 'usage-spend', turn, spend });
    } catch (error) {
      this.chat.post({ type: 'usage-failed', turn, message: error instanceof Error ? error.message : String(error) });
    }
  }
}
