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

let opened = false;

/** sandbox-runtime keeps one global configuration, so one sandbox is open at a time. */
export async function openSandbox(policy: SandboxPolicy): Promise<Sandbox> {
  if (!SandboxManager.isSupportedPlatform()) {
    throw new EngineError(`sandbox-runtime does not support ${process.platform}, so commands cannot run`);
  }
  if (opened) throw new EngineError('a sandbox is already open');
  await SandboxManager.initialize({
    network: { allowedDomains: [...policy.allowedDomains], deniedDomains: [] },
    filesystem: {
      denyRead: [...policy.denyRead],
      allowRead: [...policy.readable],
      allowWrite: [...policy.writable],
      denyWrite: [],
    },
  });
  opened = true;
  return {
    run: async (command, options) => runShell(await SandboxManager.wrapWithSandbox(command), options),
    async close() {
      if (!opened) return;
      opened = false;
      await SandboxManager.reset();
    },
  };
}
