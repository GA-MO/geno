import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { displayPath, resolveInside, ToolError, type ToolContext } from './context.js';

const execFileAsync = promisify(execFile);

type ExecFailure = Error & { code?: number | string; stderr?: string };

// ripgrep exits 1 when nothing matched, which is an answer, not a failure.
const NO_MATCH = 1;

/** Runs ripgrep over `.` in `cwd` and returns its output lines, with the `./` prefix dropped. */
export async function ripgrep(ctx: ToolContext, cwd: string, args: readonly string[]): Promise<string[]> {
  let stdout: string;
  try {
    // Config such as .github/ lives in hidden directories, so those are searched; .git is never useful.
    // An explicit path stops ripgrep from searching stdin when stdin is not a terminal.
    ({ stdout } = await execFileAsync(ctx.rg, ['--hidden', '--glob', '!.git', ...args, '--', '.'], {
      cwd,
      signal: ctx.signal,
      maxBuffer: 256 * 1024 * 1024,
    }));
  } catch (error) {
    const { code, stderr } = error as ExecFailure;
    if (code === 'ENOENT') {
      throw new ToolError(`ripgrep (${ctx.rg}) is not installed or not on PATH; install ripgrep or set GCODE_RG to its path`);
    }
    if (code === NO_MATCH) return [];
    if (typeof code === 'number') throw new ToolError(`ripgrep failed: ${stderr?.trim() || `exit code ${code}`}`);
    throw error;
  }
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => (line.startsWith('./') ? line.slice(2) : line));
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

/** The real directory a search covers: the workspace, or a directory in any readable root. */
export async function searchRoot(ctx: ToolContext, directory: string | undefined): Promise<string> {
  if (directory === undefined) return ctx.workspace;
  const real = await resolveInside(ctx, directory);
  if (!(await stat(real)).isDirectory()) throw new ToolError(`${directory} is not a directory`);
  return real;
}

/** `files` lines are paths; `matches` lines are path:line:text. */
export type SearchOutput = 'files' | 'matches';

/**
 * ripgrep over `dir`, a real path from searchRoot, as the editor shows it: each buffer with unsaved edits
 * is searched in place of its file on disk, from a copy at the same relative path in a scratch directory. Returns
 * lines as ripgrep prints them with --sort=path, each path shown as displayPath shows it. A buffer of a file
 * .gitignore excludes is searched all the same, since the user has it open.
 */
export async function searchWorkspace(ctx: ToolContext, args: readonly string[], output: SearchOutput, dir: string): Promise<string[]> {
  const shownDir = displayPath(ctx, dir);
  const prefix = shownDir === '.' ? '' : `${shownDir}/`;
  return (await searchDir(ctx, dir, args, output)).map((line) => prefix + line);
}

async function searchDir(ctx: ToolContext, dir: string, args: readonly string[], output: SearchOutput): Promise<string[]> {
  const buffers = (await ctx.files.unsaved()).flatMap(({ path: file, text }) => {
    const relative = path.relative(dir, file);
    return relative === '' || relative.startsWith('..') || path.isAbsolute(relative) ? [] : [{ relative: relative.split(path.sep).join('/'), text }];
  });
  // NUL after the path keeps a path with a colon in it apart from its line number.
  const flags = output === 'matches' ? ['--null'] : [];
  const pathOf = (line: string): string => (output === 'matches' ? line.slice(0, line.indexOf('\0')) : line);
  const shown = (line: string): string => line.replace('\0', ':');
  if (buffers.length === 0) return (await ripgrep(ctx, dir, [...flags, ...args])).map(shown);

  const overlay = await mkdtemp(path.join(tmpdir(), 'gcode-unsaved-'));
  try {
    for (const { relative, text } of buffers) {
      await mkdir(path.dirname(path.join(overlay, relative)), { recursive: true });
      await writeFile(path.join(overlay, relative), text);
    }
    // Later globs win in ripgrep, so these exclusions hold whatever glob the caller passed.
    const onDisk = buffers.flatMap(({ relative }) => ['--glob', `!/${escapeGlob(relative)}`]);
    const [disk, open] = await Promise.all([
      ripgrep(ctx, dir, [...flags, ...args, ...onDisk]),
      ripgrep(ctx, overlay, [...flags, ...args]),
    ]);
    // A stable sort keeps each file's lines in their order.
    return [...disk, ...open].toSorted((a, b) => comparePaths(pathOf(a), pathOf(b))).map(shown);
  } finally {
    await rm(overlay, { recursive: true, force: true });
  }
}
