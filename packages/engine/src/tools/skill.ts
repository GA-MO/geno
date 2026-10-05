import path from 'node:path';
import { z } from 'zod';
import type { SlashCommand } from '@g-code/core';
import { parseFrontmatter } from '../project-context.js';
import { ALWAYS, executor, ToolError, type Executor } from './context.js';

/**
 * The `skill` tool: a skill's SKILL.md by name, from the same discovery as the slash commands, so a plugin skill
 * hidden from the slash list still loads. `commands` is read on each call, as the folders are now.
 */
export function skillExecutor(commands: () => Promise<readonly SlashCommand[]>): Executor {
  return executor({
    concurrent: ALWAYS,
    input: z.strictObject({ name: z.string().min(1) }),
    describe: ({ name }) => `skill ${name}`,
    async run({ name }) {
      const skills = (await commands()).filter((c) => c.kind === 'skill');
      const skill = skills.find((c) => c.name === name);
      if (skill === undefined) {
        throw new ToolError(`no skill named ${name}; ${skills.length === 0 ? 'there are no skills' : `the skills are ${skills.map((c) => c.name).join(', ')}`}`);
      }
      const folder = path.dirname(skill.path);
      return `Skill ${name}, from ${skill.path}. Resolve relative paths in it against ${folder}.\n\n${parseFrontmatter(skill.text).body}`;
    },
  });
}
