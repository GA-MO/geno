import { createSocket } from 'node:dgram';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runTests } from '@vscode/test-electron';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectWindow, evaluate, webview, type Window } from './cdp.js';
import { cachePath, root, setUp } from './launch.js';
import { freePort } from './screenshot.js';
import { frameCsp, frameDocument, WIDGET_SANDBOX } from '../src/chat/widget-frame.js';
import { ATTACK_NAMES, ATTACKS } from './suite/widget-attacks.js';
import { bypassCsp, inWidget } from './widget-cdp.js';

/**
 * Each sandbox escape, proven blocked (green) and then let through against a weakened sandbox (red), so the red run
 * shows the specific defense is load-bearing. Three defenses are at work, each with its own red:
 *   - the frame's own CSP (no network) stops fetch, a remote img and a form post: turn the CSP off and they reach the
 *     recording server;
 *   - the `sandbox` attribute stops parent.document and localStorage (no allow-same-origin), top.location (no
 *     allow-top-navigation) and window.open (no allow-popups): grant the token and the attack stops being blocked;
 *   - a line of the frame's bootstrap deletes RTCPeerConnection, since no CSP covers WebRTC: a frame without that line,
 *     in the very same real sandbox, leaks a STUN packet.
 */

const EXTENSION = 'g-code.g-code';
const PANEL = '.transcript';
const NONCE = 'U0VDVVJJVFlfTk9OQ0U';
const THEME = { scheme: 'dark' as const, vars: { '--fg': '#dcdcdc', '--bg': '#1e1e20', '--font': 'sans-serif', '--chart-1': '#3987e5' } };

let debugPort = 0;
let window: Window | undefined;
let url = '';
let udpPort = 0;
const hits = new Set<string>();
const udp: string[] = [];
const out: Record<string, unknown> = {};

async function bodyOf(req: IncomingMessage): Promise<string> {
  let b = '';
  for await (const c of req) b += c;
  return b;
}

const RTC = (port: number) =>
  `<p>rtc</p><script>try { const p = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${port}' }] }); p.createDataChannel('x'); p.createOffer().then((o) => p.setLocalDescription(o)).then(() => document.body.setAttribute('data-attack', 'offer'), () => {}); } catch (e) { document.body.setAttribute('data-attack', 'threw ' + e.name); }</script>`;

/** The same RTC widget without the bootstrap's guard: a plain page under the real policy, to show the guard is the defense. */
const unguardedRtc = (port: number): string =>
  `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${frameCsp(NONCE)}"><body>${RTC(port).replace('<script>', `<script nonce="${NONCE}">`)}</body>`;

const mountDoc = (view: any, name: string, doc: string, sandbox: string | null) =>
  evaluate(
    view,
    `(() => {
      const nonce = doc.querySelector('script[nonce]').nonce;
      const f = doc.createElement('iframe');
      f.name = ${JSON.stringify(name)};
      if (${JSON.stringify(sandbox)} !== null) f.setAttribute('sandbox', ${JSON.stringify(sandbox)});
      f.style.cssText = 'width:100%;height:80px;border:0';
      f.srcdoc = ${JSON.stringify(doc)}.replaceAll(${JSON.stringify(NONCE)}, nonce);
      // Not in .transcript: the panel's next render, such as after a window focus change, removes what it did not build.
      (doc.getElementById('attack-frames') ?? doc.body.appendChild(Object.assign(doc.createElement('div'), { id: 'attack-frames' }))).append(f);
      return 1;
    })()`,
  );
const mount = (view: any, name: string, html: string, sandbox: string | null) => mountDoc(view, name, frameDocument({ html, nonce: NONCE, theme: THEME }), sandbox);

/** A weak (allow-same-origin) frame keeps the panel's origin, so the panel can read its outcome directly. */
const weakOutcome = (view: any, name: string) =>
  evaluate<string | null>(view, `(() => { const f = doc.querySelector('iframe[name=${JSON.stringify(name)}]'); try { return f.contentDocument?.body?.getAttribute('data-attack') ?? 'navigated'; } catch (e) { return 'unreadable ' + e.name; } })()`);

async function drive(): Promise<void> {
  window ??= await connectWindow(debugPort);
  const view = await webview(window, EXTENSION, PANEL);
  await evaluate(view, `(doc.body.removeAttribute('data-pwned'), doc.defaultView.localStorage.removeItem('geno-pwned'), 1)`);

  // Green: the real sandbox and the frame's own CSP.
  for (const name of ATTACK_NAMES) await mount(view, `strong-${name}`, ATTACKS[name](url), WIDGET_SANDBOX);
  await mount(view, 'strong-rtc', RTC(udpPort), WIDGET_SANDBOX);
  await new Promise((r) => setTimeout(r, 4000));
  const strong: Record<string, unknown> = {};
  for (const name of ATTACK_NAMES) strong[name] = await inWidget(window, `strong-${name}`, `document.body.getAttribute('data-attack')`);
  out['strong'] = strong;
  out["strongRtc"] = await inWidget(window, 'strong-rtc', `document.body.getAttribute('data-attack')`);
  out['strongHits'] = [...hits];
  out['strongUdp'] = [...udp];
  out['strongPanel'] = await evaluate(view, `[doc.body.getAttribute('data-pwned'), doc.defaultView.localStorage.getItem('geno-pwned')]`);

  // Red: weaken the sandbox and turn off every CSP, and run an unguarded RTC frame under the real policy.
  hits.clear();
  udp.length = 0;
  await bypassCsp(window, view);
  // The strongest weakening: remove the sandbox attribute entirely, so only the frame's own CSP (now off) and the host remain.
  for (const name of ATTACK_NAMES) await mount(view, `weak-${name}`, ATTACKS[name](url), null);
  await mountDoc(view, 'unguarded-rtc', unguardedRtc(udpPort), WIDGET_SANDBOX);
  await new Promise((r) => setTimeout(r, 6000));
  const weak: Record<string, unknown> = {};
  for (const name of ATTACK_NAMES) weak[name] = await weakOutcome(view, `weak-${name}`);
  out['weak'] = weak;
  out['weakHits'] = [...hits];
  out['weakUdp'] = [...udp];
  out['weakPanel'] = await evaluate(view, `[doc.body.getAttribute('data-pwned'), doc.defaultView.localStorage.getItem('geno-pwned')]`);
}

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> = {
  'POST /ui': async (_req, res) => {
    try {
      await drive();
      res.writeHead(200).end('');
    } catch (e) {
      out['error'] = String((e as Error).stack);
      res.writeHead(500).end(String(e));
    }
  },
};
const fake = createServer((req, res) => {
  if (req.url?.startsWith('/attack/')) {
    hits.add(`${req.method} ${req.url}`);
    return void res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  }
  const r = ROUTES[`${req.method} ${req.url}`];
  if (!r) res.writeHead(404).end();
  else void r(req, res);
});
const socket = createSocket('udp4');
socket.on('message', () => udp.push('stun'));
beforeAll(async () => {
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
  udpPort = socket.address().port;
});
afterAll(() => {
  window?.browser.close();
  socket.close();
  return new Promise<void>((r) => fake.close(() => r()));
});

describe('a widget cannot escape its sandbox', () => {
  it('blocks fetch, a remote img, parent.document, top.location, localStorage, a form post, window.open and WebRTC, each proven with a red run', async () => {
    const { home, suite, launchArgs } = await setUp('widget-security', { 'a.txt': 'x' }, {});
    debugPort = await freePort();
    url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    const code = await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: suite,
      cachePath,
      ...(process.env['GCODE_VSCODE_VERSION'] ? { version: process.env['GCODE_VSCODE_VERSION'] } : {}),
      launchArgs: [...launchArgs, `--remote-debugging-port=${debugPort}`],
      extensionTestsEnv: { GCODE_HOME: home, GCODE_PROVIDER: 'modelstudio', GCODE_MODEL: 'qwen3.8-flash', DASHSCOPE_API_KEY: 'sk-fake', DASHSCOPE_BASE_URL: url, GCODE_FAKE_MODEL: url },
    });
    expect(code, out['error'] as string | undefined).toBe(0);
    if (process.env['WIDGET_SECURITY_DUMP']) console.log('DUMP', JSON.stringify(out, null, 1));

    const strong = out['strong'] as Record<string, string | null>;
    const weak = out['weak'] as Record<string, string | null>;
    const strongHits = out['strongHits'] as string[];
    const weakHits = new Set(out['weakHits'] as string[]);
    const strongPanel = out['strongPanel'] as (string | null)[];
    const weakPanel = out['weakPanel'] as (string | null)[];

    // 1. CSP stops the network attacks: nothing reaches the server with the real policy; each does with the policy off.
    expect(strongHits, 'the real policy lets nothing reach the server').toEqual([]);
    expect(strong['fetch']).toBe('rejected: Failed to fetch');
    expect(strong['img'], 'the img loads nothing: its onload never ran').toBe('ran');
    for (const request of ['GET /attack/fetch', 'GET /attack/img']) {
      expect(weakHits, `with the CSP off, ${request} reaches the server (red run)`).toContain(request);
    }
    // form-action 'none' blocks the submission: the real frame stays put, the policy-off frame submits and navigates away.
    expect(strong['form'], 'the form submission is blocked, so the frame stays in place').toBe('ran');
    expect(weak['form'], 'with the CSP off the form submits and the frame navigates (red run)').toBe('navigated');

    // 2. The sandbox keeps the frame a null origin: parent.document and localStorage throw, and never touch the panel.
    expect(strong['parent-document']).toBe('threw SecurityError');
    expect(strong['local-storage']).toBe('threw SecurityError');
    expect(strongPanel, 'the real sandbox left no mark on the panel').toEqual([null, null]);
    expect(weakPanel, 'without the sandbox both reach the panel (red run)').toEqual(['parent-document', 'local-storage']);
    expect(weak['parent-document'], 'and the attack itself now runs').toBe('ran');
    expect(weak['local-storage']).toBe('ran');

    // 3. Top navigation and window.open are blocked in depth: the sandbox omits allow-top-navigation and allow-popups
    //    (asserted statically in widget-frame.test.ts), and the VS Code webview host also refuses both for every frame
    //    it hosts. So they stay blocked even once the sandbox attribute is removed, which is the red run the host allows:
    //    the maximally weakened frame still cannot navigate the top or open a window.
    expect(strong['top-location'], 'the sandbox blocks top navigation').toBe('threw SecurityError');
    expect(weak['top-location'], 'and the webview host blocks it even without the sandbox (red run: still blocked, host-enforced)').toBe('threw SecurityError');
    expect(strong['window-open'], 'window.open returns null in the sandbox, so the attack throws').toBe('threw Error');
    expect(weak['window-open'], 'and the host returns null even without the sandbox (red run: still blocked, host-enforced)').toBe('threw Error');

    // 4. The bootstrap's guard is what stops WebRTC: deleted in the real frame, a STUN packet leaves an unguarded one.
    expect(strong['rtc'] ?? out['strongRtc'], 'RTCPeerConnection is gone from the real frame').toContain('threw');
    expect(out['strongUdp'], 'no STUN packet left the guarded frames').toEqual([]);
    expect(out['weakUdp'], 'the unguarded frame leaks a STUN packet (red run)').not.toEqual([]);
  }, 600_000);
});
