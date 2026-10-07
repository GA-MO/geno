import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Look } from './messages.js';
import { pageMarkup } from './page-markup.js';

/**
 * A webview page running `entry` from dist, with the panel's styles and the diagram chunk's address. `look`
 * becomes the body's `data-style` and `data-detail`, so the first frame already has the look the page keys on.
 *
 * The policy: scripts only with the page's nonce, which a dynamic import of the diagram chunk inherits;
 * stylesheets from dist, and style elements only with the nonce, which mermaid's are given. Style attributes
 * are allowed because mermaid's SVG carries its sizes and node styles in them and measures labels with them in
 * place. The panel never parses model text as markup and mermaid's output is sanitized, and nothing can be
 * fetched from a style, since everything but dist is refused. Images load only from the webview's own roots, dist
 * and the workspace folders, and as data URLs the panel draws itself for attachment thumbnails, so a remote image
 * in an answer never loads.
 */
export function pageHtml(webview: vscode.Webview, dist: vscode.Uri, entry: string, look?: Look): string {
  const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(dist, file)).toString();
  return pageMarkup({ cspSource: webview.cspSource, nonce: randomBytes(16).toString('base64'), uri, entry, look });
}
