import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { inject, onTestFinished } from 'vitest';
import { post, type Done, type Lease } from './protocol.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The window pool's address, from vscode-setup.ts. */
    vscodePool: string;
  }
}

/** Where a suite runs: the workspace it opens, and the `work` folder setUp made, whose `ud/User` files it starts with. */
export type Folder = { readonly workspace: string; readonly work: string };

export type VscodeWindow = {
  /** The window's Chrome DevTools Protocol port, for screenshots and input. */
  readonly debugPort: number;
  readonly userData: string;
  /**
   * Runs the bundled suite in a fresh extension host with `env`, in `folder`'s workspace, and throws the suite's
   * error if it fails. Running again in the same folder is a window reload, as far as the extension can tell.
   */
  run(suite: string, folder: Folder, env: Readonly<Record<string, string>>): Promise<void>;
};

/** A VS Code window from the pool, held until the test ends. */
export async function leaseWindow(): Promise<VscodeWindow> {
  const url = inject('vscodePool');
  const lease = await post<Lease>(`${url}/lease`, {});
  onTestFinished(() => post(`${url}/release`, { id: lease.id }));
  return {
    debugPort: lease.debugPort,
    userData: lease.userData,
    async run(suite, { workspace, work }, env) {
      const log = path.join(work, `${path.basename(suite, '.js')}.log`);
      // A home of the suite's own, so no skill, agent or setting in the user's ~/.claude or ~/.agents reaches the engine.
      const home = path.join(work, 'user-home');
      await mkdir(path.join(home, '.claude'), { recursive: true });
      const job = {
        suite,
        workspace,
        user: path.join(work, 'ud', 'User'),
        env: { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ...env },
        log,
      };
      const { error } = await post<{ error?: NonNullable<Done['error']> }>(`${url}/run`, { id: lease.id, job });
      const output = await readFile(log, 'utf8').catch(() => '');
      if (output !== '') process.stdout.write(output);
      if (error === undefined) return;
      const failure = new Error(`${path.basename(suite, '.js')}: ${error.message}`);
      if (error.stack !== undefined) failure.stack = `${failure.message}\n${error.stack.split('\n').slice(1).join('\n')}`;
      throw failure;
    },
  };
}

/**
 * Holds a place for a file that launches VS Code itself, such as a packed or Insiders build, so the run never has
 * more windows open than the pool allows. Released when the test ends.
 */
export async function reserveLaunch(): Promise<void> {
  const url = inject('vscodePool');
  await post(`${url}/reserve`, {});
  onTestFinished(() => post(`${url}/unreserve`, {}));
}
