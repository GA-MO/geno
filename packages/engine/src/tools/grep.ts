import { z } from 'zod';
import { ALWAYS, executor, optional } from './context.js';
import { searchRoot, searchWorkspace } from './ripgrep.js';

export const grep = executor({
  concurrent: ALWAYS,
  input: z.strictObject({
    pattern: z.string().min(1),
    path: optional(z.string().min(1)),
    ignore_case: optional(z.boolean()),
    directory: optional(z.string().min(1)),
  }),
  describe: ({ pattern, path, ignore_case, directory }) =>
    [`grep ${JSON.stringify(pattern)}`, ...(directory === undefined ? [] : [directory]), ...(path === undefined ? [] : [path]), ...(ignore_case ? ['-i'] : [])].join(' '),
  async run({ pattern, path, ignore_case, directory }, ctx) {
    const dir = await searchRoot(ctx, directory);
    const lines = await searchWorkspace(ctx, [
      '--line-number',
      '--no-heading',
      '--color=never',
      '--sort=path',
      // Minified files would otherwise flood the result with one enormous line.
      '--max-columns=400',
      '--max-columns-preview',
      ...(ignore_case ? ['--ignore-case'] : []),
      ...(path === undefined ? [] : ['--glob', path]),
      '--regexp',
      pattern,
    ], 'matches', dir);
    return lines.length === 0 ? 'no matches' : lines.join('\n');
  },
});
