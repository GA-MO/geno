import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { isMissing } from '../store.js';
import { isSecretPath } from '@g-code/core';
import { ALWAYS, displayPath, executor, isSecret, optional, pathRuleRefusal, resolveInside, searchRule, secretRefusal, ToolError, type ToolContext } from './context.js';
import { searchWorkspace, type SearchTarget } from './ripgrep.js';

const GLOB_CHARS = /[*?[\]{}]/;

const exists = (file: string): Promise<boolean> =>
  stat(file).then(
    () => true,
    (error: unknown) => (isMissing(error) ? false : Promise.reject(error)),
  );

/**
 * What `path` names: a directory or a file to search. A glob that names nothing on disk filters the workspace instead,
 * as `path` did before `glob` existed, so a model that learned that form still finds what it asked for.
 */
async function scopeOf(ctx: ToolContext, given: string | undefined): Promise<{ readonly target: SearchTarget; readonly pathGlob?: string }> {
  if (given === undefined) return { target: { dir: ctx.workspace } };
  if (GLOB_CHARS.test(given) && !(await exists(path.resolve(ctx.workspace, given)))) {
    if (isSecretPath(given)) throw new ToolError(secretRefusal('grep', given));
    return { target: { dir: ctx.workspace }, pathGlob: given };
  }
  const real = await resolveInside(ctx, given);
  if (isSecret(ctx, path.resolve(ctx.workspace, given)) || isSecret(ctx, real)) throw new ToolError(secretRefusal('grep', given));
  const named = searchRule(ctx, path.resolve(ctx.workspace, given)) ?? searchRule(ctx, real);
  if (named !== undefined) throw new ToolError(pathRuleRefusal('grep', given, named));
  return { target: (await stat(real)).isDirectory() ? { dir: real } : { dir: path.dirname(real), file: path.basename(real) } };
}

export const grep = executor({
  concurrent: ALWAYS,
  input: z.strictObject({
    pattern: z.string().min(1),
    path: optional(z.string().min(1)),
    glob: optional(z.string().min(1)),
    ignore_case: optional(z.boolean()),
  }),
  describe: ({ pattern, path, glob, ignore_case }) =>
    [`grep ${JSON.stringify(pattern)}`, ...(path === undefined ? [] : [path]), ...(glob === undefined ? [] : [glob]), ...(ignore_case ? ['-i'] : [])].join(' '),
  async run({ pattern, path: given, glob, ignore_case }, ctx) {
    if (glob !== undefined && isSecretPath(glob)) throw new ToolError(secretRefusal('grep', glob));
    const { target, pathGlob } = await scopeOf(ctx, given);
    const globs = [pathGlob, glob].filter((g) => g !== undefined);
    const { lines, searched } = await searchWorkspace(
      ctx,
      [
        '--line-number',
        '--no-heading',
        '--color=never',
        '--sort=path',
        // Minified files would otherwise flood the result with one enormous line.
        '--max-columns=400',
        '--max-columns-preview',
        ...(ignore_case ? ['--ignore-case'] : []),
        ...globs.flatMap((g) => ['--glob', g]),
        '--regexp',
        pattern,
      ],
      'matches',
      target,
    );
    if (searched === 0) {
      const shown = displayPath(ctx, target.dir);
      const where = shown === '.' ? 'the workspace' : shown;
      const why = globs.length === 0 ? 'it holds no file, or .gitignore excludes them all' : `no file there that .gitignore lets through matches ${globs.join(' or ')}`;
      throw new ToolError(`grep searched no files in ${where}: ${why}. That is not the same as no matches. Name a directory or a file in path, and use glob only to narrow it.`);
    }
    return lines.length === 0 ? 'no matches' : lines.join('\n');
  },
});
