import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { ENGINE_ENV_FILE } from './child-env.js';
import { EngineError } from './errors.js';
import { runShell, type ShellOptions, type ShellResult } from './process.js';
import { isMissing, readTasks, type Store } from './store.js';

export type SandboxPolicy = {
  /** The only places a command may write. */
  readonly writable: readonly string[];
  readonly denyRead: readonly string[];
  /** Re-allowed for reading inside a denied region, such as a workspace under a task's source repo. */
  readonly readable: readonly string[];
  /** Empty means no network at all. */
  readonly allowedDomains: readonly string[];
};

export type Sandbox = {
  run(command: string, options: ShellOptions): Promise<ShellResult>;
  close(): Promise<void>;
};

async function withRealPaths(paths: readonly string[]): Promise<string[]> {
  const real = await Promise.all(
    paths.map(async (p) => {
      try {
        return [p, await realpath(p)];
      } catch (error) {
        if (isMissing(error)) return [p];
        throw error;
      }
    }),
  );
  return [...new Set(real.flat())];
}

export type PolicyInput = {
  readonly store: Store;
  readonly home: string;
  readonly workspace: string;
  readonly tempDir: string;
  readonly allowedDomains?: readonly string[];
  readonly denyRead?: readonly string[];
};

/** Writes in the workspace and temp dir only; no reads of eval answers, keys or the repos tasks are cut from. */
export async function sandboxPolicy(input: PolicyInput): Promise<SandboxPolicy> {
  const repos = (await readTasks(input.store)).map((task) => task.repo);
  return {
    writable: await withRealPaths([input.workspace, input.tempDir]),
    denyRead: await withRealPaths([
      input.store.evalsDir,
      path.join(input.home, '.ssh'),
      ENGINE_ENV_FILE,
      ...repos,
      ...(input.denyRead ?? []),
    ]),
    readable: await withRealPaths([input.workspace]),
    allowedDomains: input.allowedDomains ?? [],
  };
}

/**
 * sandbox-runtime keeps one configuration and one network proxy per process, and a second `initialize` keeps the
 * first configuration. So open sandboxes share one runtime: each command carries its own sandbox's filesystem rules,
 * and the proxy enforces the one allowlist that every sharer opened with. `users` is 0 while the runtime resets.
 */
type SharedRuntime = {
  readonly allowlist: string;
  readonly ready: Promise<void>;
  readonly ended: Promise<void>;
  readonly finish: () => void;
  users: number;
};

let shared: SharedRuntime | undefined;

const allowlistOf = (policy: SandboxPolicy) => JSON.stringify([...new Set(policy.allowedDomains)].sort());

function end(runtime: SharedRuntime): void {
  if (shared === runtime) shared = undefined;
  runtime.finish();
}

function start(policy: SandboxPolicy): SharedRuntime {
  let finish!: () => void;
  const runtime: SharedRuntime = {
    allowlist: allowlistOf(policy),
    ended: new Promise((resolve) => (finish = resolve)),
    finish,
    users: 1,
    ready: SandboxManager.initialize({
      network: { allowedDomains: [...policy.allowedDomains], deniedDomains: [] },
      // Every command passes its own rules, so a command wrapped without them may write nothing.
      filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
    }),
  };
  runtime.ready.catch(() => end(runtime));
  return runtime;
}

async function join(policy: SandboxPolicy): Promise<SharedRuntime> {
  while (shared?.users === 0) await shared.ended;
  const allowlist = allowlistOf(policy);
  if (shared === undefined) shared = start(policy);
  else if (shared.allowlist !== allowlist) throw new EngineError(`a sandbox that allows the network hosts ${shared.allowlist} is open, and this one allows ${allowlist}`);
  else shared.users++;
  const runtime = shared;
  await runtime.ready;
  return runtime;
}

async function leave(runtime: SharedRuntime): Promise<void> {
  if (--runtime.users > 0) return;
  try {
    await SandboxManager.reset();
  } finally {
    end(runtime);
  }
}

export async function openSandbox(policy: SandboxPolicy): Promise<Sandbox> {
  if (!SandboxManager.isSupportedPlatform()) {
    throw new EngineError(`sandbox-runtime does not support ${process.platform}, so commands cannot run`);
  }
  const runtime = await join(policy);
  const filesystem = { denyRead: [...policy.denyRead], allowRead: [...policy.readable], allowWrite: [...policy.writable], denyWrite: [] };
  let open = true;
  return {
    run: async (command, options) => runShell(await SandboxManager.wrapWithSandbox(command, undefined, { filesystem }), options),
    async close() {
      if (!open) return;
      open = false;
      await leave(runtime);
    },
  };
}
