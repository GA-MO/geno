import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, type BuildOptions } from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
export const DIST = path.join(root, 'dist');

export const BUNDLES: readonly BuildOptions[] = [
  {
    // The chat host as the extension runs it, with `vscode` the shim. A member the shim lacks would be undefined at
    // run time, so esbuild's warning for it fails the build instead.
    entryPoints: [path.join(root, 'src/main.ts')],
    outfile: path.join(DIST, 'main.js'),
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: { vscode: path.join(root, 'src/vscode-shim.ts') },
    logOverride: { 'import-is-undefined': 'error' },
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  },
  {
    entryPoints: [path.join(root, 'src/client.ts')],
    outfile: path.join(DIST, 'client.js'),
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  },
];

export async function buildWeb(): Promise<void> {
  await Promise.all(BUNDLES.map((options) => build({ bundle: true, logLevel: 'warning', ...options })));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await buildWeb();
