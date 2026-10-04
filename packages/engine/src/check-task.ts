import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { EvalTask } from '@g-code/core';
import { EngineError } from './errors.js';
import { applyPatch, cloneAt, resetWorktree } from './git.js';

export type CheckOptions = {
  readonly taskDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly verbose: boolean;
  readonly keep: boolean;
  log(line: string): void;
};

type Workspace = {
  readonly task: EvalTask;
  readonly taskDir: string;
  readonly clone: string;
  readonly patch: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly verbose: boolean;
};

type StepOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly output: string };

const STEP_NAMES = ['patch', 'clone', 'setup', 'verify-base', 'reset', 'apply', 'verify-patched'] as const;
type StepName = (typeof STEP_NAMES)[number];

export type CheckVerdict = { readonly valid: true } | { readonly valid: false; readonly reason: string };

export type CheckReport = {
  readonly verdict: CheckVerdict;
  readonly ms: number;
};

const OK: StepOutcome = { ok: true };
const invalid = (reason: string, output = ''): StepOutcome => ({ ok: false, reason, output });

const OUTPUT_TAIL_CHARS = 64 * 1024;
const TAIL_LINES = 20;

function shell(command: string, ws: Workspace): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], {
      cwd: ws.clone,
      env: { ...ws.env, GCODE_TASK_DIR: ws.taskDir },
      stdio: ws.verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL_CHARS);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

const EXIT_EXPECTATIONS = {
  zero: (code: number) => code === 0,
  'non-zero': (code: number) => code !== 0,
} as const;

const expectExit =
  (command: (task: EvalTask) => string, expected: keyof typeof EXIT_EXPECTATIONS, reason: string) =>
  async (ws: Workspace): Promise<StepOutcome> => {
    const { code, output } = await shell(command(ws.task), ws);
    return EXIT_EXPECTATIONS[expected](code) ? OK : invalid(`${reason} (exit ${code})`, output);
  };

const attempt =
  (action: (ws: Workspace) => Promise<void>, reason: string) =>
  async (ws: Workspace): Promise<StepOutcome> => {
    try {
      await action(ws);
      return OK;
    } catch (error) {
      if (error instanceof EngineError) return invalid(`${reason}: ${error.message}`);
      throw error;
    }
  };

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

const STEPS: Readonly<Record<StepName, (ws: Workspace) => Promise<StepOutcome>>> = {
  patch: async (ws) => ((await exists(ws.patch)) ? OK : invalid(`no reference patch at ${ws.patch}`)),
  clone: attempt((ws) => cloneAt(ws.task.repo, ws.clone, ws.task.baseCommit), 'clone failed'),
  setup: expectExit((task) => task.setup, 'zero', 'setup failed'),
  'verify-base': expectExit((task) => task.verify, 'non-zero', 'verify passes before any change'),
  reset: attempt((ws) => resetWorktree(ws.clone), 'reset failed'),
  apply: attempt((ws) => applyPatch(ws.clone, ws.patch), 'reference patch does not apply'),
  'verify-patched': expectExit((task) => task.verify, 'zero', 'verify fails after the reference patch'),
};

const tailOf = (output: string): string[] =>
  output.trim() === '' ? [] : output.trimEnd().split('\n').slice(-TAIL_LINES);

export const formatSeconds = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

export async function checkTask(task: EvalTask, options: CheckOptions): Promise<CheckReport> {
  const started = performance.now();
  const base = await mkdtemp(path.join(tmpdir(), 'gcode-check-'));
  const ws: Workspace = {
    task,
    taskDir: options.taskDir,
    clone: path.join(base, path.basename(task.repo)),
    patch: path.join(options.taskDir, 'reference.patch'),
    env: options.env,
    verbose: options.verbose,
  };
  options.log(`task: ${task.id}`);
  options.log(`clone: ${ws.clone}`);
  let verdict: CheckVerdict = { valid: true };
  try {
    for (const name of STEP_NAMES) {
      const stepStarted = performance.now();
      const outcome = await STEPS[name](ws);
      const took = formatSeconds(performance.now() - stepStarted);
      options.log(`  ${name.padEnd(15)} ${outcome.ok ? 'ok' : 'invalid'}  ${took}`);
      if (!outcome.ok) {
        for (const line of tailOf(outcome.output)) options.log(`    | ${line}`);
        verdict = { valid: false, reason: outcome.reason };
        break;
      }
    }
  } finally {
    if (options.keep) options.log(`kept clone: ${ws.clone}`);
    else await rm(base, { recursive: true, force: true });
  }
  options.log(verdict.valid ? 'valid' : `invalid: ${verdict.reason}`);
  return { verdict, ms: performance.now() - started };
}
