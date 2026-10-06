import * as acp from '@agentclientprotocol/sdk';
import { SUBAGENT_META, SUBAGENT_METHOD, type ChildEnd, type ChildStatus, type SubagentNotice } from '@g-code/core';
import type { Watcher } from './drive.js';
import type { ChildSpent, ChildView, SubagentHost } from './subagents.js';

/** A child's own stream of session updates, sent under the child's session id. */
export type ChildStream = { readonly watcher: Watcher; flush(): Promise<void> };

export type AcpChildren = {
  readonly client: { notify(method: string, params: unknown): Promise<void> };
  readonly parentId: string;
  /** The editor advertised ACP's `subagents`, so children are announced natively and stream under their own ids. */
  readonly native: boolean;
  /** Settles once every update the parent's turn has sent so far went out, so an announcement precedes the child's traffic. */
  readonly flushParent: () => Promise<void>;
  readonly streamOf: (childId: string) => ChildStream;
  /** Where `session/cancel` finds a running child by its session id. */
  readonly cancels: Map<string, () => void>;
  readonly err: (line: string) => void;
};

const STOP_REASONS: { readonly [K in ChildEnd['kind']]: acp.StopReason } = {
  done: 'end_turn',
  failed: 'end_turn',
  cancelled: 'cancelled',
  capped: 'max_turn_requests',
};

const noticeOf = (parentId: string, child: ChildView, status: ChildStatus, spent: ChildSpent): SubagentNotice => ({
  sessionId: parentId,
  child: child.id,
  toolUseId: child.toolUseId,
  role: child.agent.name,
  task: child.task,
  model: child.model,
  effort: child.effort,
  caps: child.caps,
  status,
  turns: spent.turns,
  costUsd: spent.costUsd,
});

/**
 * Children over ACP. An editor that advertises `subagents` gets `subagent_update` on the parent session, with cancel
 * allowed, and the child's own updates under its id. Any other editor gets the same data as `_gcode/subagent`.
 */
export function acpChildHost(acpChildren: AcpChildren): SubagentHost {
  const { client, parentId, native, cancels } = acpChildren;
  const streams = new Map<string, ChildStream>();
  const tell = async (child: ChildView, status: ChildStatus, spent: ChildSpent) => {
    const notice = noticeOf(parentId, child, status, spent);
    await acpChildren.flushParent();
    if (!native) return client.notify(SUBAGENT_METHOD, notice);
    const state: acp.StateUpdate = status.kind === 'running' ? { state: 'running' } : { state: 'idle', stopReason: STOP_REASONS[status.kind] };
    const update: acp.SessionUpdate = {
      sessionUpdate: 'subagent_update',
      sessionId: child.id,
      ...(status.kind === 'running' ? { title: child.agent.name, description: child.task.split('\n')[0]!, capabilities: { cancel: {} } } : {}),
      state,
      _meta: { [SUBAGENT_META]: notice },
    };
    return client.notify(acp.methods.client.session.update, { sessionId: parentId, update });
  };
  const failed = (error: unknown) => acpChildren.err(`subagent update failed: ${String(error)}`);
  return {
    async started(child, cancel) {
      cancels.set(child.id, cancel);
      await tell(child, { kind: 'running' }, { turns: 0, costUsd: 0 }).catch(failed);
      if (!native) return { text: () => {}, toolStart: () => {}, toolEnd: () => {}, logged: () => {} };
      const stream = acpChildren.streamOf(child.id);
      streams.set(child.id, stream);
      return stream.watcher;
    },
    async ended(child, end, spent) {
      cancels.delete(child.id);
      await streams.get(child.id)?.flush();
      streams.delete(child.id);
      await tell(child, end, spent).catch(failed);
    },
  };
}
