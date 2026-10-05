import { z } from 'zod';
import { executor, optional } from './context.js';
import { searchRoot, searchWorkspace } from './ripgrep.js';

export const glob = executor({
  input: z.strictObject({ pattern: z.string().min(1), directory: optional(z.string().min(1)) }),
  describe: ({ pattern, directory }) => [`glob ${JSON.stringify(pattern)}`, ...(directory === undefined ? [] : [directory])].join(' '),
  async run({ pattern, directory }, ctx) {
    const dir = await searchRoot(ctx, directory);
    const files = await searchWorkspace(ctx, ['--files', '--sort=path', '--glob', pattern], 'files', dir);
    return files.length === 0 ? 'no files match' : files.join('\n');
  },
});
