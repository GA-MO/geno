import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createVSIX } from '@vscode/vsce';
import { build, type BuildOptions } from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');

const BUNDLES: readonly BuildOptions[] = [
  {
    entryPoints: [path.join(root, 'src/extension.ts')],
    outfile: path.join(dist, 'extension.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  {
    entryPoints: [path.join(root, 'src/chat/webview.ts')],
    outfile: path.join(dist, 'webview.js'),
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: true,
  },
  {
    entryPoints: [path.join(root, 'src/chat/diagram-tab-view.ts')],
    outfile: path.join(dist, 'diagram-tab.js'),
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    minify: true,
  },
  {
    // Mermaid, which the panels import only once a transcript holds a diagram. As ES modules split into chunks,
    // a page loads the diagram types it draws and no others.
    entryPoints: { render: path.join(root, 'src/chat/diagram-render.ts') },
    outdir: path.join(dist, 'diagram'),
    chunkNames: 'chunks/[name]-[hash]',
    platform: 'browser',
    format: 'esm',
    splitting: true,
    target: 'es2022',
    minify: true,
  },
  {
    // The panel's styles with the codicon font they import, served from dist under the webview's strict CSP.
    entryPoints: [path.join(root, 'src/chat/webview.css')],
    outfile: path.join(dist, 'webview.css'),
    loader: { '.ttf': 'file' },
    assetNames: '[name]',
    minify: true,
  },
  {
    // sandbox-runtime is bundled too, since the .vsix ships no node_modules; on macOS it needs none of its vendor files.
    entryPoints: [path.join(root, '../engine/src/embedded.ts')],
    outfile: path.join(dist, 'engine/cli.js'),
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // Bundled CommonJS dependencies call require for Node built-ins, which an ES module lacks.
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  },
];

/** Builds the extension host bundle, the chat webview and the engine the extension spawns. */
export async function buildExtension(): Promise<void> {
  // Chunk names change with their content, so old ones would pile up in the package.
  await rm(path.join(dist, 'diagram'), { recursive: true, force: true });
  await Promise.all(BUNDLES.map((options) => build({ bundle: true, logLevel: 'warning', ...options })));
  await mkdir(path.join(dist, 'engine'), { recursive: true });
  await writeFile(path.join(dist, 'engine/package.json'), '{ "type": "module" }\n');
}

/** Builds, then packs `g-code-<version>.vsix`; everything is bundled, so no dependencies go in. */
export async function packageExtension(packagePath?: string): Promise<void> {
  await buildExtension();
  await createVSIX({
    cwd: root,
    dependencies: false,
    allowMissingRepository: true,
    skipLicense: true,
    ...(packagePath === undefined ? {} : { packagePath }),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await (process.argv[2] === 'package' ? packageExtension() : buildExtension());
}
