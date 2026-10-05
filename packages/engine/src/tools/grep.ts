import { z } from 'zod';
import { executor, optional } from './context.js';
import { searchWorkspace } from './ripgrep.js';

export const grep = executor({
  input: z.strictObject({
    pattern: z.string().min(1),
    path: optional(z.string().min(1)),
    ignore_case: optional(z.boolean()),
  }),
  describe: ({ pattern, path, ignore_case }) =>
    [`grep ${JSON.stringify(pattern)}`, ...(path === undefined ? [] : [path]), ...(ignore_case ? ['-i'] : [])].join(' '),
  async run({ pattern, path, ignore_case }, ctx) {
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
    ], 'matches');
    return lines.length === 0 ? 'no matches' : lines.join('\n');
  },
});
