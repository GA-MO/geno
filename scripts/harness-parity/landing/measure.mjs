// Measures one landing page in headless Chrome over the DevTools protocol, on the Mac's GPU: what the brief asks for,
// how it holds up at 375 and 1280, and how its motion behaves. Saves the screenshots the judge and the vote page use.
// Raw facts only: checks.mjs decides what passes. cdnjs files are served from one in-memory copy, so a page's load
// time does not depend on the network.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { connect, launch, serve } from '../page.mjs';
import { briefFacts, call, findHero, gsapFacts, init, isolateCanvas, layoutFacts, loseContext, vitals, webglFacts } from './inpage.mjs';
import { decodePng, luma, meanDiff, stats } from './png.mjs';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false };
const PHONE = { width: 375, height: 812, deviceScaleFactor: 2, mobile: true };
const CALL_MS = 30_000;
const MAX_TILES = 18;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cdnFiles = new Map();

/** Removes a Chrome profile; Chrome's helper processes can still be writing into it for a moment after it exits. */
export async function removeDir(dir) {
  for (let i = 0; ; i++) {
    try {
      return rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      if (i >= 25) throw error;
      await wait(200);
    }
  }
}

async function fromCdn(url) {
  if (!cdnFiles.has(url)) {
    // Only a good copy is kept, so one failed fetch does not fail every later page that loads the file.
    const file = (async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`cdnjs answered ${res.status}`);
      return { status: res.status, type: res.headers.get('content-type') ?? 'text/javascript', body: Buffer.from(await res.arrayBuffer()).toString('base64') };
    })();
    file.catch(() => cdnFiles.delete(url));
    cdnFiles.set(url, file);
  }
  return cdnFiles.get(url);
}

/** One browser tab on one page: every call times out, so a page that hangs fails its session instead of the run. */
async function openTab(dir, profileNear) {
  const server = await serve(dir);
  const { chrome, profile, wsUrl } = await launch(profileNear);
  const cdp = await connect(wsUrl);
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  const log = { console: [], requests: new Set(), dialogs: [], storage: new Set(), phase: 'load', away: undefined };
  const send = (method, params = {}) => Promise.race([cdp.send(method, params), wait(CALL_MS).then(() => Promise.reject(new Error(`the page stopped answering (${method})`)))]);
  cdp.on((msg) => {
    const p = msg.params;
    if (msg.method === 'Runtime.exceptionThrown') log.console.push([log.phase, `uncaught ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`.split('\n')[0]]);
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(p.type)) log.console.push([log.phase, `console.${p.type}: ${p.args.map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 200)]);
    if (msg.method === 'Log.entryAdded' && p.entry.level === 'error' && !/favicon\.ico/.test(p.entry.url ?? '')) log.console.push([log.phase, `${p.entry.text}${p.entry.url ? ` ${p.entry.url}` : ''}`.slice(0, 200)]);
    if (msg.method === 'Network.requestWillBeSent' && !/^(data|blob):/.test(p.request.url) && !/\/favicon\.ico$/.test(p.request.url)) log.requests.add(p.request.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, ''));
    if (msg.method === 'Runtime.bindingCalled' && p.name === '__hpStorage') log.storage.add(p.payload);
    if (msg.method === 'Page.javascriptDialogOpening') {
      log.dialogs.push(`${p.type}: ${p.message.slice(0, 80)}`);
      cdp.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    }
    if (msg.method === 'Page.frameNavigated' && !p.frame.parentId && !p.frame.url.startsWith(url.replace('/index.html', '')) && p.frame.url !== 'about:blank') log.away = p.frame.url;
    if (msg.method === 'Fetch.requestPaused') {
      fromCdn(p.request.url)
        .then((f) => cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: f.status, responseHeaders: [{ name: 'content-type', value: f.type }, { name: 'access-control-allow-origin', value: '*' }], body: f.body }))
        .catch(() => cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'Failed' }).catch(() => {}));
    }
  });
  for (const domain of ['Runtime', 'Page', 'Network', 'Log']) await send(`${domain}.enable`);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*://cdnjs.cloudflare.com/*', requestStage: 'Request' }] });
  await send('Runtime.addBinding', { name: '__hpStorage' });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: call(init) });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text);
    if (log.away) throw new Error(`the page navigated away to ${log.away}`);
    return r.result.value;
  };
  const tab = {
    log,
    evaluate,
    run: (fn, arg) => evaluate(call(fn, arg)),
    async open(viewport, { reducedMotion = false } = {}) {
      await send('Emulation.setDeviceMetricsOverride', viewport);
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' }] });
      await send('Emulation.setTouchEmulationEnabled', { enabled: viewport.mobile });
      log.away = undefined;
      await send('Page.navigate', { url });
    },
    async shot(file, format = 'jpeg') {
      const r = await send('Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality: 72 } : {}) });
      const buf = Buffer.from(r.data, 'base64');
      if (file) writeFileSync(file, buf);
      return buf;
    },
    async shotClip(file, clip) {
      const r = await send('Page.captureScreenshot', { format: 'jpeg', quality: 72, clip: { ...clip, scale: 1 }, captureBeyondViewport: true });
      writeFileSync(file, Buffer.from(r.data, 'base64'));
    },
    mouse: (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }),
    wheel: (deltaY, x = 200, y = 300) => send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY }),
    scrollTo: (top) => evaluate(`window.scrollTo({ top: ${top}, behavior: 'instant' }), new Promise((r) => setTimeout(() => r(scrollY), 60))`),
    async close() {
      cdp.close();
      const exited = new Promise((r) => chrome.once('exit', r));
      chrome.kill();
      await exited;
      server.close();
      await removeDir(profile);
    },
  };
  return tab;
}

/** Scrolls the page top to bottom by wheel, as a reader does, so every reveal runs; returns to the top. */
async function wheelThrough(tab, { step = 120, every = 70 } = {}) {
  await tab.scrollTo(0);
  for (let i = 0; i < 200; i++) {
    await tab.wheel(step);
    await wait(every);
    const done = await tab.evaluate('scrollY + innerHeight >= document.scrollingElement.scrollHeight - 2');
    if (done) break;
  }
  await wait(600);
}

async function tiles(tab, dir, prefix, viewportHeight) {
  const height = await tab.evaluate('document.scrollingElement.scrollHeight');
  const files = [];
  for (let i = 0, top = 0; i < MAX_TILES && top < height; i++, top += viewportHeight) {
    await tab.scrollTo(top);
    await wait(500);
    const file = path.join(dir, `${prefix}-${String(i).padStart(2, '0')}.jpg`);
    await tab.shot(file);
    files.push(path.basename(file));
  }
  await tab.scrollTo(0);
  return files;
}

async function contrast(tab) {
  if (!(await tab.evaluate('typeof axe !== "undefined"'))) await tab.evaluate(AXE);
  return tab.evaluate(`axe.run(document, { runOnly: { type: 'rule', values: ['color-contrast'] }, resultTypes: ['violations'] }).then((r) => {
    const nodes = r.violations.flatMap((v) => v.nodes);
    return { violations: nodes.length, examples: nodes.slice(0, 5).map((n) => n.target.join(' ') + ': ' + (n.any[0]?.message ?? '').slice(0, 120)) };
  })`);
}

/** The hero's own pixels (everything but canvases hidden, on black), as luma samples of each rect in page pixels. */
async function heroPixels(tab, rects) {
  await tab.run(isolateCanvas, true);
  await wait(120);
  const img = decodePng(await tab.shot(undefined, 'png'));
  await tab.run(isolateCanvas, false);
  const scale = img.width / DESKTOP.width;
  return rects.flatMap((r) => luma(img, { x: r.x * scale, y: r.y * scale, width: r.width * scale, height: Math.min(r.height, DESKTOP.height - r.y) * scale }));
}

const round1 = (n) => Math.round(n * 10) / 10;

async function desktopSession(tab, shots, out) {
  await tab.open(DESKTOP);
  await wait(2500);
  out.brief = await tab.run(briefFacts);
  out.webgl = await tab.run(webglFacts);
  const rect = await tab.run(findHero);
  out.hero = { found: rect !== undefined, context: rect?.context ?? null };
  if (rect) {
    // Pointer reaction: the frame change while the pointer crosses the hero, against the change over the same time
    // with the pointer still. A shader that only animates with time changes about as much both ways.
    const at = (fx, fy) => [rect.x + rect.width * fx, Math.min(rect.y + rect.height * fy, DESKTOP.height - 10)];
    const glide = async (from, to) => {
      for (let i = 1; i <= 10; i++) await tab.mouse(from[0] + ((to[0] - from[0]) * i) / 10, from[1] + ((to[1] - from[1]) * i) / 10);
    };
    const p1 = at(0.2, 0.35);
    const p2 = at(0.8, 0.6);
    // Compared where the pointer was and went, so a local ripple is not drowned by time animating the whole hero.
    const near = [p1, p2].map(([x, y]) => ({ x: x - rect.width * 0.125, y: Math.max(0, y - rect.height * 0.15), width: rect.width * 0.25, height: rect.height * 0.3 }));
    await tab.mouse(...p1);
    await wait(700);
    const a = await heroPixels(tab, near);
    await glide(p1, p2);
    await wait(700);
    const b = await heroPixels(tab, near);
    await wait(700);
    const c = await heroPixels(tab, near);
    Object.assign(out.hero, { ...stats(await heroPixels(tab, [rect])), pointerDiff: round1(meanDiff(a, b)), timeDiff: round1(meanDiff(b, c)) });
  }
  tab.log.phase = 'scroll';
  await tab.scrollTo(0);
  await wait(400);
  await tab.evaluate('window.__hp.startFrames()');
  await wheelThrough(tab, { step: 100, every: 60 });
  const frames = await tab.evaluate('window.__hp.stopFrames()');
  const sorted = [...frames].sort((x, y) => x - y);
  out.frames = { count: frames.length, p95: round1(sorted[Math.floor(sorted.length * 0.95)] ?? 0), over33: frames.filter((f) => f > 33.4).length };
  out.gsap = await tab.run(gsapFacts);
  await tab.scrollTo(0);
  await wait(800);
  const height = await tab.evaluate('document.scrollingElement.scrollHeight - innerHeight');
  for (let i = 0; i < 10; i++) {
    await tab.wheel(100, 640, 400);
    await wait(16);
  }
  await wait(2000);
  out.wheel = { expected: Math.min(1000, height), moved: Math.round(await tab.evaluate('scrollY')) };
  out.layout1280 = await tab.run(layoutFacts);
  out.layout1280.contrast = await contrast(tab);
  out.vitals1280 = await tab.run(vitals);
  out.tiles1280 = await tiles(tab, shots, 'desktop', DESKTOP.height);
  if (out.layout1280.cards) await tab.shotClip(path.join(shots, 'cards-1280.jpg'), { x: 0, y: out.layout1280.cards.top - 16, width: DESKTOP.width, height: out.layout1280.cards.bottom - out.layout1280.cards.top + 32 });
  if (rect) {
    tab.log.phase = 'lost-context';
    const before = await heroPixels(tab, [rect]);
    const lost = await tab.run(loseContext);
    const after = await heroPixels(tab, [rect]);
    out.restore = { ...lost, before: stats(before), after: stats(after) };
  }
}

/** The motion strip for the judge: two frames of the load, two of the pointer on the hero, three of the scroll. */
async function motionSession(tab, shots, out) {
  tab.log.phase = 'load';
  await tab.open(DESKTOP);
  const files = [];
  const frame = async () => {
    const file = path.join(shots, `motion-${String(files.length).padStart(2, '0')}.jpg`);
    await tab.shot(file);
    files.push(path.basename(file));
  };
  await wait(300);
  await frame();
  await wait(1200);
  await frame();
  await tab.evaluate('window.__hp.startMovers()');
  await tab.mouse(380, 300);
  await wait(500);
  for (let i = 1; i <= 10; i++) await tab.mouse(380 + 52 * i, 300 + 18 * i);
  await wait(250);
  await frame();
  await wait(500);
  await frame();
  const height = await tab.evaluate('document.scrollingElement.scrollHeight - innerHeight');
  for (const f of [1 / 3, 2 / 3, 1]) {
    await tab.scrollTo(Math.round(height * f));
    await tab.wheel(1);
    await wait(1000);
    await frame();
  }
  out.normalMovers = await tab.evaluate('window.__hp.stopMovers()');
  out.motion = files;
}

async function reducedSession(tab, _shots, out) {
  tab.log.phase = 'reduced';
  await tab.open(DESKTOP, { reducedMotion: true });
  await wait(2500);
  const rect = await tab.run(findHero);
  let canvasDiff = 0;
  if (rect) {
    const a = await heroPixels(tab, [rect]);
    await wait(1000);
    const b = await heroPixels(tab, [rect]);
    canvasDiff = round1(meanDiff(a, b));
  }
  await tab.evaluate('window.__hp.startMovers()');
  await wheelThrough(tab);
  out.reduced = { canvasDiff, movers: await tab.evaluate('window.__hp.stopMovers()') };
}

async function phoneSession(tab, shots, out) {
  tab.log.phase = 'phone';
  await tab.open(PHONE);
  await wait(3000);
  out.vitals375 = await tab.run(vitals);
  await wheelThrough(tab);
  out.layout375 = await tab.run(layoutFacts);
  out.layout375.contrast = await contrast(tab);
  out.tiles375 = await tiles(tab, shots, 'phone', PHONE.height);
  if (out.layout375.cards) await tab.shotClip(path.join(shots, 'cards-375.jpg'), { x: 0, y: out.layout375.cards.top - 16, width: PHONE.width, height: out.layout375.cards.bottom - out.layout375.cards.top + 32 });
}

/**
 * Every fact checks.mjs reads, for the page at `dir`/index.html; screenshots go to `shots`. A session that fails
 * (the page hangs, navigates away, throws in a probe) is recorded in `errors` and the next one still runs.
 */
export async function measure(dir, shots) {
  mkdirSync(shots, { recursive: true });
  if (!existsSync(path.join(dir, 'index.html'))) {
    const out = { fatal: 'there is no index.html' };
    writeFileSync(path.join(shots, 'measures.json'), `${JSON.stringify(out, null, 2)}\n`);
    return out;
  }
  const near = mkdtempSync(path.join(shots, '.chrome-'));
  const out = { errors: {} };
  const logs = [];
  const sessions = { desktop: desktopSession, motion: motionSession, reduced: reducedSession, phone: phoneSession };
  try {
    // A fresh browser for each session, so a page that hung one session cannot hang the next.
    for (const [name, session] of Object.entries(sessions)) {
      const tab = await openTab(dir, near);
      logs.push(tab.log);
      try {
        await session(tab, shots, out);
        if (name === 'phone') out.stored = await tab.evaluate('localStorage.length + sessionStorage.length > 0 || document.cookie !== ""');
      } catch (error) {
        out.errors[name] = error.message;
      } finally {
        await tab.close();
      }
    }
  } finally {
    await removeDir(near);
  }
  const all = (key) => logs.flatMap((l) => [...l[key]]);
  out.console = [...new Set(all('console').filter(([phase]) => phase !== 'lost-context').map(([, text]) => text))].slice(0, 20);
  out.requests = [...new Set(all('requests'))];
  out.dialogs = all('dialogs');
  out.storage = [...new Set(all('storage'))];
  writeFileSync(path.join(shots, 'measures.json'), `${JSON.stringify(out, null, 2)}\n`);
  return out;
}
