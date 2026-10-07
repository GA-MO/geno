import { describe, expect, it } from 'vitest';
import { pageMarkup } from '../../src/chat/page-markup.js';
import { themedPage, themeOf, THEME_SLUGS, type ThemeDump } from './theme.js';

const THEME: ThemeDump = {
  theme: 'Test Dark',
  htmlStyle: '--vscode-foreground: #cccccc; --vscode-font-family: "Segoe UI", sans-serif;',
  bodyClasses: ['vscode-dark'],
  bodyAttributes: { 'data-vscode-theme-kind': 'vscode-dark', 'data-vscode-theme-id': 'Test "Dark"' },
  defaultStyles: 'body { margin: 0; }',
  viewport: { width: 600, height: 800, deviceScaleFactor: 1 },
};

const markup = pageMarkup({ cspSource: 'https://webview.test', nonce: 'n0nce', uri: (file) => `https://webview.test/${file}`, entry: 'webview.js', look: { style: 'glass', detail: 'compact', review: 'auto' } });

describe('themedPage', () => {
  const page = themedPage(markup, THEME, 'n0nce');

  it('puts the theme variables on <html>, quoted safely', () => {
    expect(page).toContain(`<html style="--vscode-foreground: #cccccc; --vscode-font-family: &quot;Segoe UI&quot;, sans-serif;" lang="en">`);
  });

  it('adds the theme classes and data attributes to <body> beside the panel look', () => {
    expect(page).toMatch(/<body class="vscode-dark" data-vscode-theme-kind="vscode-dark" data-vscode-theme-id="Test &quot;Dark&quot;" data-style="glass" data-detail="compact" data-review="auto">/);
  });

  it('puts the default styles first in <head>, under the nonce the CSP allows, so the panel stylesheet overrides them', () => {
    const defaults = page.indexOf('<style id="_defaultStyles" nonce="n0nce">body { margin: 0; }</style>');
    expect(defaults).toBeGreaterThan(page.indexOf('<head>'));
    expect(defaults).toBeLessThan(page.indexOf('<link rel="stylesheet"'));
    expect(page).toContain(`script-src 'nonce-n0nce'`);
  });

  it('refuses markup it cannot place the theme in', () => {
    expect(() => themedPage('<div></div>', THEME, 'n0nce')).toThrow(/no <html>, <head> or <body>/);
  });
});

describe('the captured themes', () => {
  it('has a dump for every theme the suites screenshot, with its kind and variables', () => {
    for (const slug of THEME_SLUGS) {
      const dump = themeOf(slug);
      expect(dump.bodyClasses, slug).toContain(slug === 'high-contrast-light' ? 'vscode-high-contrast-light' : `vscode-${slug}`);
      expect(dump.htmlStyle, slug).toMatch(/--vscode-sideBar-background: #[0-9a-f]+;/i);
      expect(dump.defaultStyles, slug).toContain('@layer vscode-default');
    }
  });
});
