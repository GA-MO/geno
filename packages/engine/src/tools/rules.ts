import path from 'node:path';
import {
  attachedRulePaths,
  renderContextItems,
  ruleAttachment,
  rulesMatching,
  toolResultText,
  type ProjectRule,
  type TurnEvent,
} from '@g-code/core';
import { displayPath, resolveInside, type Executor } from './context.js';

/** Hands out each `globs` rule of the session once: the first time a file it matches enters the context. */
export type RuleAttacher = { take(file: string): ProjectRule[] };

const NO_RULES: RuleAttacher = { take: () => [] };

/** What `events` already attached is not attached again, so a resumed session does not repeat a rule. */
export function ruleAttacher(events: readonly TurnEvent[]): RuleAttacher {
  const start = events[0];
  const context = start?.kind === 'session-start' ? start.context : undefined;
  if (context === undefined) return NO_RULES;
  const attached = attachedRulePaths(
    events.flatMap((e) => (e.kind === 'tool-result' ? [toolResultText(e)] : e.kind === 'user' && e.context !== undefined ? [renderContextItems(e.context)] : [])),
  );
  return {
    take(file) {
      const fresh = rulesMatching(context, file).filter((rule) => !attached.has(rule.path));
      for (const rule of fresh) attached.add(rule.path);
      return fresh;
    },
  };
}

/** A rule too long to ride along with a read result is named instead, for the model to read. */
function attachments(text: string, rules: readonly ProjectRule[], file: string, spillChars: number): string {
  const full = rules.map((rule) => ruleAttachment(rule, file));
  if ([text, ...full].join('\n\n').length <= spillChars) return full.join('\n\n');
  return rules.map((rule) => ruleAttachment({ path: rule.path, text: `This rule applies to ${file}. Read ${rule.path} for it.` }, file)).join('\n\n');
}

/** `read`, with the rules a file matches appended to the first read of it. Spill files match no rule. */
export function withRuleAttachments(read: Executor, rules: RuleAttacher): Executor {
  return {
    ...read,
    async run(raw, ctx) {
      const reply = await read.run(raw, ctx);
      // Text, bare or stamped with what the model now knows of the file; a reply that is more than that keeps its shape.
      const text = typeof reply === 'string' ? reply : reply.file === undefined ? undefined : reply.text;
      if (text === undefined) return reply;
      const file = displayPath(ctx, await resolveInside(ctx, (raw as { path: string }).path));
      if (path.isAbsolute(file)) return reply;
      await ctx.earlierCalls();
      const fresh = rules.take(file);
      if (fresh.length === 0) return reply;
      const attached = `${text}\n\n${attachments(text, fresh, file, ctx.spillChars)}`;
      return typeof reply === 'string' ? attached : { ...reply, text: attached };
    },
  };
}
