import path from 'node:path';
import { z } from 'zod';
import type { SlashCommand, TurnEvent } from '@g-code/core';
import { parseFrontmatter } from '../project-context.js';
import { ALWAYS, executor, ToolError, type Executor, type ToolContext, type ToolReply } from './context.js';

/** Starts a subagent on a task and settles with its report, as the agent tool does. */
export type StartChild = (agent: string, task: string, ctx: ToolContext) => Promise<ToolReply>;

/** Claude Code's agent types as a `context: fork` skill names them, and the Geno agent each one runs as. */
const CLAUDE_AGENTS: Readonly<Record<string, string>> = { 'general-purpose': 'worker', Explore: 'explore', Plan: 'plan' };

/** Claude Code's form: `$ARGUMENTS` in the body takes them, else they follow it. */
const withArgs = (body: string, args: string): string =>
  body.includes('$ARGUMENTS') ? body.replaceAll('$ARGUMENTS', args) : args === '' ? body : `${body.trimEnd()}\n\nARGUMENTS: ${args}`;

const typedByUser = (events: readonly TurnEvent[], name: string): boolean =>
  events.some((e) => e.kind === 'user' && e.from === undefined && e.command?.name === name);

/**
 * The `skill` tool: a skill's SKILL.md by name, from the same discovery as the slash commands and the listing, so a
 * plugin skill hidden from the slash list still loads. `commands` is read on each call, as the folders are now. With
 * `start`, a `context: fork` skill runs as a subagent; without it, as in a subagent, which starts none, it loads here.
 */
export function skillExecutor(commands: () => Promise<readonly SlashCommand[]>, start?: StartChild): Executor {
  return executor({
    // A forked skill may start a subagent that edits, which must run alone.
    ...(start === undefined ? { concurrent: ALWAYS } : {}),
    input: z.strictObject({ name: z.string().min(1), args: z.string().optional() }),
    describe: ({ name, args }) => (args === undefined ? `skill ${name}` : `skill ${name} ${args}`),
    async run({ name, args }, ctx) {
      const skills = (await commands()).filter((c) => c.kind === 'skill');
      const skill = skills.find((c) => c.name === name);
      if (skill !== undefined && !skill.modelInvocable && !typedByUser(ctx.events(), name)) {
        throw new ToolError(`only the user runs ${name}, as /${name}: its frontmatter sets disable-model-invocation. If the task needs it, ask the user to type /${name}.`);
      }
      if (skill === undefined) {
        const names = skills.filter((c) => c.modelInvocable).map((c) => c.name);
        throw new ToolError(`no skill named ${name}; ${names.length === 0 ? 'there are no skills' : `the skills are ${names.join(', ')}`}`);
      }
      const folder = path.dirname(skill.path);
      const text = `Skill ${name}, from ${skill.path}. Resolve relative paths in it against ${folder}.\n\n${withArgs(parseFrontmatter(skill.text).body, args ?? '')}`;
      if (skill.fork === undefined || start === undefined) return text;
      const agent = skill.fork.agent === undefined ? 'worker' : (CLAUDE_AGENTS[skill.fork.agent] ?? skill.fork.agent);
      return start(agent, text, ctx);
    },
  });
}
