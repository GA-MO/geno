import { spawn } from 'node:child_process';

export type ShellOptions = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** Called with each stdout chunk as it arrives. */
  readonly onStdout?: (chunk: string) => void;
};

export type ShellResult = {
  /** Null when the command was killed. */
  readonly code: number | null;
  /** Interleaved stdout and stderr, cut to the last OUTPUT_LIMIT characters. */
  readonly output: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
};

export const OUTPUT_LIMIT = 4 * 1024 * 1024;

/**
 * Runs `command` with sh in its own process group, so a timeout or abort kills everything it started,
 * including the process tree under a sandbox wrapper.
 */
export function runShell(command: string, options: ShellOptions): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let output = '';
    let truncated = false;
    let timedOut = false;
    const collect = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > OUTPUT_LIMIT) {
        output = output.slice(-OUTPUT_LIMIT);
        truncated = true;
      }
    };
    const kill = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // The group is already gone.
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      collect(chunk);
      options.onStdout?.(chunk.toString('utf8'));
    });
    child.stderr.on('data', collect);
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            kill();
          }, options.timeoutMs);
    const { signal } = options;
    if (signal?.aborted) kill();
    else signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolve({ code, output, timedOut, truncated });
    });
  });
}

/** The last `lines` lines of `output`, at most `chars` characters. */
export function tail(output: string, lines = 40, chars = 4000): string {
  const kept = output.trimEnd().split('\n').slice(-lines).join('\n');
  return kept.length > chars ? kept.slice(-chars) : kept;
}
