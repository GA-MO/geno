/**
 * `pnpm ui`: the UI gallery. Builds the chat panel's browser bundles and the gallery's own from source, rebuilds
 * them on every change, and serves the gallery on 127.0.0.1, where each state runs the real panel against a FakeHost.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { context, type BuildOptions, type Plugin } from 'esbuild';
import { BUNDLES } from '../../build.mjs';
import { UI_STYLES, type Look } from '../../src/chat/messages.js';
import { pageMarkup } from '../../src/chat/page-markup.js';
import { REVIEW_MODES } from '../../src/review/mode.js';
import { THEME_SLUGS, themedPage, themeOf, type ThemeSlug } from '../webview/theme.js';
import { galleryMedia } from './media.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const extension = path.resolve(here, '../..');
const DIST = path.join(extension, 'dist');
const port = Number(process.env['GCODE_UI_PORT'] ?? 5390);

const TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.map': 'application/json',
};

const out = await mkdtemp(path.join(tmpdir(), 'gcode-ui-'));
const into = (file: string) => path.join(out, path.relative(DIST, file));

/** Each rebuild bumps the version, which the gallery polls to reload its frames. */
let version = 0;
let failure: string | undefined;
const watching: Plugin = {
  name: 'gallery-version',
  setup(build) {
    build.onEnd((result) => {
      failure = result.errors.length > 0 ? result.errors.map((e) => e.text).join('\n') : undefined;
      version++;
    });
  },
};

const panelBundles: BuildOptions[] = BUNDLES.filter((options) => options.platform !== 'node').map((options) => ({
  bundle: true,
  logLevel: 'warning',
  ...options,
  ...(options.outfile === undefined ? {} : { outfile: into(options.outfile) }),
  ...(options.outdir === undefined ? {} : { outdir: into(options.outdir) }),
}));
const galleryBuild = (entry: string, format: 'esm' | 'iife'): BuildOptions => ({
  entryPoints: [path.join(here, `${entry}.${entry === 'app' ? 'mts' : 'ts'}`)],
  outfile: path.join(out, entry === 'app' ? 'gallery.js' : `${entry}.js`),
  bundle: true,
  platform: 'browser',
  format,
  target: 'es2022',
  logLevel: 'warning',
  sourcemap: 'inline',
});
// The gallery page is a module; the design page runs under the panel's CSP, which loads a classic script.
const contexts = await Promise.all([...panelBundles, galleryBuild('app', 'esm'), galleryBuild('design', 'iife')].map((options) => context({ ...options, plugins: [...(options.plugins ?? []), watching] })));
// A failed first build is shown in the gallery, as a later one is, rather than ending the server.
await Promise.all(contexts.map((c) => c.rebuild().catch(() => undefined)));
await Promise.all(contexts.map((c) => c.watch()));

/** Every codicon the panel's source draws, by name, as `icon('…')` names them. */
async function iconsInSource(): Promise<string[]> {
  const chat = path.join(extension, 'src/chat');
  const names = new Set<string>();
  for (const file of await readdir(chat)) {
    if (!file.endsWith('.ts')) continue;
    for (const [, name] of (await readFile(path.join(chat, file), 'utf8')).matchAll(/\bicon\('([a-z0-9-]+)'/g)) names.add(name!);
  }
  return [...names].sort();
}

const pick = <T extends string>(values: readonly T[], value: string | null, fallback: T): T => ((values as readonly string[]).includes(value ?? '') ? (value as T) : fallback);

/** A panel-like page: the real markup and CSP under the theme, with a stub of `acquireVsCodeApi` that talks to the gallery. */
function framePage(query: URLSearchParams, origin: string, entry: 'webview.js' | 'design.js', data = ''): string {
  const theme = pick<ThemeSlug>(THEME_SLUGS, query.get('theme'), 'dark');
  const look: Look = { style: pick(UI_STYLES, query.get('style'), 'glass'), detail: query.get('detail') === 'full' ? 'full' : 'compact', review: pick(REVIEW_MODES, query.get('review'), 'auto') };
  const reduce = query.get('motion') === 'reduce';
  const nonce = randomBytes(16).toString('base64');
  const uri = (file: string) => `${origin}/${file}${file === 'webview.css' && reduce ? '?motion=reduce' : ''}`;
  const markup = pageMarkup({ cspSource: origin, nonce, uri, entry, look });
  // The stub runs before the entry, as VS Code's preload does, and fakes reduced motion for the page's own checks.
  const stub = `<script nonce="${nonce}">(() => {
    const frame = window.frameElement; let state; parent.__gallery?.attach(frame, window);
    window.acquireVsCodeApi = () => ({ postMessage: (m) => parent.__gallery?.receive(frame, m), getState: () => state, setState: (s) => { state = s; } });
    if (${reduce}) { const real = window.matchMedia.bind(window); const fake = (q, matches) => ({ matches, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
      window.matchMedia = (q) => /prefers-reduced-motion:\\s*reduce/.test(q) ? fake(q, true) : /prefers-reduced-motion:\\s*no-preference/.test(q) ? fake(q, false) : real(q); }
  })();</script>`;
  const page = themedPage(markup, themeOf(theme), nonce);
  const own = entry === 'design.js' ? `<link rel="stylesheet" href="${origin}/design.css"><script type="application/json" id="design-data" nonce="${nonce}">${data.replace(/</g, '\\u003c')}</script>` : '';
  return page.replace('<link rel="stylesheet"', `${stub}${own}<link rel="stylesheet"`);
}

/** Reduced motion, as the gallery fakes it: the stylesheet's motion queries answered as if the user asked for it. */
const reducedMotion = (css: string) => css.replace(/\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/g, 'all').replace(/\(\s*prefers-reduced-motion\s*:\s*no-preference\s*\)/g, 'not all');

const GALLERY = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Geno UI gallery</title><link rel="stylesheet" href="/gallery.css"></head>
<body><script type="module" src="/gallery.js"></script></body></html>`;

const send = (res: ServerResponse, status: number, type: string, body: string | Buffer) => res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }).end(body);

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `127.0.0.1:${port}`}`);
    const origin = url.origin;
    if (url.pathname === '/') return send(res, 200, 'text/html', GALLERY);
    if (url.pathname === '/gallery.css' || url.pathname === '/design.css') return send(res, 200, 'text/css', await readFile(path.join(here, url.pathname.slice(1))));
    if (url.pathname === '/panel.html') return send(res, 200, 'text/html', framePage(url.searchParams, origin, 'webview.js'));
    if (url.pathname === '/design.html') return send(res, 200, 'text/html', framePage(url.searchParams, origin, 'design.js', JSON.stringify({ icons: await iconsInSource() })));
    if (url.pathname === '/version') return send(res, 200, 'application/json', JSON.stringify({ version, failure }));
    if (url.pathname === '/icons.json') return send(res, 200, 'application/json', JSON.stringify(await iconsInSource()));
    const media = galleryMedia(url.pathname);
    if (media !== undefined) return send(res, 200, 'image/png', media);
    const theme = /^\/themes\/([a-z-]+)\.json$/.exec(url.pathname)?.[1];
    if (theme !== undefined) return (THEME_SLUGS as readonly string[]).includes(theme) ? send(res, 200, 'application/json', JSON.stringify(themeOf(theme as ThemeSlug))) : send(res, 404, 'text/plain', 'no such theme');
    const file = path.join(out, decodeURIComponent(url.pathname));
    if (!file.startsWith(out + path.sep)) return send(res, 403, 'text/plain', 'outside the build');
    const body = await readFile(file).catch(() => undefined);
    if (body === undefined) return send(res, 404, 'text/plain', `${url.pathname} is not built`);
    const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
    return send(res, 200, type, url.pathname === '/webview.css' && url.searchParams.get('motion') === 'reduce' ? reducedMotion(body.toString('utf8')) : body);
  })().catch((error: unknown) => send(res, 500, 'text/plain', String(error)));
});

server.listen(port, '127.0.0.1', () => console.log(`Geno UI gallery: http://127.0.0.1:${port}/ (rebuilds on change; Ctrl+C stops it)`));

const stop = async () => {
  server.close();
  await Promise.all(contexts.map((c) => c.dispose()));
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
