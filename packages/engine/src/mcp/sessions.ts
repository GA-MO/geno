import type * as acp from '@agentclientprotocol/sdk';
import type { McpServersResponse } from '@g-code/core';
import type { Env } from '../child-env.js';
import type { Store } from '../store.js';
import type { Approval } from '../tools/agent.js';
import { openMcpHub, type McpHub, type McpToolset } from './hub.js';

/**
 * The MCP hubs of every session `gcode serve` knows. A session's servers start in the background as soon as it
 * opens, so its first prompt never waits for a cold server; each turn takes the tools of the servers ready by then.
 */
export type McpSessions = {
  /** Records what session/new, session/load or session/resume said, and starts the session's servers. */
  register(sessionId: string, workspace: string, servers: readonly acp.McpServer[]): void;
  toolset(sessionId: string, approval: Approval): Promise<McpToolset>;
  servers(sessionId: string): Promise<McpServersResponse>;
  trust(sessionId: string, name: string, hash: string): Promise<McpServersResponse>;
  setEnabled(sessionId: string, name: string, enabled: boolean): Promise<McpServersResponse>;
  /** Stops the session's servers; a later register opens them again. */
  close(sessionId: string): Promise<void>;
  stopAll(): Promise<void>;
};

export function mcpSessions(store: Store, env: Env, log: (line: string) => void = () => {}): McpSessions {
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
  // Not awaited by anyone: a server that fails shows as failed in its state, and the rest is only worth a log line.
  const startInBackground = (sessionId: string) =>
    void hubOf(sessionId)
      .then((hub) => hub.start())
      .catch((error: unknown) => log(`mcp: could not start the servers of ${sessionId}: ${error instanceof Error ? error.message : String(error)}`));
  const response = (hub: McpHub): McpServersResponse => ({ servers: hub.views(), problems: hub.problems });
  return {
    register(sessionId, workspace, servers) {
      if (!pending.has(sessionId)) pending.set(sessionId, { workspace, servers });
      startInBackground(sessionId);
    },
    async toolset(sessionId, approval) {
      const toolset = (await hubOf(sessionId)).toolset(approval);
      // A server trusted elsewhere since, such as by `gcode mcp trust`, starts now and joins a later turn.
      startInBackground(sessionId);
      return toolset;
    },
    servers: async (sessionId) => response(await hubOf(sessionId)),
    async trust(sessionId, name, hash) {
      const hub = await hubOf(sessionId);
      await hub.trust(name, hash);
      startInBackground(sessionId);
      return response(hub);
    },
    async setEnabled(sessionId, name, enabled) {
      const hub = await hubOf(sessionId);
      await hub.setEnabled(name, enabled);
      if (enabled) startInBackground(sessionId);
      return response(hub);
    },
    async close(sessionId) {
      const hub = hubs.get(sessionId);
      hubs.delete(sessionId);
      pending.delete(sessionId);
      await (await hub?.catch(() => undefined))?.stop();
    },
    async stopAll() {
      const open = [...hubs.values()];
      hubs.clear();
      await Promise.all(open.map(async (hub) => (await hub.catch(() => undefined))?.stop()));
    },
  };
}
