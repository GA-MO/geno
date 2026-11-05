// Functions that run inside the page under test. Each is sent as its source text (`call(fn, arg)`), so none may
// close over anything in this module.

export const call = (fn, arg) => `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`;

/** Runs before the page's own scripts on every document: records storage writes, WebGL use, vitals and frames. */
export function init() {
  const hp = (window.__hp = { storage: [], contexts: [], compileFailed: [], linkFailed: [], linked: 0, lcp: 0, shifts: [], frames: undefined, movers: new Map() });
  const report = (what) => {
    hp.storage.push(what);
    window.__hpStorage?.(what);
  };
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    report(`${this === window.sessionStorage ? 'sessionStorage' : 'localStorage'}.setItem("${String(key).slice(0, 40)}")`);
    return setItem.call(this, key, value);
  };
  const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  Object.defineProperty(Document.prototype, 'cookie', {
    configurable: true,
    get() {
      return cookie.get.call(this);
    },
    set(value) {
      report(`document.cookie = "${String(value).split('=')[0].slice(0, 40)}=…"`);
      cookie.set.call(this, value);
    },
  });
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const ctx = getContext.call(this, type, ...rest);
    if (/webgl/i.test(String(type)) && !hp.contexts.some((c) => c.ctx === ctx && ctx !== null)) hp.contexts.push({ type: String(type), canvas: this, ctx });
    return ctx;
  };
  for (const proto of [window.WebGL2RenderingContext?.prototype, window.WebGLRenderingContext?.prototype]) {
    if (!proto) continue;
    const compile = proto.compileShader;
    proto.compileShader = function (shader) {
      compile.call(this, shader);
      if (!this.isContextLost() && !this.getShaderParameter(shader, this.COMPILE_STATUS)) hp.compileFailed.push(String(this.getShaderInfoLog(shader)).slice(0, 200));
    };
    const link = proto.linkProgram;
    proto.linkProgram = function (program) {
      link.call(this, program);
      if (this.isContextLost()) return;
      if (this.getProgramParameter(program, this.LINK_STATUS)) hp.linked += 1;
      else hp.linkFailed.push(String(this.getProgramInfoLog(program)).slice(0, 200));
    };
  }
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) hp.lcp = e.startTime;
  }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (!e.hadRecentInput) hp.shifts.push([e.startTime, e.value]);
  }).observe({ type: 'layout-shift', buffered: true });
  hp.startFrames = () => {
    const frames = (hp.frames = []);
    let last;
    const tick = (t) => {
      if (hp.frames !== frames) return;
      if (last !== undefined) frames.push(t - last);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  hp.stopFrames = () => {
    const frames = hp.frames ?? [];
    hp.frames = undefined;
    return frames;
  };
  // Every element whose transform takes more than one value while sampling is moving: a reveal, a float, a parallax.
  hp.startMovers = () => {
    const seen = new Map();
    hp.moverTimer = setInterval(() => {
      for (const el of document.body.querySelectorAll('*')) {
        if (el instanceof HTMLCanvasElement) continue;
        const t = getComputedStyle(el).transform;
        const values = seen.get(el) ?? new Set();
        values.add(t);
        seen.set(el, values);
      }
    }, 80);
    hp.movers = seen;
  };
  hp.stopMovers = () => {
    clearInterval(hp.moverTimer);
    const name = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.classList.length ? `.${[...el.classList].slice(0, 2).join('.')}` : ''}`;
    const moving = [...hp.movers].filter(([, values]) => values.size > 1).map(([el]) => name(el));
    const animated = document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getKeyframes?.().some((k) => k.transform !== undefined || k.translate !== undefined || k.rotate !== undefined || k.scale !== undefined)).map((a) => `animation on ${name(a.effect.target)}`);
    return [...new Set([...moving, ...animated])];
  };
}

/** What the brief asks for, read from the DOM: headings with the text under each, subscribe controls, links, all text. */
export function briefFacts() {
  const SKIP = 'script,style,noscript,template';
  const textUnder = (root) => {
    const parts = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!n.parentElement?.closest(SKIP)) parts.push(n.textContent);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };
  const levelOf = (h) => (/^H[1-6]$/.test(h.tagName) ? Number(h.tagName[1]) : Number(h.getAttribute('aria-level') ?? 2));
  const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]')];
  // A heading's section is everything after it up to the next heading of the same or a higher level.
  const sectionOf = (h) => {
    const level = levelOf(h);
    const parts = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    walker.currentNode = h;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        if (headings.includes(n) && levelOf(n) <= level) break;
        continue;
      }
      if (!n.parentElement?.closest(SKIP) && !h.contains(n)) parts.push(n.textContent);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
  };
  const PRICE = /[$€£¥฿]\s?\d+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?\s?(?:USD|EUR|GBP|THB|baht|€|£|฿)/i;
  const controls = [...document.querySelectorAll('a,button,[role=button],input[type=submit],input[type=button]')];
  const labelOf = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  const subscribes = controls.filter((el) => /subscribe/i.test(labelOf(el)));
  const cardOf = (el) => {
    for (let card = el.parentElement; card && card !== document.body; card = card.parentElement) {
      if (!PRICE.test(textUnder(card))) continue;
      return subscribes.filter((s) => card.contains(s)).length === 1 ? card : undefined;
    }
    return undefined;
  };
  return {
    text: textUnder(document.body).slice(0, 40000),
    headings: headings.map((h) => ({ text: textUnder(h), body: sectionOf(h) })),
    subscribes: subscribes.map((el) => {
      const card = cardOf(el);
      return { tag: el.tagName.toLowerCase(), label: labelOf(el), href: el instanceof HTMLAnchorElement ? el.href : null, card: card ? textUnder(card).slice(0, 600) : null };
    }),
    links: [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href, text: labelOf(a).slice(0, 80), download: a.hasAttribute('download') })),
  };
}

/**
 * How the page holds up at the current width, after every reveal has run: sideways scroll, text out of its box, small
 * buttons, the spacing between sections, and how the plan prices are set.
 */
export function layoutFacts() {
  const name = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.classList.length ? `.${[...el.classList].slice(0, 2).join('.')}` : ''}`;
  const shown = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 1 && r.height > 1;
  };
  const clippedBy = (el) => {
    for (let a = el; a && a !== document.body; a = a.parentElement) if (getComputedStyle(a).overflowX !== 'visible') return a;
    return undefined;
  };
  const blockOf = (el) => {
    for (let a = el; a && a !== document.body; a = a.parentElement) if (!['inline', 'contents'].includes(getComputedStyle(a).display)) return a;
    return document.body;
  };
  const overflows = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && overflows.length < 12; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!n.textContent.trim() || !el || el.closest('script,style,noscript,template,svg') || !shown(el)) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0);
    if (rects.length === 0) continue;
    const left = Math.min(...rects.map((r) => r.left));
    const right = Math.max(...rects.map((r) => r.right));
    const sample = n.textContent.trim().slice(0, 50);
    const block = blockOf(el);
    const box = block.getBoundingClientRect();
    const clip = clippedBy(el);
    if (clip !== undefined) {
      const s = getComputedStyle(clip);
      if (/hidden|clip/.test(s.overflowX) && clip.scrollWidth > clip.clientWidth + 1 && s.textOverflow !== 'ellipsis' && box.width > 2) overflows.push(`"${sample}" is cut off in ${name(clip)}`);
    } else if (right > innerWidth + 1 || left < -1) overflows.push(`"${sample}" runs past the screen edge`);
    if (right > box.right + 2 || left < box.left - 2) overflows.push(`"${sample}" runs out of ${name(block)}`);
  }
  const buttonLike = (el) => {
    if (el.matches('button,[role=button],input[type=submit],input[type=button],input[type=reset],summary')) return true;
    if (!(el instanceof HTMLAnchorElement)) return false;
    const s = getComputedStyle(el);
    const bg = s.backgroundColor !== 'rgba(0, 0, 0, 0)' && s.backgroundColor !== 'transparent';
    const border = ['Top', 'Right', 'Bottom', 'Left'].some((side) => parseFloat(s[`border${side}Width`]) > 0 && s[`border${side}Style`] !== 'none');
    return (bg || border || s.backgroundImage !== 'none') && s.display !== 'inline';
  };
  const smallButtons = [...document.querySelectorAll('a,button,[role=button],input,summary')]
    .filter((el) => shown(el) && buttonLike(el))
    .map((el) => ({ el: `${name(el)} "${(el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`, height: Math.round(el.getBoundingClientRect().height * 10) / 10 }))
    .filter((b) => b.height < 44);
  // Sections: the children of <main>, or of <body> when there is none, that take up height and scroll with the page.
  const container = document.querySelector('main') ?? document.body;
  const contentBox = (el) => {
    let top = Infinity;
    let bottom = -Infinity;
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (!n.textContent.trim() || n.parentElement?.closest('script,style,noscript,template')) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.height > 0) {
        top = Math.min(top, r.top);
        bottom = Math.max(bottom, r.bottom);
      }
    }
    for (const m of el.querySelectorAll('img,svg,button,a,input,table')) {
      const r = m.getBoundingClientRect();
      if (r.height > 0 && shown(m)) {
        top = Math.min(top, r.top);
        bottom = Math.max(bottom, r.bottom);
      }
    }
    return Number.isFinite(top) ? { top: top + scrollY, bottom: bottom + scrollY } : undefined;
  };
  const sections = [...container.children].filter((el) => !el.matches('script,style,noscript,template') && shown(el) && getComputedStyle(el).position !== 'fixed' && el.getBoundingClientRect().height > 80).map(contentBox).filter(Boolean);
  const gaps = sections.slice(1).map((s, i) => Math.round(s.top - sections[i].bottom));
  const PRICE = /[$€£¥฿]\s?\d+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?\s?(?:USD|EUR|GBP|THB|baht|€|£|฿)/i;
  const parseColor = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return undefined;
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return [r, g, b, a];
  };
  const backgroundOf = (el) => {
    for (let a = el; a; a = a.parentElement) {
      const s = getComputedStyle(a);
      if (s.backgroundImage !== 'none') return undefined;
      const c = parseColor(s.backgroundColor);
      if (c && c[3] > 0.5) return c;
    }
    return [255, 255, 255, 1];
  };
  const subscribes = [...document.querySelectorAll('a,button,[role=button]')].filter((el) => /subscribe/i.test(el.innerText || el.getAttribute('aria-label') || ''));
  const prices = [];
  const cardRects = [];
  for (const s of subscribes) {
    let card = s.parentElement;
    while (card && card !== document.body && !PRICE.test(card.innerText)) card = card.parentElement;
    if (!card || card === document.body) continue;
    const r = card.getBoundingClientRect();
    cardRects.push({ top: r.top + scrollY, bottom: r.bottom + scrollY, left: r.left, right: r.right });
    const pw = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    for (let n = pw.nextNode(); n; n = pw.nextNode()) {
      if (!PRICE.test(n.textContent) || !n.parentElement) continue;
      const st = getComputedStyle(n.parentElement);
      prices.push({ text: n.textContent.trim().slice(0, 20), fontSize: parseFloat(st.fontSize), fontWeight: Number(st.fontWeight) || 400, color: parseColor(st.color), background: backgroundOf(n.parentElement), opacity: Number(st.opacity) });
      break;
    }
  }
  const cards = cardRects.length === 0 ? undefined : { top: Math.min(...cardRects.map((r) => r.top)), bottom: Math.max(...cardRects.map((r) => r.bottom)), left: Math.min(...cardRects.map((r) => r.left)), right: Math.max(...cardRects.map((r) => r.right)) };
  return { viewport: innerWidth, scrollWidth: document.scrollingElement.scrollWidth, textChars: document.body.innerText.trim().length, overflows: [...new Set(overflows)], smallButtons, gaps, prices, cards, height: document.scrollingElement.scrollHeight };
}

/** The hero canvas: the largest visible canvas in the first screen, marked for the later steps. */
export function findHero() {
  const canvases = [...document.querySelectorAll('canvas')]
    .map((c) => ({ c, r: c.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && r.height > 0 && r.top + scrollY < innerHeight)
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
  const hero = canvases[0];
  if (!hero) return undefined;
  hero.c.setAttribute('data-hp-hero', '');
  const own = window.__hp.contexts.find((x) => x.canvas === hero.c);
  return { x: hero.r.left, y: hero.r.top + scrollY, width: hero.r.width, height: hero.r.height, context: own ? own.type : null };
}

/** Shows only canvases on black, so a screenshot reads the shader's own pixels. `false` removes it. */
export function isolateCanvas(on) {
  document.getElementById('__hp_isolate')?.remove();
  if (!on) return;
  const style = document.createElement('style');
  style.id = '__hp_isolate';
  style.textContent = 'html,body{background:#000!important;background-image:none!important}body *{visibility:hidden!important}body *::before,body *::after{visibility:hidden!important}canvas{visibility:visible!important}';
  document.head.append(style);
}

export function webglFacts() {
  const hp = window.__hp;
  return { contexts: hp.contexts.map((c) => ({ type: c.type, ok: c.ctx !== null, lost: c.ctx?.isContextLost?.() ?? null })), compileFailed: hp.compileFailed, linkFailed: hp.linkFailed, linked: hp.linked };
}

export function gsapFacts() {
  const st = window.ScrollTrigger;
  const all = st?.getAll?.() ?? [];
  return {
    version: window.gsap?.version ?? null,
    scrollTrigger: typeof st === 'function',
    triggers: all.length,
    fired: all.filter((t) => t.progress > 0).length,
    pinned: all.filter((t) => t.pin).length,
    sources: [...document.scripts].map((s) => s.src).filter(Boolean),
  };
}

/** Loses the hero's WebGL context, asks for it back, and reports whether the page saw both. */
export async function loseContext() {
  const hp = window.__hp;
  const hero = document.querySelector('[data-hp-hero]');
  const entry = hp.contexts.find((c) => c.canvas === hero && c.ctx) ?? hp.contexts.find((c) => c.ctx);
  if (!entry) return { tried: false };
  const ext = entry.ctx.getExtension('WEBGL_lose_context');
  if (!ext) return { tried: false };
  const linkedBefore = hp.linked;
  ext.loseContext();
  await new Promise((r) => setTimeout(r, 600));
  const lostSeen = entry.ctx.isContextLost();
  ext.restoreContext();
  await new Promise((r) => setTimeout(r, 1500));
  const now = hp.contexts.filter((c) => c.ctx && !c.ctx.isContextLost());
  return { tried: true, lostSeen, restored: now.length > 0, relinked: hp.linked - linkedBefore };
}

export function vitals() {
  const hp = window.__hp;
  // CLS as Web Vitals defines it: the largest burst of shifts less than 1s apart and within 5s.
  let best = 0;
  let current = 0;
  let start = 0;
  let last = -Infinity;
  for (const [t, v] of hp.shifts) {
    if (t - last > 1000 || t - start > 5000) {
      current = 0;
      start = t;
    }
    current += v;
    last = t;
    best = Math.max(best, current);
  }
  return { lcp: Math.round(hp.lcp), cls: Math.round(best * 1000) / 1000 };
}
