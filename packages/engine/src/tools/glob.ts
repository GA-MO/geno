import { z } from 'zod';
import { executor } from './context.js';
import { searchWorkspace } from './ripgrep.js';

export const glob = executor({
  input: z.strictObject({ pattern: z.string().min(1) }),
  describe: ({ pattern }) => `glob ${JSON.stringify(pattern)}`,
  async run({ pattern }, ctx) {
    const files = await searchWorkspace(ctx, ['--files', '--sort=path', '--glob', pattern], 'files');
    return files.length === 0 ? 'no files match' : files.join('\n');
  },
});
