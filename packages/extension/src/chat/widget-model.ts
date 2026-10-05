import type * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import { WIDGET_DRAFT_META, WIDGET_META } from '@g-code/core';
import type { ToolWidget } from './messages.js';

const draftMeta = z.object({ title: z.string().optional(), loadingMessages: z.array(z.string()) });
const refMeta = z.object({ sha256: z.string(), title: z.string() });

const htmlOf = (content: readonly acp.ToolCallContent[] | null | undefined): string | undefined => {
  for (const c of content ?? []) {
    if (c.type === 'content' && c.content.type === 'resource' && c.content.resource.mimeType === 'text/html' && 'text' in c.content.resource) return c.content.resource.text;
  }
  return undefined;
};

/** What a tool call's update says about its widget: the draft the model is writing, or the stored widget once it ran. */
export function widgetOf(update: acp.SessionUpdate): ToolWidget | undefined {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return undefined;
  const meta = update._meta ?? {};
  if (meta[WIDGET_DRAFT_META] !== undefined) {
    const draft = draftMeta.safeParse(meta[WIDGET_DRAFT_META]);
    return draft.success ? { state: 'drafting', title: draft.data.title, loading: draft.data.loadingMessages } : undefined;
  }
  if (update.sessionUpdate !== 'tool_call_update' || meta[WIDGET_META] === undefined) return undefined;
  const ref = refMeta.safeParse(meta[WIDGET_META]);
  if (!ref.success) return undefined;
  const html = htmlOf(update.content);
  return html === undefined ? { state: 'missing', title: ref.data.title } : { state: 'ready', title: ref.data.title, sha256: ref.data.sha256, html };
}
