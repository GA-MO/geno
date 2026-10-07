import { spawn } from 'node:child_process';

export type ShellOptions = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
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

/** The process groups of the commands runShell runs now, which an engine on its way out kills. */
const running = new Set<number>();

/** Kills every command runShell runs now, with all it started. */
export function killShells(): void {
  for (const group of running) {
    try {
      process.kill(-group, 'SIGKILL');
    } catch {
      // The group is already gone.
    }
  }
}

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
    if (child.pid !== undefined) running.add(child.pid);
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
      if (child.pid !== undefined) running.delete(child.pid);
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
      resolve({ code, output, timedOut, truncated });
    });
  });
}

export function tail(output: string, lines = 40, chars = 4000): string {
  const kept = output.trimEnd().split('\n').slice(-lines).join('\n');
  return kept.length > chars ? kept.slice(-chars) : kept;
}

export type SpawnOptions = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Stdout and stderr as they arrive, interleaved. */
  readonly onOutput: (chunk: Buffer) => void;
};

/** A command left running: its process group, how it ended once it has, and a way to signal the whole group. */
export type SpawnedShell = {
  readonly pid: number;
  readonly exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  /** Sends `signal` to the group; false once the group is gone. */
  signal(signal: NodeJS.Signals): boolean;
};

/** Starts `command` with sh in its own process group, as runShell does, and returns without waiting for it. */
export function spawnShell(command: string, options: SpawnOptions): Promise<SpawnedShell> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    child.stdout.on('data', options.onOutput);
    child.stderr.on('data', options.onOutput);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => child.on('close', (code, signal) => done({ code, signal })));
    child.once('error', reject);
    child.once('spawn', () => {
      const pid = child.pid!;
      resolve({
        pid,
        exited,
        signal(signal) {
          try {
            process.kill(-pid, signal);
            return true;
          } catch {
            return false;
          }
        },
      });
    });
  });
}
