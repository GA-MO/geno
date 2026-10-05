import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build, type BuildOptions } from 'esbuild';

// Vitest runs from the repository root.
export const root = path.resolve('packages/extension');
export const cachePath = path.resolve(root, '../../.vscode-test');

const common: BuildOptions = { bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] };

/** Builds what `pnpm build` builds for the extension: its host bundle and the chat webview. */
async function buildExtension(): Promise<void> {
  await build({ ...common, entryPoints: [path.join(root, 'src/extension.ts')], outfile: path.join(root, 'dist/extension.js') });
  await build({
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    entryPoints: [path.join(root, 'src/chat/webview.ts')],
    outfile: path.join(root, 'dist/webview.js'),
  });
}

/** Builds the engine CLI that the chat panel spawns, and returns its path. */
export async function buildEngine(): Promise<string> {
  const engineCli = path.resolve(root, '../engine/dist/cli.js');
  await build({
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    entryPoints: [path.resolve(root, '../engine/src/cli.ts')],
    outfile: engineCli,
    external: ['@anthropic-ai/sandbox-runtime'],
  });
  return engineCli;
}

/** A workspace with the given files and settings, a fresh GCODE_HOME, and the extension and the named suite built. */
export async function setUp(suiteName: string, files: Readonly<Record<string, string>>, settings: Record<string, unknown>) {
  const work = await mkdtemp(path.join(tmpdir(), 'gcode-ext-'));
  const workspace = path.join(work, 'workspace');
  const home = path.join(work, 'home');
  await mkdir(path.join(workspace, '.vscode'), { recursive: true });
  for (const [file, text] of Object.entries(files)) await writeFile(path.join(workspace, file), text);
  const quiet = {
    // VS Code's chat panel otherwise opens at startup and takes keyboard focus from the editor under test.
    'chat.disableAIFeatures': true,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
  };
  await writeFile(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({ ...quiet, ...settings }));
  await buildExtension();
  const suite = await buildSuite(work, suiteName);
  // A user-data dir under the repo makes VS Code's IPC socket path longer than macOS allows.
  const launchArgs = [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${work}/ud`];
  return { work, workspace, home, suite, launchArgs };
}

/** Bundles `test/suite/<name>.ts` into `work`, for runTests' extensionTestsPath. */
export async function buildSuite(work: string, name: string): Promise<string> {
  const suite = path.join(work, `${name}.js`);
  await build({ ...common, entryPoints: [path.join(root, `test/suite/${name}.ts`)], outfile: suite });
  return suite;
}
