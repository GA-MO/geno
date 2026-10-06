import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createVSIX } from '@vscode/vsce';
import { build, type BuildOptions } from 'esbuild';
import { compose, STAND, svgOf } from './src/chat/sprite.js';
import { DINO_DIST, DINO_FILES } from './src/dino.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');

/** The still chat avatar goes into the webview bundle as markup, so the panel's CSP needs no image source. */
const avatar = svgOf(compose(STAND));

export const BUNDLES: readonly BuildOptions[] = [
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
    define: { DINO_AVATAR: JSON.stringify(avatar) },
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
    entryPoints: [path.join(root, 'src/chat/widget-tab-view.ts')],
    outfile: path.join(dist, 'widget-tab.js'),
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
    // The sandbox host runs an external agent inside the sandbox, as a process of its own beside the engine.
    entryPoints: { cli: path.join(root, '../engine/src/embedded.ts'), 'sandbox-host': path.join(root, '../engine/src/sandbox-host.ts') },
    outdir: path.join(dist, 'engine'),
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // Bundled CommonJS dependencies call require for Node built-ins, which an ES module lacks.
    banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  },
];

/**
 * Chunk names change with their content, so a build deletes the chunks it no longer writes, or they would pile up
 * in the package. Only those: tests build in parallel and package or load the current ones meanwhile.
 */
async function pruneChunks(outputs: readonly string[]): Promise<void> {
  const chunks = path.join(dist, 'diagram/chunks');
  const written = new Set(outputs.map((file) => path.resolve(file)));
  const present = await readdir(chunks).catch(() => []);
  await Promise.all(present.map((name) => path.join(chunks, name)).filter((file) => !written.has(file)).map((file) => rm(file, { force: true })));
}

/** Builds the extension host bundle, the chat webview and the engine the extension spawns. */
export async function buildExtension(): Promise<void> {
  const results = await Promise.all(BUNDLES.map((options) => build({ bundle: true, logLevel: 'warning', metafile: true, ...options })));
  await pruneChunks(results.flatMap((result) => Object.keys(result.metafile?.outputs ?? {})));
  await mkdir(path.join(dist, 'dino'), { recursive: true });
  await copyFile(path.join(root, DINO_FILES.mono), path.join(root, DINO_DIST.mono));
  await copyFile(path.join(root, DINO_FILES.icon), path.join(root, DINO_DIST.icon));
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
