import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath } from '@vscode/test-electron';
import { build, type BuildOptions } from 'esbuild';

// Vitest runs from the repository root.
export const root = path.resolve('packages/extension');
export const cachePath = path.resolve(root, '../../.vscode-test');

const common: BuildOptions = { bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] };

/** A workspace with the given files and settings, and a fresh GCODE_HOME. */
export async function makeWorkspace(files: Readonly<Record<string, string>>, settings: Record<string, unknown>) {
  const work = await mkdtemp(path.join(tmpdir(), 'gcode-ext-'));
  const workspace = path.join(work, 'workspace');
  const home = path.join(work, 'home');
  await mkdir(path.join(workspace, '.vscode'), { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await writeFile(path.join(workspace, file), text);
  }
  const quiet = {
    // VS Code's chat panel otherwise opens at startup and takes keyboard focus from the editor under test.
    'chat.disableAIFeatures': true,
    'workbench.secondarySideBar.defaultVisibility': 'hidden',
  };
  await writeFile(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({ ...quiet, ...settings }));
  return { work, workspace, home };
}

/** A workspace as makeWorkspace makes it, with the extension and the named suite built. */
export async function setUp(suiteName: string, files: Readonly<Record<string, string>>, settings: Record<string, unknown>) {
  const { work, workspace, home } = await makeWorkspace(files, settings);
  const { buildExtension } = await import('../build.mjs');
  await buildExtension();
  const suite = await buildSuite(work, suiteName);
  // A user-data dir under the repo makes VS Code's IPC socket path longer than macOS allows.
  const launchArgs = [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--force-disable-user-env', `--user-data-dir=${work}/ud`];
  return { work, workspace, home, suite, launchArgs };
}

/** Bundles `test/suite/<name>.ts` into `work`, for runTests' extensionTestsPath. */
export async function buildSuite(work: string, name: string): Promise<string> {
  const suite = path.join(work, `${name}.js`);
  await build({ ...common, entryPoints: [path.join(root, `test/suite/${name}.ts`)], outfile: suite });
  return suite;
}

/** The PATH of a Mac with no developer tools installed. */
export const BARE_PATH = '/usr/bin:/bin';

/**
 * Packages the .vsix and installs it with VS Code's command line into an empty extensions dir, as a user would.
 * launchArgs start that VS Code with throwaway user data, secrets kept in memory, and the environment it was given
 * rather than one resolved from the login shell.
 */
export async function installClean(work: string) {
  const { packageExtension } = await import('../build.mjs');
  const vsix = path.join(work, 'g-code.vsix');
  await packageExtension(vsix);
  // GCODE_VSCODE_VERSION pins the editor build, for checking the version the user actually runs.
  const executable = await downloadAndUnzipVSCode({ cachePath, ...(process.env['GCODE_VSCODE_VERSION'] ? { version: process.env['GCODE_VSCODE_VERSION'] } : {}) });
  const extensionsDir = path.join(work, 'extensions');
  const profile = [`--extensions-dir=${extensionsDir}`, `--user-data-dir=${work}/ud`];
  const cli = resolveCliPathFromVSCodeExecutablePath(executable);
  const install = spawnSync(cli, [...profile, '--install-extension', vsix], { env: { ...process.env, PATH: BARE_PATH }, encoding: 'utf8' });
  if (install.status !== 0) throw new Error(`installing ${vsix} failed: ${install.stdout}${install.stderr}`);
  // runTests needs an extension under development; this one contributes nothing.
  const harness = path.join(work, 'harness');
  await mkdir(harness);
  const manifest = { name: 'gcode-test-harness', publisher: 'g-code-test', version: '0.0.0', engines: { vscode: '^1.95.0' } };
  await writeFile(path.join(harness, 'package.json'), JSON.stringify(manifest));
  return {
    vsix,
    executable,
    extensionsDir,
    harness,
    installOutput: install.stdout,
    launchArgs: [...profile, '--skip-welcome', '--skip-release-notes', '--use-inmemory-secretstorage', '--force-disable-user-env'],
  };
}
