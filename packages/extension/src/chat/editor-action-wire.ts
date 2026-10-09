import { z } from 'zod';
import { EDITOR_ACTION_META, type EditorAction, type EditorActionRequest } from '@g-code/core';

const position = z.number().int().positive();

const editorAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('open'), path: z.string().min(1), line: position.optional(), column: position.optional() }),
  z.object({ kind: z.literal('diff'), path: z.string().min(1), base: z.object({ sha: z.string().min(1), since: z.enum(['turn', 'session']) }) }),
  z.object({ kind: z.literal('reveal'), path: z.string().min(1) }),
]) satisfies z.ZodType<EditorAction>;

export const editorActionRequest = z.object({ sessionId: z.string(), action: editorAction }) satisfies z.ZodType<EditorActionRequest>;

/** The action a tool call's closing update says it carried out, if any. */
export function editorActionOf(meta: Record<string, unknown> | null | undefined): EditorAction | undefined {
  const parsed = editorAction.safeParse(meta?.[EDITOR_ACTION_META]);
  return parsed.success ? parsed.data : undefined;
}
