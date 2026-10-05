import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

/**
 * A webview page running `entry` from dist, with the panel's styles and the diagram chunk's address.
 *
 * The policy: scripts only with the page's nonce, which a dynamic import of the diagram chunk inherits;
 * stylesheets from dist, and style elements only with the nonce, which mermaid's are given. Style attributes
 * are allowed because mermaid's SVG carries its sizes and node styles in them and measures labels with them in
 * place. The panel never parses model text as markup and mermaid's output is sanitized, and nothing can be
 * fetched from a style, since everything but dist is refused.
 */
export function pageHtml(webview: vscode.Webview, dist: vscode.Uri, entry: string): string {
  const nonce = randomBytes(16).toString('base64');
  const { cspSource } = webview;
  const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(dist, file));
  // data-manual keeps Prism from scanning the page on load; the panel highlights code blocks itself.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; font-src ${cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('webview.css')}">
</head><body><script nonce="${nonce}" src="${uri(entry)}" data-diagrams="${uri('diagram/render.js')}" data-manual></script></body></html>`;
}
