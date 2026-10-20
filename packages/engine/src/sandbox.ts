import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { SandboxManager, type SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { credentialPlaces, PACKAGE_HOSTS } from '@g-code/core';
import { ENGINE_ENV_FILE } from './child-env.js';
import { EngineError } from './errors.js';
import { runShell, spawnShell, stopGroup, type ShellOptions, type ShellResult, type SpawnedShell, type SpawnOptions } from './process.js';
import { isMissing, readTasks, type Store } from './store.js';

export type SandboxPolicy = {
  /** The only places a command may write. */
  readonly writable: readonly string[];
  readonly denyRead: readonly string[];
  /** Re-allowed for reading inside a denied region, such as a workspace under a task's source repo. */
  readonly readable: readonly string[];
  /** Empty means no network at all. */
  readonly allowedDomains: readonly string[];
  /** Every command's $TMPDIR: the session's scratchpad the model is told of, rather than sandbox-runtime's shared /tmp/claude. */
  readonly tempDir: string;
  /**
   * The only places a command may bind or connect to a unix socket: the workspace and the temp dir, never a system
   * socket such as Docker's or the SSH agent's. macOS only: on Linux sandbox-runtime's seccomp filter, which cannot
   * read a socket's path, refuses every unix socket.
   */
  readonly unixSockets: readonly string[];
};

/**
 * `writable` lets this one command also write there, as the check writes its build info outside the workspace.
 * `outside` runs it with none of the sandbox's rules, for a command the user approved to run outside it.
 */
export type SandboxRunOptions = ShellOptions & ({ readonly writable?: readonly string[]; readonly outside?: never } | { readonly outside: true; readonly writable?: never });

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

const shellQuote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

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

/** The variable that adds hosts to the sandbox's network, which the editor's `gcode.sandbox.allowedDomains` sets. */
export const SANDBOX_DOMAINS_ENV = 'GCODE_SANDBOX_ALLOWED_DOMAINS';
/** `off` closes the package hosts, which the editor's `gcode.sandbox.packageHosts: false` sets. */
export const SANDBOX_PACKAGE_HOSTS_ENV = 'GCODE_SANDBOX_PACKAGE_HOSTS';
const SANDBOX_DOMAIN = /^(?:\*\.)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/;

/**
 * The hosts commands may reach, as sandbox-runtime takes them (`example.com` or `*.example.com`): the package hosts
 * unless they are off, then the user's own, comma or space separated, which add to them.
 */
export function sandboxDomainsOf(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const own = (env[SANDBOX_DOMAINS_ENV] ?? '').split(/[\s,]+/).filter((domain) => SANDBOX_DOMAIN.test(domain));
  return [...new Set([...(env[SANDBOX_PACKAGE_HOSTS_ENV] === 'off' ? [] : PACKAGE_HOSTS), ...own])];
}

/**
 * Package managers keep their caches in the home folder, which commands may not write, so every command keeps them in
 * its temp dir. pnpm 11 reads `pnpm_config_*`, and earlier versions `npm_config_*`.
 */
const cacheVariables = (tempDir: string): string =>
  Object.entries({
    npm_config_cache: 'npm-cache',
    npm_config_store_dir: 'pnpm-store',
    pnpm_config_store_dir: 'pnpm-store',
    YARN_CACHE_FOLDER: 'yarn-cache',
    PIP_CACHE_DIR: 'pip-cache',
  })
    .map(([name, folder]) => `${name}=${shellQuote(path.join(tempDir, folder))}`)
    .join(' ');

/**
 * Writes in the workspace and temp dir only; no reads of eval answers, keys or the repos tasks are cut from. The
 * network reaches the hosts of the engine's own environment (`sandboxDomainsOf`): sandbox-runtime keeps one allowlist
 * per process, so every sandbox the engine opens takes the engine's.
 */
export async function sandboxPolicy(input: PolicyInput): Promise<SandboxPolicy> {
  const repos = (await readTasks(input.store)).map((task) => task.repo);
  return {
    writable: await withRealPaths([input.workspace, input.tempDir, ...(input.writable ?? [])]),
    denyRead: await withRealPaths([
      input.store.evalsDir,
      ...credentialPlaces(input.home),
      ENGINE_ENV_FILE,
      ...repos,
      ...(input.denyRead ?? []),
    ]),
    readable: await withRealPaths([input.workspace]),
    allowedDomains: input.allowedDomains ?? sandboxDomainsOf(process.env),
    tempDir: input.tempDir,
    unixSockets: await withRealPaths([input.workspace, input.tempDir]),
  };
}

/**
 * sandbox-runtime keeps one configuration and one network proxy per process, and a second `initialize` keeps the
 * first configuration. So open sandboxes share one runtime: each command carries its own sandbox's filesystem rules,
 * and the proxy enforces the one allowlist that every sharer opened with. `users` is 0 while the runtime resets.
 */
type SharedRuntime = {
  readonly allowlist: string;
  readonly config: SandboxRuntimeConfig;
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
  const config: SandboxRuntimeConfig = {
    // Loopback only, so a dev server started in the background can be reached with curl; the allowlist still holds for every other host.
    network: { allowedDomains: [...policy.allowedDomains], deniedDomains: [], allowLocalBinding: true },
    // Every command passes its own rules, so a command wrapped without them may write nothing.
    filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] },
  };
  const runtime: SharedRuntime = {
    allowlist: allowlistOf(policy),
    config,
    ended: new Promise((resolve) => (finish = resolve)),
    finish,
    users: 1,
    ready: SandboxManager.initialize(config),
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

let wrapping: Promise<unknown> = Promise.resolve();

/**
 * `command` wrapped with `policy`'s unix socket places. sandbox-runtime reads them from its one process-wide config,
 * not per command as it does the filesystem rules, so each wrap sets them first and the wraps run one at a time:
 * otherwise a command of one chat could reach a socket in another chat's workspace.
 */
function wrapOne(runtime: SharedRuntime, policy: SandboxPolicy, command: string, filesystem: NonNullable<SandboxRuntimeConfig['filesystem']>): Promise<string> {
  const wrapped = wrapping.then(() => {
    SandboxManager.updateConfig({ ...runtime.config, network: { ...runtime.config.network, allowUnixSockets: [...policy.unixSockets] } });
    return SandboxManager.wrapWithSandbox(command, undefined, { filesystem });
  });
  wrapping = wrapped.catch(() => {});
  return wrapped;
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
  // sandbox-runtime sets TMPDIR from its process-wide CLAUDE_CODE_TMPDIR, which an engine serving several sessions
  // cannot give each one, so the command sets its own after the runtime's.
  const caches = cacheVariables(policy.tempDir);
  const sandboxed = async (command: string, filesystem: Awaited<ReturnType<typeof rules>>) =>
    wrapOne(runtime, policy, `export TMPDIR=${shellQuote(policy.tempDir)} ${caches}\n${command}`, filesystem);
  // The opener's hold and one per retained command; the runtime is left once all have let go.
  let holds = 1;
  const release = async () => {
    if (--holds === 0) await leave(runtime);
  };
  let open = true;
  // The process groups of commands that left something running, as `cmd &` does, stopped when the run ends.
  const lingering = new Set<number>();
  return {
    run: async (command, options) => {
      const inside = async () => {
        const filesystem = await rules();
        return sandboxed(command, { ...filesystem, allowWrite: [...filesystem.allowWrite, ...(options.writable ?? [])] });
      };
      // Outside, the package managers keep their caches in the home folder as they would anywhere; only $TMPDIR stays the session's.
      const result = await runShell(options.outside === true ? `export TMPDIR=${shellQuote(policy.tempDir)}\n${command}` : await inside(), options);
      if (result.lingering !== undefined) lingering.add(result.lingering);
      return result;
    },
    spawn: async (command, options) => spawnShell(await sandboxed(command, await rules()), options),
    wrap: async (command) => sandboxed(command, await rules()),
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
      for (const group of lingering) stopGroup(group);
      lingering.clear();
      if (!open) return;
      open = false;
      await release();
    },
  };
}
