import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { isSecretPath } from '@g-code/core';
import { displayPath, isSecret, resolveInside, secretRefusal, ToolError, type ToolContext } from './context.js';

const execFileAsync = promisify(execFile);

type ExecFailure = Error & { code?: number | string; stdout?: string; stderr?: string };

// ripgrep exits 1 when nothing matched, which is an answer, not a failure.
const NO_MATCH = 1;

/** Runs ripgrep over `target` (a path relative to `cwd`) and returns what it printed. */
async function ripgrepOutput(ctx: ToolContext, cwd: string, args: readonly string[], target: string): Promise<string> {
  try {
    // Config such as .github/ lives in hidden directories, so those are searched; .git is never useful.
    // An explicit path stops ripgrep from searching stdin when stdin is not a terminal.
    const { stdout } = await execFileAsync(ctx.rg, ['--hidden', '--glob', '!.git', ...args, '--', target], {
      cwd,
      signal: ctx.signal,
      maxBuffer: 256 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const { code, stdout, stderr } = error as ExecFailure;
    if (code === 'ENOENT') {
      throw new ToolError(`ripgrep (${ctx.rg}) is not installed or not on PATH; install ripgrep or set GCODE_RG to its path`);
    }
    if (code === NO_MATCH) return stdout ?? '';
    if (typeof code === 'number') throw new ToolError(`ripgrep failed: ${stderr?.trim() || `exit code ${code}`}`);
    throw error;
  }
}

const linesOf = (stdout: string): string[] =>
  stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => (line.startsWith('./') ? line.slice(2) : line));

/** Runs ripgrep over `.` in `cwd` and returns its output lines, with the `./` prefix dropped. */
export async function ripgrep(ctx: ToolContext, cwd: string, args: readonly string[]): Promise<string[]> {
  return linesOf(await ripgrepOutput(ctx, cwd, args, '.'));
}

const escapeGlob = (text: string): string => text.replace(/[\\*?[\]{}!]/g, '\\$&');

/** ripgrep's --sort=path order: directory by directory, by name. */
export function comparePaths(a: string, b: string): number {
  const left = a.split('/');
  const right = b.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  }
  return left.length - right.length;
}

/** What a search covers: a real directory, or one file in it. */
export type SearchTarget = { readonly dir: string; readonly file?: string | undefined };

/** The real directory a search covers: the workspace, or a directory in any readable root. */
export async function searchRoot(ctx: ToolContext, directory: string | undefined): Promise<string> {
  if (directory === undefined) return ctx.workspace;
  const real = await resolveInside(ctx, directory);
  if (isSecret(ctx, path.resolve(ctx.workspace, directory)) || isSecret(ctx, real)) throw new ToolError(secretRefusal('glob', directory));
  if (!(await stat(real)).isDirectory()) throw new ToolError(`${directory} is not a directory`);
  return real;
}

/** `files` lines are paths; `matches` lines are path:line:text. */
export type SearchOutput = 'files' | 'matches';

/** The lines found, and how many files ripgrep looked at, so that searching nothing is not mistaken for no matches. */
export type Search = { readonly lines: readonly string[]; readonly searched: number };

// --stats ends the output with a blank line, then "N matches", ..., "N files searched", ...; no match line is blank.
const STATS = /(?:^|\n)\n\d+ matches\n/;
const SEARCHED = /^(\d+) files searched$/m;

/**
 * ripgrep over `target`, from searchRoot or a file in it, as the editor shows it: each buffer with unsaved edits
 * is searched in place of its file on disk, from a copy at the same relative path in a scratch directory. Returns
 * lines as ripgrep prints them with --sort=path, each path shown as displayPath shows it. A buffer of a file
 * .gitignore excludes is searched all the same, since the user has it open.
 */
export async function searchWorkspace(ctx: ToolContext, args: readonly string[], output: SearchOutput, target: SearchTarget): Promise<Search> {
  const shownDir = displayPath(ctx, target.dir);
  const prefix = shownDir === '.' ? '' : `${shownDir}/`;
  const { lines, searched } = await searchDir(ctx, target, args, output);
  return { lines: lines.map((line) => prefix + line), searched };
}

async function searchDir(ctx: ToolContext, { dir, file }: SearchTarget, args: readonly string[], output: SearchOutput): Promise<Search> {
  const buffers = (await ctx.files.unsaved()).flatMap(({ path: buffer, text }) => {
    const relative = path.relative(dir, buffer);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return [];
    const shown = relative.split(path.sep).join('/');
    return file === undefined || shown === file ? [{ relative: shown, text }] : [];
  });
  // NUL after the path keeps a path with a colon in it apart from its line number. A single file is still named.
  const flags = output === 'matches' ? ['--null', '--with-filename', '--stats'] : [];
  const pathOf = (line: string): string => (output === 'matches' ? line.slice(0, line.indexOf('\0')) : line);
  // The callers refuse a credentials directory or file, so a path below `dir` is all that can name a credentials file.
  const shown = (lines: readonly string[]): string[] => lines.filter((line) => !isSecretPath(pathOf(line))).map((line) => line.replace('\0', ':'));
  const run = async (cwd: string, extra: readonly string[]): Promise<Search> => {
    const stdout = await ripgrepOutput(ctx, cwd, [...flags, ...args, ...extra], file ?? '.');
    if (output === 'files') {
      const lines = linesOf(stdout);
      return { lines, searched: lines.length };
    }
    const stats = STATS.exec(stdout);
    if (stats === null) throw new ToolError('ripgrep printed no statistics');
    return { lines: linesOf(stdout.slice(0, stats.index)), searched: Number(SEARCHED.exec(stdout.slice(stats.index))?.[1] ?? 0) };
  };
  if (buffers.length === 0) {
    const { lines, searched } = await run(dir, []);
    return { lines: shown(lines), searched };
  }

  const overlay = await mkdtemp(path.join(tmpdir(), 'gcode-unsaved-'));
  try {
    for (const { relative, text } of buffers) {
      await mkdir(path.dirname(path.join(overlay, relative)), { recursive: true });
      await writeFile(path.join(overlay, relative), text);
    }
    // Later globs win in ripgrep, so these exclusions hold whatever glob the caller passed. A named file with a buffer is read only from it.
    const onDisk = buffers.flatMap(({ relative }) => ['--glob', `!/${escapeGlob(relative)}`]);
    const [disk, open] = await Promise.all([file === undefined ? run(dir, onDisk) : { lines: [], searched: 0 }, run(overlay, [])]);
    // A stable sort keeps each file's lines in their order.
    const lines = shown([...disk.lines, ...open.lines].toSorted((a, b) => comparePaths(pathOf(a), pathOf(b))));
    return { lines, searched: disk.searched + open.searched };
  } finally {
    await rm(overlay, { recursive: true, force: true });
  }
}
