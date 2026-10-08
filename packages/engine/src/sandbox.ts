import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { ENGINE_ENV_FILE } from './child-env.js';
import { EngineError } from './errors.js';
import { runShell, spawnShell, type ShellOptions, type ShellResult, type SpawnedShell, type SpawnOptions } from './process.js';
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

/** `writable` lets this one command also write there, as the check writes its build info outside the workspace. */
export type SandboxRunOptions = ShellOptions & { readonly writable?: readonly string[] };

export type Sandbox = {
  run(command: string, options: SandboxRunOptions): Promise<ShellResult>;
  /** Starts a command under the same rules and returns while it runs, as a background command does. */
  spawn(command: string, options: SpawnOptions): Promise<SpawnedShell>;
  /** `command` wrapped to run under this sandbox's rules, for a caller that spawns it itself, as the hook runner does. */
  wrap(command: string): Promise<string>;
  /** Keeps the sandbox open past `close` until the returned function runs, for a command that outlives its turn. */
  retain(): () => Promise<void>;
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
  /** More places commands may write, such as a lane's part of the git folder its main checkout shares. */
  readonly writable?: readonly string[];
};

/** Where the user's CLIs keep keys and tokens, under the home folder. Auto lets the classifier judge reads outside the workspace, so these stay unreadable whatever it says. */
export const CREDENTIAL_PATHS = ['.ssh', '.aws', '.azure', '.config/gcloud', '.config/gh', '.docker', '.gnupg', '.kube', '.netrc'] as const;

/** Writes in the workspace and temp dir only; no reads of eval answers, keys or the repos tasks are cut from. */
export async function sandboxPolicy(input: PolicyInput): Promise<SandboxPolicy> {
  const repos = (await readTasks(input.store)).map((task) => task.repo);
  return {
    writable: await withRealPaths([input.workspace, input.tempDir, ...(input.writable ?? [])]),
    denyRead: await withRealPaths([
      input.store.evalsDir,
      ...CREDENTIAL_PATHS.map((p) => path.join(input.home, p)),
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
      // Loopback only, so a dev server started in the background can be reached with curl; the allowlist still holds for every other host.
      network: { allowedDomains: [...policy.allowedDomains], deniedDomains: [], allowLocalBinding: true },
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

/** More places closed to every command, read before each one, such as what the workspace's deny path rules name. */
export type PathDenials = () => Promise<{ readonly denyRead: readonly string[]; readonly denyWrite: readonly string[] }>;

export async function openSandbox(policy: SandboxPolicy, denials?: PathDenials): Promise<Sandbox> {
  if (!SandboxManager.isSupportedPlatform()) {
    throw new EngineError(`sandbox-runtime does not support ${process.platform}, so commands cannot run`);
  }
  const runtime = await join(policy);
  const base = { denyRead: [...policy.denyRead], allowRead: [...policy.readable], allowWrite: [...policy.writable], denyWrite: [] as string[] };
  const rules = async () => {
    if (denials === undefined) return base;
    const { denyRead, denyWrite } = await denials();
    return { ...base, denyRead: [...base.denyRead, ...denyRead], denyWrite: [...denyWrite] };
  };
  // The opener's hold and one per retained command; the runtime is left once all have let go.
  let holds = 1;
  const release = async () => {
    if (--holds === 0) await leave(runtime);
  };
  let open = true;
  return {
    run: async (command, options) => {
      const filesystem = await rules();
      const allowWrite = options.writable === undefined ? filesystem.allowWrite : [...filesystem.allowWrite, ...options.writable];
      return runShell(await SandboxManager.wrapWithSandbox(command, undefined, { filesystem: { ...filesystem, allowWrite } }), options);
    },
    spawn: async (command, options) => spawnShell(await SandboxManager.wrapWithSandbox(command, undefined, { filesystem: await rules() }), options),
    wrap: async (command) => SandboxManager.wrapWithSandbox(command, undefined, { filesystem: await rules() }),
    retain() {
      holds++;
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await release();
      };
    },
    async close() {
      if (!open) return;
      open = false;
      await release();
    },
  };
}
