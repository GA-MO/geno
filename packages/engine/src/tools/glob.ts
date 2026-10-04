import { z } from 'zod';
import { executor } from './context.js';
import { ripgrep } from './ripgrep.js';

export const glob = executor({
  input: z.strictObject({ pattern: z.string().min(1) }),
  describe: ({ pattern }) => `glob ${JSON.stringify(pattern)}`,
  async run({ pattern }, ctx) {
    const files = await ripgrep(ctx, ctx.workspace, ['--files', '--sort=path', '--glob', pattern]);
    return files.length === 0 ? 'no files match' : files.join('\n');
  },
});
