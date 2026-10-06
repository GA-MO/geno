import type * as acp from '@agentclientprotocol/sdk';
import { CHILD_CAPS, SUBAGENT_META } from '@g-code/core';
import { z } from 'zod';
import { CHILD_ACTIONS, type Action, type ChildAction } from './messages.js';

const childEnd = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('done') }),
  z.object({ kind: z.literal('failed'), reason: z.string() }),
  z.object({ kind: z.literal('cancelled') }),
  z.object({ kind: z.literal('capped'), cap: z.enum(CHILD_CAPS) }),
]);

/** The engine's `SubagentNotice`, which rides on each `subagent_update` under `_meta`. */
const subagentNotice = z.object({
  child: z.string(),
  toolUseId: z.string(),
  role: z.string(),
  task: z.string(),
  model: z.string(),
  status: z.union([z.object({ kind: z.literal('running') }), childEnd]),
  turns: z.number(),
  costUsd: z.number().nullable(),
});

/** A child starting or ending, from the `subagent_update` the engine sends on the parent session. */
export function subagentAction(update: Extract<acp.SessionUpdate, { sessionUpdate: 'subagent_update' }>, at: number): Action | undefined {
  const notice = subagentNotice.safeParse(update._meta?.[SUBAGENT_META]);
  if (!notice.success) return undefined;
  const { child: id, toolUseId, role, task, model, status, turns, costUsd } = notice.data;
  if (status.kind === 'running') return { type: 'child-start', id, toolId: toolUseId, role, task, model, at };
  return { type: 'child-end', id, at, end: status, turns, costUsd };
}

export const isChildAction = (action: Action | undefined): action is ChildAction => (CHILD_ACTIONS as readonly string[]).includes(action?.type ?? '');
