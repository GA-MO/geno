import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { build } from 'esbuild';
import type { TestProject } from 'vitest/node';
import { vscodeWorkers } from '../../../scripts/vscode-workers.js';
import { cachePath, root } from './launch.js';
import { startPool, type Launch } from './pool/broker.js';
import { freePort } from './screenshot.js';

const STALE_MS = 15 * 60_000;

const version = () => (process.env['GCODE_VSCODE_VERSION'] ? { version: process.env['GCODE_VSCODE_VERSION'] } : {});

/**
 * Every worktree shares one VS Code download, and two runs unzipping into it at once leave a broken install. So the
 * download happens here, once per run and one run at a time; each test's runTests then finds it in place.
 */
async function download(): Promise<string> {
  await mkdir(cachePath, { recursive: true });
  const lock = path.join(cachePath, '.download-lock');
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch {
      const made = await stat(lock).then((s) => s.mtimeMs, () => Date.now());
      if (Date.now() - made > STALE_MS) await rm(lock, { recursive: true, force: true });
      else await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  try {
    return await downloadAndUnzipVSCode({ cachePath, ...version() });
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

const HOST_ID = 'g-code-test.gcode-test-pool';

/** The extension that runs suites inside a pooled window (pool/host.ts), built into `dir`. */
async function buildHost(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await build({ bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], entryPoints: [path.join(root, 'test/pool/host.ts')], outfile: path.join(dir, 'host.js'), logLevel: 'warning' });
  const manifest = { name: 'gcode-test-pool', publisher: 'g-code-test', version: '0.0.0', engines: { vscode: '^1.95.0' }, main: './host.js', activationEvents: ['*'] };
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(manifest));
  return dir;
}

/**
 * Geno as the pooled windows load it: the built files the .vsix ships, with a manifest that depends on the host.
 * VS Code then activates the host, which sets the suite's env, before Geno, whatever activates Geno; after a
 * reload that is its restored view, sooner than any `*` extension. Copies, not links: VS Code binds a module's
 * `require('vscode')` to the extension whose folder holds the module's real path.
 */
async function stageGeno(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { files: string[]; extensionDependencies?: string[] };
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ ...manifest, extensionDependencies: [...(manifest.extensionDependencies ?? []), HOST_ID] }));
  for (const entry of manifest.files) await cp(path.join(root, entry), path.join(dir, entry), { recursive: true });
  return dir;
}

/**
 * Downloads VS Code and builds the extension once per run, since files that run at once load dist while a rebuild
 * would rewrite it. Then starts the window pool the files lease their VS Code from: at most GCODE_VSCODE_WORKERS
 * windows, each launched on first use and reused for suite after suite.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const executable = await download();
  const { buildExtension } = await import('../build.mjs');
  await buildExtension();
  // Short: VS Code puts its IPC socket in each window's user data folder, and macOS caps a socket path at 104 bytes.
  const dir = await mkdtemp(path.join(tmpdir(), 'p-'));
  const host = await buildHost(path.join(dir, 'host'));
  const geno = await stageGeno(path.join(dir, 'geno'));
  const launch: Launch = (window, folder, poolUrl) => {
    const logFile = path.join(dir, String(window.id), 'vscode.log');
    const args = [
      folder,
      '--disable-extensions',
      '--skip-welcome',
      '--skip-release-notes',
      '--force-disable-user-env',
      '--use-inmemory-secretstorage',
      '--no-sandbox',
      '--disable-gpu-sandbox',
      '--disable-updates',
      '--no-cached-data',
      '--disable-workspace-trust',
      `--user-data-dir=${window.userData}`,
      `--extensions-dir=${path.join(dir, String(window.id), 'extensions')}`,
      `--remote-debugging-port=${window.debugPort}`,
      `--extensionDevelopmentPath=${host}`,
      `--extensionDevelopmentPath=${geno}`,
    ];
    const log = openSync(logFile, 'a');
    const child = spawn(executable, args, { env: { ...process.env, GCODE_POOL_URL: poolUrl, GCODE_POOL_WINDOW: String(window.id) }, stdio: ['ignore', log, log] });
    const exited = new Promise<void>((resolve) => child.on('close', () => (closeSync(log), resolve())));
    return { exited, kill: (force) => void child.kill(force ? 'SIGKILL' : 'SIGTERM') };
  };
  const pool = await startPool({ capacity: vscodeWorkers(process.env), dir, launch, freePort });
  project.provide('vscodePool', pool.url);
  return async () => {
    const { launches, suites, ownLaunches } = await pool.close();
    console.log(`vscode pool: ${suites} suite runs in ${launches} pooled VS Code launches, and ${ownLaunches} files that launched their own`);
  };
}
