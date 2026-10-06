import { stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { diffBases, type DiffBase, type EditorAction, type EditorActionTool } from '@g-code/core';
import { fileAt, type ShadowRepo } from '../checkpoints.js';
import { displayPath, executor, resolveInside, ToolError, type Executor, type ToolContext } from './context.js';

/** Carries out an action in the editor that shows the session; rejects when no editor shows it. */
export type Editor = (action: EditorAction) => Promise<void>;

const position = z.number().int().positive();
const diffBaseSchema = z.strictObject({ sha: z.string().min(1), since: z.enum(['turn', 'session']) });

/** An EditorAction as the session log holds it. */
export const editorActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('open'), path: z.string().min(1), line: position.optional(), column: position.optional() }),
  z.strictObject({ kind: z.literal('diff'), path: z.string().min(1), base: diffBaseSchema }),
  z.strictObject({ kind: z.literal('reveal'), path: z.string().min(1) }),
]);

const pathInput = z.strictObject({ path: z.string().min(1) });
const openInput = z.strictObject({ path: z.string().min(1), line: position.optional(), column: position.optional() });

const inWorkspace = (ctx: ToolContext, real: string): boolean => {
  const relative = path.relative(ctx.workspace, real);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
};

async function aFile(ctx: ToolContext, raw: string, tool: EditorActionTool): Promise<string> {
  const real = await resolveInside(ctx, raw);
  if ((await stat(real)).isDirectory()) throw new ToolError(`${raw} is a folder; ${tool} takes a file. Use reveal to show a folder.`);
  return real;
}

/**
 * The left side of a file's diff: the checkpoint before this turn when the turn changed the file, else the session's
 * first. Comparing text, not the turn's edits, counts what its commands changed too.
 */
async function baseOf(ctx: ToolContext, repo: ShadowRepo, real: string): Promise<DiffBase> {
  const { turn, session } = diffBases(ctx.events());
  if (turn === undefined || session === undefined) throw new ToolError('this session has no checkpoint to diff against yet');
  const now = await ctx.files.read(real);
  const before = await fileAt(repo, turn.sha, path.relative(ctx.workspace, real));
  return before !== now ? { sha: turn.sha, since: 'turn' } : { sha: session.sha, since: 'session' };
}

const at = (file: string, line: number | undefined, column: number | undefined): string =>
  `${file}${line === undefined ? '' : `:${line}${column === undefined ? '' : `:${column}`}`}`;

/** open_file, reveal and show_diff, which reach the editor through `editor` and read checkpoints from `repo`. */
export function editorActionExecutors(editor: Editor, repo: ShadowRepo): Readonly<Record<EditorActionTool, Executor>> {
  return {
    open_file: executor({
      input: openInput,
      describe: ({ path: file, line, column }) => `open_file ${at(file, line, column)}`,
      async run({ path: raw, line, column }, ctx) {
        const real = await aFile(ctx, raw, 'open_file');
        const action: EditorAction = { kind: 'open', path: real, ...(line === undefined ? {} : { line }), ...(line === undefined || column === undefined ? {} : { column }) };
        await editor(action);
        return { text: `Opened ${at(displayPath(ctx, real), line, column)} in the user's editor.`, editorAction: action };
      },
    }),
    reveal: executor({
      input: pathInput,
      describe: ({ path: file }) => `reveal ${file}`,
      async run({ path: raw }, ctx) {
        const real = await resolveInside(ctx, raw);
        if (!inWorkspace(ctx, real)) throw new ToolError(`${raw} is outside the workspace folder, so the Explorer cannot show it`);
        const action: EditorAction = { kind: 'reveal', path: real };
        await editor(action);
        return { text: `Selected ${displayPath(ctx, real)} in the user's Explorer.`, editorAction: action };
      },
    }),
    show_diff: executor({
      input: pathInput,
      describe: ({ path: file }) => `show_diff ${file}`,
      async run({ path: raw }, ctx) {
        const real = await aFile(ctx, raw, 'show_diff');
        if (!inWorkspace(ctx, real)) throw new ToolError(`${raw} is outside the workspace, which is all a checkpoint holds`);
        const base = await baseOf(ctx, repo, real);
        const action: EditorAction = { kind: 'diff', path: real, base };
        await editor(action);
        const since = base.since === 'turn' ? 'before this turn' : 'when the session began, since this turn did not change it';
        return { text: `Showed the user the diff of ${displayPath(ctx, real)} against the file ${since}.`, editorAction: action };
      },
    }),
  };
}
