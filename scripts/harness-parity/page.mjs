// Opens a workspace's page in headless Chrome over the DevTools protocol, for hidden checks that need the page as a
// phone shows it. No dependency: Node's WebSocket and a static file server.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.woff2': 'font/woff2' };

function serve(root) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(root, rel);
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!file.startsWith(root) || !existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function launch(near) {
  const profile = mkdtempSync(path.join(near, '.chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  const port = readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  return { chrome, profile, wsUrl: page.webSocketDebuggerUrl };
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let id = 0;
  const waiting = new Map();
  const listeners = [];
  socket.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) {
      const w = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(msg.error.message));
      else w.resolve(msg.result);
    } else for (const l of listeners) l(msg);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    waiting.set(++id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return new Promise((resolve) => (socket.onopen = () => resolve({ send, on: (l) => listeners.push(l), close: () => socket.close() })));
}

/**
 * Runs `fn(page)` against `index.html` of `root` at a phone's width. `page.eval(js)` returns the value of an
 * expression; `page.errors` collects uncaught exceptions; `page.reload()` keeps localStorage.
 */
export async function withPage(root, fn, { width = 375, height = 812 } = {}) {
  const server = await serve(root);
  const { chrome, profile, wsUrl } = await launch(path.dirname(root));
  const cdp = await connect(wsUrl);
  const errors = [];
  cdp.on((msg) => {
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  });
  try {
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true });
    const url = `http://127.0.0.1:${server.address().port}/index.html`;
    const settle = () => new Promise((r) => setTimeout(r, 2500));
    const page = {
      url,
      errors,
      async eval(expression) {
        const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      },
      async reload() {
        await cdp.send('Page.reload', { ignoreCache: true });
        await settle();
      },
    };
    await cdp.send('Page.navigate', { url });
    await settle();
    return await fn(page);
  } finally {
    cdp.close();
    const exited = new Promise((r) => chrome.once('exit', r));
    chrome.kill();
    await exited;
    server.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

/** The checks every page task shares: it loads at 375px with no uncaught error and no sideways scroll. */
export const PAGE_BASICS = `({ width: document.scrollingElement.scrollWidth, text: document.body.innerText.length })`;
