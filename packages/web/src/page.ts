import { themedPage, type ThemeDump } from '../../extension/test/webview/theme.js';
import dark from '../../extension/test/webview/themes/dark.json' with { type: 'json' };
import light from '../../extension/test/webview/themes/light.json' with { type: 'json' };

export type Theme = 'dark' | 'light';

const THEMES: Readonly<Record<Theme, ThemeDump>> = { dark, light };

export type BrowserPage = {
  /** The webview's html as the chat host set it, under VS Code's CSP and with a nonce of its own. */
  readonly html: string;
  readonly nonce: string;
  readonly origin: string;
  readonly view: string;
  readonly theme: Theme;
};

const replaceOnce = (text: string, anchor: string, replacement: string): string => {
  if (!text.includes(anchor)) throw new Error(`the webview page has no ${anchor}`);
  return text.replace(anchor, replacement);
};

/**
 * The webview's page as a browser tab: a fresh nonce, the theme VS Code would have put on it, the side bar's color
 * behind it, and the web client before the panel's own script, standing in for VS Code's preload. Its CSP gains only
 * connect-src for this server, which the client's message stream and posts need.
 */
export function browserPage({ html, nonce, origin, view, theme }: BrowserPage): string {
  const old = /'nonce-([^']+)'/.exec(html)?.[1];
  if (old === undefined) throw new Error('the webview page has no nonce');
  const fresh = html.replaceAll(old, nonce);
  const connected = replaceOnce(fresh, "default-src 'none';", `default-src 'none'; connect-src ${origin};`);
  const themed = themedPage(connected, THEMES[theme], nonce);
  const client = `<style nonce="${nonce}">html { background: var(--vscode-sideBar-background); height: 100%; }</style><script nonce="${nonce}" src="${origin}/web-client.js" data-view="${view}"></script>`;
  return replaceOnce(themed, '</head>', `${client}</head>`);
}
