import type * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import { COMPACT_META, COMPACT_TRIGGERS, type CompactMark } from '@g-code/core';
import type { Action } from './messages.js';

const compactMark = z.object({
  seq: z.number().int(),
  trigger: z.enum(COMPACT_TRIGGERS),
  tokensBefore: z.number(),
  tokensAfter: z.number(),
  summary: z.string(),
  files: z.object({ read: z.array(z.string()), changed: z.array(z.string()) }),
  focus: z.string().optional(),
}) satisfies z.ZodType<CompactMark>;

type AgentChunk = Extract<acp.SessionUpdate, { sessionUpdate: 'agent_message_chunk' }>;

/**
 * An agent message chunk as the transcript takes it: the divider when the engine marked it as a compaction, live or
 * replayed, since its text only says the same in words for other clients; otherwise the model's text.
 */
export function agentChunkAction(update: AgentChunk): Extract<Action, { type: 'compact' | 'text' }> | undefined {
  const mark = compactMark.safeParse(update._meta?.[COMPACT_META]);
  if (mark.success) return { type: 'compact', mark: mark.data };
  return update.content.type === 'text' ? { type: 'text', text: update.content.text } : undefined;
}
