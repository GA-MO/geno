/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** What VS Code puts on a webview's document for one color theme, as capture-themes.mts read it from a real window. */
export type ThemeDump = {
  readonly theme: string;
  /** The `--vscode-*` custom properties, the font settings among them, as VS Code writes them on `<html style>`. */
  readonly htmlStyle: string;
  /** `vscode-light`, `vscode-dark`, `vscode-high-contrast` or `vscode-high-contrast-light`, and any other it adds. */
  readonly bodyClasses: readonly string[];
  /** `data-vscode-theme-kind`, `data-vscode-theme-id` and the other data attributes VS Code sets on `<body>`. */
  readonly bodyAttributes: Readonly<Record<string, string>>;
  /** The default stylesheet VS Code injects as `<style id="_defaultStyles">`. */
  readonly defaultStyles: string;
  /** The panel's size in the window the suites lay out, so screenshots match theirs. */
  readonly viewport: { readonly width: number; readonly height: number; readonly deviceScaleFactor: number };
};

/** The themes the VS Code suites cycle through for screenshots, by the slug their screenshot names carry. */
export const THEME_SLUGS = ['dark', 'light', 'high-contrast', 'high-contrast-light'] as const;
export type ThemeSlug = (typeof THEME_SLUGS)[number];

// Vitest runs from the repository root.
const THEMES_DIR = path.resolve('packages/extension/test/webview/themes');

export const themeOf = (slug: ThemeSlug): ThemeDump => JSON.parse(readFileSync(path.join(THEMES_DIR, `${slug}.json`), 'utf8')) as ThemeDump;

const escapeAttribute = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * `markup`, as pageMarkup made it, the way VS Code's webview host hands it to the page: the theme's variables on
 * `<html>`, its classes and data attributes on `<body>`, and the default stylesheet first in `<head>`, under `nonce`.
 */
export function themedPage(markup: string, theme: ThemeDump, nonce: string): string {
  const head = markup.indexOf('<head>');
  const html = markup.indexOf('<html');
  const body = markup.indexOf('<body');
  if (head === -1 || html === -1 || body === -1) throw new Error('the page markup has no <html>, <head> or <body>');
  const bodyAttributes = Object.entries(theme.bodyAttributes)
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join('');
  return [
    markup.slice(0, html + '<html'.length),
    ` style="${escapeAttribute(theme.htmlStyle)}"`,
    markup.slice(html + '<html'.length, head + '<head>'.length),
    `<style id="_defaultStyles" nonce="${nonce}">${theme.defaultStyles}</style>`,
    markup.slice(head + '<head>'.length, body + '<body'.length),
    ` class="${theme.bodyClasses.join(' ')}"${bodyAttributes}`,
    markup.slice(body + '<body'.length),
  ].join('');
}

/**
 * Runs in the page: switches it to `theme` the way VS Code does when the user picks another color theme, in place,
 * keeping every class and attribute the panel set itself.
 */
export function applyTheme(theme: Pick<ThemeDump, 'htmlStyle' | 'bodyClasses' | 'bodyAttributes' | 'defaultStyles'>): void {
  document.documentElement.setAttribute('style', theme.htmlStyle);
  const body = document.body;
  for (const name of [...body.classList]) if (name.startsWith('vscode-')) body.classList.remove(name);
  body.classList.add(...theme.bodyClasses);
  for (const { name } of [...body.attributes]) if (name.startsWith('data-vscode-')) body.removeAttribute(name);
  for (const [name, value] of Object.entries(theme.bodyAttributes)) body.setAttribute(name, value);
  document.getElementById('_defaultStyles')!.textContent = theme.defaultStyles;
}
