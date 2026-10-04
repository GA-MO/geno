import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ToolError, type ToolContext } from './context.js';

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
