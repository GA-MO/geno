import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as vscode from 'vscode';
import type { SignInBrowser } from './mcp-tokens.js';

/** How long a sign-in waits for the user to finish it in the browser. */
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

const DONE_PAGE = '<!doctype html><meta charset="utf-8"><title>Geno</title><p>Signed in. You can close this tab and go back to VS Code.</p>';

/**
 * Opens the page in the user's browser. The tests set GCODE_OPEN_EXTERNAL to `fetch`, which loads the page and
 * follows its redirects as a browser would, without showing it.
 */
async function openPage(url: URL): Promise<void> {
  if (process.env['GCODE_OPEN_EXTERNAL'] === 'fetch') {
    await fetch(url);
    return;
  }
  if (!(await vscode.env.openExternal(vscode.Uri.parse(url.href, true)))) throw new Error('the browser did not open');
}

/**
 * The browser side of one sign-in, as Claude Code does it: a one-shot server on the loopback address takes the
 * redirect back. asExternalUri makes that address one the user's browser reaches when VS Code runs remotely.
 * `close` ends it whether or not the redirect came.
 */
export async function loopbackBrowser(cancel: vscode.CancellationToken): Promise<SignInBrowser & { close(): void }> {
  let arrived: (query: URLSearchParams) => void = () => {};
  const back = new Promise<URLSearchParams>((resolve) => (arrived = resolve));
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(DONE_PAGE);
    arrived(url.searchParams);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const local = vscode.Uri.parse(`http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`);
  const redirectUrl = (await vscode.env.asExternalUri(local)).toString(true);
  return {
    redirectUrl,
    async authorize(url) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancelled: vscode.Disposable | undefined;
      const stopped = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('the sign-in was not finished in time')), SIGN_IN_TIMEOUT_MS);
        cancelled = cancel.onCancellationRequested(() => reject(new vscode.CancellationError()));
      });
      try {
        return await Promise.race([openPage(url).then(() => back), stopped]);
      } finally {
        clearTimeout(timer);
        cancelled?.dispose();
      }
    },
    close: () => (server.closeAllConnections(), server.close()),
  };
}
