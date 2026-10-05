import type * as acp from '@agentclientprotocol/sdk';
import type { McpServersResponse } from '@g-code/core';
import type { Env } from '../child-env.js';
import type { Store } from '../store.js';
import type { Approval } from '../tools/agent.js';
import { openMcpHub, type McpHub, type McpToolset } from './hub.js';

/** The MCP hubs of every session `gcode serve` knows. A hub opens on the session's first need, and all stop with the engine. */
export type McpSessions = {
  /** Records what session/new or session/resume said; nothing is read or started yet. */
  register(sessionId: string, workspace: string, servers: readonly acp.McpServer[]): void;
  toolset(sessionId: string, approval: Approval): Promise<McpToolset>;
  servers(sessionId: string): Promise<McpServersResponse>;
  trust(sessionId: string, name: string): Promise<McpServersResponse>;
  stopAll(): Promise<void>;
};

export function mcpSessions(store: Store, env: Env): McpSessions {
  const pending = new Map<string, { readonly workspace: string; readonly servers: readonly acp.McpServer[] }>();
  const hubs = new Map<string, Promise<McpHub>>();
  const hubOf = (sessionId: string): Promise<McpHub> => {
    const open = hubs.get(sessionId);
    if (open !== undefined) return open;
    const { workspace, servers } = pending.get(sessionId) ?? { workspace: '', servers: [] };
    const hub = openMcpHub({ store, env, workspace, acp: servers });
    // A hub that failed to open, such as for a malformed trust file, is retried at the next need.
    hub.catch(() => hubs.delete(sessionId));
    hubs.set(sessionId, hub);
    return hub;
  };
  const response = (hub: McpHub): McpServersResponse => ({ servers: hub.views(), problems: hub.problems });
  return {
    register(sessionId, workspace, servers) {
      if (!pending.has(sessionId)) pending.set(sessionId, { workspace, servers });
    },
    toolset: async (sessionId, approval) => (await hubOf(sessionId)).toolset(approval),
    servers: async (sessionId) => response(await hubOf(sessionId)),
    async trust(sessionId, name) {
      const hub = await hubOf(sessionId);
      await hub.trust(name);
      return response(hub);
    },
    async stopAll() {
      const open = [...hubs.values()];
      hubs.clear();
      await Promise.all(open.map(async (hub) => (await hub.catch(() => undefined))?.stop()));
    },
  };
}
