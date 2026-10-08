import { z } from 'zod';
import { isSecretPath } from '@g-code/core';
import path from 'node:path';
import { ALWAYS, executor, optional, pathRuleRefusal, searchRule, secretRefusal, ToolError } from './context.js';
import { searchRoot, searchWorkspace } from './ripgrep.js';

export const glob = executor({
  concurrent: ALWAYS,
  input: z.strictObject({ pattern: z.string().min(1), directory: optional(z.string().min(1)) }),
  describe: ({ pattern, directory }) => [`glob ${JSON.stringify(pattern)}`, ...(directory === undefined ? [] : [directory])].join(' '),
  async run({ pattern, directory }, ctx) {
    if (isSecretPath(pattern)) throw new ToolError(secretRefusal('glob', pattern));
    const named = searchRule(ctx, path.resolve(ctx.workspace, pattern));
    if (named !== undefined) throw new ToolError(pathRuleRefusal('glob', pattern, named));
    const dir = await searchRoot(ctx, directory);
    const { lines } = await searchWorkspace(ctx, ['--files', '--sort=path', '--glob', pattern], 'files', { dir });
    return lines.length === 0 ? 'no files match' : lines.join('\n');
  },
});
