/// <reference lib="dom" />
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright-core';
import { BUNDLES } from '../../build.mjs';
import type { FromView, Look, ToView, Transcript } from '../../src/chat/messages.js';
import { pageMarkup } from '../../src/chat/page-markup.js';
import { galleryMedia } from '../gallery/media.js';
import { answerReady, DEFAULT_LOOK, FakeHost } from './host.js';
import { applyTheme, themedPage, themeOf, type ThemeSlug } from './theme.js';

// Vitest runs from the repository root.
const DIST = path.resolve('packages/extension/dist');
const ORIGIN = 'https://webview.test';

export { DEFAULT_LOOK, MODES } from './host.js';

let built: Promise<string> | undefined;

/**
 * The extension's browser bundles, built from source into a folder of this process's own: a test sees the source as
 * it is now, without `pnpm build`, and never rewrites the dist a VS Code test may be loading.
 */
export function buildPanel(): Promise<string> {
  built ??= (async () => {
    const out = await mkdtemp(path.join(tmpdir(), 'gcode-webview-'));
    const into = (file: string) => path.join(out, path.relative(DIST, file));
    await Promise.all(
      BUNDLES.filter((options) => options.platform !== 'node').map((options) =>
        build({
          bundle: true,
          logLevel: 'warning',
          ...options,
          ...(options.outfile === undefined ? {} : { outfile: into(options.outfile) }),
          ...(options.outdir === undefined ? {} : { outdir: into(options.outdir) }),
        }),
      ),
    );
    return out;
  })();
  return built;
}

let browser: Promise<Browser> | undefined;

/** One headless Chromium per test file. GCODE_CHROMIUM names another build, such as the container's own. */
const browserOf = (): Promise<Browser> => (browser ??= chromium.launch(process.env['GCODE_CHROMIUM'] ? { executablePath: process.env['GCODE_CHROMIUM'] } : {}));

export async function closeBrowser(): Promise<void> {
  const open = browser;
  browser = undefined;
  await (await open)?.close();
}

export type PanelOptions = { readonly theme?: ThemeSlug; readonly look?: Look; readonly model?: string; readonly focused?: boolean; readonly width?: number };

export type Panel = {
  readonly page: Page;
  readonly host: FakeHost;
  /** What the page logged as errors so far, CSP refusals among them. */
  readonly consoleErrors: readonly string[];
  /** Evaluates `expression` over the panel's document, bound as `doc`, as the VS Code suites' `panel()` does. */
  eval<T>(expression: string): Promise<T>;
  count(selector: string): Promise<number>;
  /** Clicks the first `selector` match whose trimmed text is `text` when given, failing if something covers it. */
  click(selector: string, text?: string): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string): Promise<void>;
  waitFor(what: string, probe: () => Promise<boolean>, ms?: number): Promise<void>;
  theme(slug: ThemeSlug): Promise<void>;
  /** Changes the look as the settings do, and returns once the panel drew it. */
  look(look: Partial<Look>): Promise<void>;
  /** Waits for the panel to draw its next frame, where the view renders what it scheduled. */
  frame(): Promise<void>;
  /** Writes `<GCODE_SCREENSHOTS>/webview/<name>.png` when GCODE_SCREENSHOTS is set. */
  screenshot(name: string): Promise<void>;
  close(): Promise<void>;
};

const hexToRgba = (hex: string): { r: number; g: number; b: number; a: number } => {
  const h = hex.replace('#', '');
  const full = h.length <= 4 ? [...h].map((c) => c + c).join('') : h;
  const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) / 255 : 1 };
};

/** The side bar's color, which VS Code paints behind the transparent webview. */
const backdropOf = (htmlStyle: string) => hexToRgba(/--vscode-sideBar-background:\s*(#[0-9a-fA-F]+)/.exec(htmlStyle)?.[1] ?? '#000000');

/**
 * The chat webview in a headless browser, as VS Code would show it: the built page under its own CSP, the theme's
 * variables, and a FakeHost on the other side of `acquireVsCodeApi`, which answers `ready` as the extension does.
 */
export async function openPanel({ theme = 'dark', look = DEFAULT_LOOK, model = 'qwen3.8-flash', focused = true, width }: PanelOptions = {}): Promise<Panel> {
  const out = await buildPanel();
  const dump = themeOf(theme);
  const context = await (await browserOf()).newContext({ viewport: { width: width ?? dump.viewport.width, height: dump.viewport.height }, deviceScaleFactor: dump.viewport.deviceScaleFactor });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: backdropOf(dump.htmlStyle) });

  // Console errors are not failures: DOMPurify's parse of each diagram reports a refused style element, in VS Code too.
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => void (message.type() === 'error' && consoleErrors.push(message.text())));

  const deliver = (message: ToView) => page.evaluate((data) => void window.dispatchEvent(new MessageEvent('message', { data })), message);
  const transcript: Transcript = { model, turns: [] };
  const host = new FakeHost(deliver, transcript);
  host.on('ready', () => answerReady(host, focused));
  await page.exposeFunction('__gcodeFromView', (message: FromView) => host.receive(message));
  await page.addInitScript(() => {
    let state: unknown;
    const send = (window as unknown as { __gcodeFromView: (m: unknown) => void }).__gcodeFromView;
    Object.assign(window, { acquireVsCodeApi: () => ({ postMessage: (m: unknown) => send(m), getState: () => state, setState: (s: unknown) => void (state = s) }) });
  });

  const nonce = randomBytes(16).toString('base64');
  const html = themedPage(pageMarkup({ cspSource: ORIGIN, nonce, uri: (file) => `${ORIGIN}/${file}`, entry: 'webview.js', look }), dump, nonce);
  await page.route(`${ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    const media = galleryMedia(pathname);
    if (media !== undefined) return route.fulfill({ contentType: 'image/png', body: media });
    return pathname === '/index.html' ? route.fulfill({ contentType: 'text/html', body: html }) : route.fulfill({ path: path.join(out, decodeURIComponent(pathname)) });
  });
  await page.goto(`${ORIGIN}/index.html`);
  await host.next('ready');
  await host.settled();

  let current = look;
  const shots = process.env['GCODE_SCREENSHOTS'];
  const panel: Panel = {
    page,
    host,
    consoleErrors,
    eval: (expression) => page.evaluate(`(() => { const doc = document; return (${expression}); })()`),
    count: (selector) => page.evaluate((s) => document.querySelectorAll(s).length, selector),
    click: async (selector, text) => {
      const all = page.locator(selector);
      const target = text === undefined ? all.first() : all.filter({ hasText: new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }).first();
      await target.click({ timeout: 5000 });
    },
    type: (text) => page.keyboard.insertText(text),
    press: (key) => page.keyboard.press(key),
    waitFor: async (what, probe, ms = 10_000) => {
      const deadline = Date.now() + ms;
      let last: unknown;
      for (;;) {
        try {
          if (await probe()) return;
        } catch (error) {
          last = error;
        }
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last === undefined ? '' : `: ${String(last)}`}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    theme: async (slug) => {
      const next = themeOf(slug);
      await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: backdropOf(next.htmlStyle) });
      await page.evaluate(applyTheme, next);
      await panel.frame();
    },
    look: async (change) => {
      current = { ...current, ...change };
      await host.post({ type: 'look', look: current });
      await panel.frame();
    },
    frame: () => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))),
    screenshot: async (name) => {
      if (shots === undefined) return;
      await mkdir(path.resolve(shots, 'webview'), { recursive: true });
      await page.screenshot({ path: path.resolve(shots, 'webview', `${name}.png`) });
    },
    close: async () => {
      await host.settled();
      await context.close();
      if (errors.length > 0) throw new Error(`the panel threw: ${errors.join('; ')}`);
    },
  };
  return panel;
}
