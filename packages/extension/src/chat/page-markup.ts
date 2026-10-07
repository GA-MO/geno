import type { Look } from './messages.js';

/** What a webview page needs from its host: the source its CSP names, a fresh nonce, and the address of a dist file. */
export type PageHost = {
  readonly cspSource: string;
  readonly nonce: string;
  readonly uri: (file: string) => string;
  readonly entry: string;
  readonly look?: Look | undefined;
};

/** The page markup pageHtml serves, apart from VS Code, so a browser test loads the same page under the same policy. */
export function pageMarkup({ cspSource, nonce, uri, entry, look }: PageHost): string {
  // data-manual keeps Prism from scanning the page on load; the panel highlights code blocks itself.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; font-src ${cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('webview.css')}">
</head><body${look === undefined ? '' : ` data-style="${look.style}" data-detail="${look.detail}" data-review="${look.review}"`}><script nonce="${nonce}" src="${uri(entry)}" data-diagrams="${uri('diagram/render.js')}" data-manual></script></body></html>`;
}
