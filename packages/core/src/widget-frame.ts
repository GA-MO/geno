import { WIDGET_PALETTE, WIDGET_VARIABLES, type WidgetVariable } from './widget.js';

/**
 * The document a widget runs in, and the messages it may send back. Pure, so the chat panel, the widget's editor
 * tab and the download all build the same page, and a unit test can hold the policy to the letter.
 *
 * A VS Code webview's frames all inherit its CSP: a srcdoc, data: or blob: frame keeps the panel's nonce-only
 * script-src (measured in 1.109.2), so an inline script runs only with the panel's nonce. The widget's text never
 * reaches the frame's parser. It travels as a string inside the one bootstrap script, which parses it inert, gives its
 * scripts and styles the nonce, turns its `on*` attributes into listeners, and inserts it. The frame is sandboxed with
 * scripts only, so its origin is opaque: no storage, no access to the panel, no forms, popups or top navigation. Its
 * own policy has no network, and WebRTC, which no policy covers, is taken away. What it may say back is a height, a link to ask the user about, and a snapshot of its
 * markup for Copy as image, which the panel only ever draws as an image.
 */

export const WIDGET_SANDBOX = 'allow-scripts';

const POLICY = (script: string): string =>
  `default-src 'none'; script-src ${script}; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'`;

const NONCE = /^[A-Za-z0-9+/=_-]+$/;

function nonceOf(nonce: string): string {
  if (!NONCE.test(nonce)) throw new Error(`${JSON.stringify(nonce)} is not a nonce`);
  return nonce;
}

export const frameCsp = (nonce: string): string => POLICY(`'nonce-${nonceOf(nonce)}'`);

export type WidgetTheme = { readonly scheme: 'dark' | 'light'; readonly vars: Readonly<Partial<Record<WidgetVariable, string>>> };

/**
 * The widget theme from the panel's own `--widget-*` variables, read through `read`, which gives a variable's value
 * or undefined. The series colors default to the palette, which reads on dark and light alike.
 */
export function widgetTheme(read: (name: string) => string | undefined, scheme: WidgetTheme['scheme']): WidgetTheme {
  const vars: Partial<Record<WidgetVariable, string>> = {};
  for (const name of Object.keys(WIDGET_VARIABLES) as (keyof typeof WIDGET_VARIABLES)[]) {
    const value = read(`--widget-${name.slice(2)}`);
    if (value !== undefined && value !== '') vars[name] = value;
  }
  WIDGET_PALETTE.forEach((color, i) => {
    const name = `--chart-${i + 1}` as WidgetVariable;
    vars[name] = read(`--widget-${name.slice(2)}`) || color;
  });
  return { scheme, vars };
}

/** Both schemes' variables, for a page that follows the reader's system theme rather than the panel's. */
export type WidgetSchemes = { readonly light: WidgetTheme['vars']; readonly dark: WidgetTheme['vars'] };

export type FrameInput = { readonly html: string; readonly nonce: string; readonly theme: WidgetTheme | WidgetSchemes };

export const FRAME_HEIGHT = { min: 24, max: 2400 } as const;

/** Message types the panel sends a frame. */
export const TO_FRAME = { theme: 'gcode-widget-theme', snapshot: 'gcode-widget-snapshot' } as const;

const NAME = /^--[a-z0-9-]+$/;
// Enough for colors, rgb() with alpha, and font stacks; never a brace, semicolon or angle bracket.
const VALUE = /^[\w\s#().,%/"'+-]*$/;

function rootRule(scheme: WidgetTheme['scheme'], vars: WidgetTheme['vars']): string {
  const declarations = Object.entries(vars).filter(([name, value]) => NAME.test(name) && typeof value === 'string' && VALUE.test(value));
  return `:root{color-scheme:${scheme === 'light' ? 'light' : 'dark'}${declarations.map(([name, value]) => `;${name}:${value}`).join('')}}`;
}

/**
 * The theme as CSS: one rule, or for both schemes the light rule and the dark one under `prefers-color-scheme`. A
 * value that could end the rule or the style element is left out.
 */
export function themeCss(theme: WidgetTheme | WidgetSchemes): string {
  return 'scheme' in theme ? rootRule(theme.scheme, theme.vars) : `${rootRule('light', theme.light)}@media (prefers-color-scheme: dark){${rootRule('dark', theme.dark)}}`;
}

const BASE_CSS =
  '*,*::before,*::after{box-sizing:border-box}html{background:transparent}body{margin:0;color:var(--fg);font:13px/1.5 var(--font);overflow-x:auto;overflow-y:hidden}#geno-root{display:flow-root;padding:12px}#geno-root>*{max-width:100%}img,video{max-width:100%;height:auto}';

/**
 * Runs in the frame. It must hold no `<`, so it can sit inside a script element whatever it contains. SOURCE is the
 * widget's text as a JSON string with every `<` escaped.
 */
/**
 * Chromium's CSP has no say over WebRTC, and a peer connection's STUN and TURN requests leave the sandbox, so the
 * constructors go before any widget script runs. A frame the widget nests is a fresh opaque origin, so it cannot hand
 * back its own.
 */
export const WEBRTC_GUARD = String.raw`Object.getOwnPropertyNames(window).forEach(function (name) { if (/^(webkit)?RTC/.test(name)) delete window[name]; });`;

const BOOT = String.raw`(function () {
  ${WEBRTC_GUARD}
  var nonce = document.currentScript.nonce;
  var source = SOURCE;
  var root = document.getElementById('geno-root');
  var post = function (message) { message.type = 'gcode-widget'; parent.postMessage(message, '*'); };
  var bound = [];
  window.__genoOn = function (i, type, handler) {
    var element = bound[i];
    element.addEventListener(type, function (event) { if (handler.call(element, event) === false) event.preventDefault(); });
  };
  function bind(element) {
    var attributes = Array.prototype.slice.call(element.attributes);
    attributes.forEach(function (attribute) {
      if (attribute.name.slice(0, 2).toLowerCase() !== 'on') return;
      element.removeAttribute(attribute.name);
      var script = document.createElement('script');
      script.nonce = nonce;
      script.textContent = '__genoOn(' + (bound.push(element) - 1) + ',' + JSON.stringify(attribute.name.slice(2).toLowerCase()) + ',function(event){' + attribute.value + '\n})';
      document.head.appendChild(script);
      script.remove();
    });
  }
  function bindAll(node) {
    if (node.nodeType === 1) bind(node);
    if (node.querySelectorAll) node.querySelectorAll('*').forEach(bind);
  }
  var template = document.createElement('template');
  template.innerHTML = source;
  var fragment = template.content;
  fragment.querySelectorAll('meta, base, link').forEach(function (element) { element.remove(); });
  fragment.querySelectorAll('style').forEach(function (element) { element.setAttribute('nonce', nonce); });
  fragment.querySelectorAll('script').forEach(function (old) {
    var script = document.createElement('script');
    Array.prototype.forEach.call(old.attributes, function (attribute) { script.setAttribute(attribute.name, attribute.value); });
    script.nonce = nonce;
    script.textContent = old.textContent;
    old.replaceWith(script);
  });
  bindAll(fragment);
  new MutationObserver(function (records) {
    records.forEach(function (record) {
      if (record.type === 'attributes') bind(record.target);
      else record.addedNodes.forEach(bindAll);
    });
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  document.addEventListener('click', function (event) {
    var link = event.target && event.target.closest ? event.target.closest('a') : null;
    var href = link && (link.getAttribute('href') || link.getAttribute('xlink:href'));
    if (!href || href.charAt(0) === '#') return;
    event.preventDefault();
    post({ kind: 'link', href: href });
  }, true);
  var last = -1;
  function report() {
    var height = Math.ceil(root.getBoundingClientRect().height);
    if (height !== last) { last = height; post({ kind: 'height', height: height }); }
  }
  new ResizeObserver(report).observe(root);
  function snapshot(id) {
    var copy = document.documentElement.cloneNode(true);
    var canvases = document.querySelectorAll('canvas');
    copy.querySelectorAll('canvas').forEach(function (canvas, i) {
      var image = document.createElement('img');
      var box = canvases[i].getBoundingClientRect();
      try { image.src = canvases[i].toDataURL('image/png'); } catch (error) {}
      image.setAttribute('style', (canvases[i].getAttribute('style') || '') + ';width:' + box.width + 'px;height:' + box.height + 'px');
      canvas.replaceWith(image);
    });
    var fields = document.querySelectorAll('input, textarea, select');
    copy.querySelectorAll('input, textarea, select').forEach(function (field, i) {
      var live = fields[i];
      if (live.type === 'checkbox' || live.type === 'radio') { if (live.checked) field.setAttribute('checked', ''); else field.removeAttribute('checked'); }
      else if (field.tagName === 'TEXTAREA') field.textContent = live.value;
      else if (field.tagName === 'SELECT') Array.prototype.forEach.call(field.options, function (option, j) { if (live.options[j].selected) option.setAttribute('selected', ''); else option.removeAttribute('selected'); });
      else field.setAttribute('value', live.value);
    });
    copy.querySelectorAll('script').forEach(function (script) { script.remove(); });
    post({ kind: 'snapshot', id: id, markup: new XMLSerializer().serializeToString(copy), width: document.documentElement.clientWidth, height: Math.ceil(root.getBoundingClientRect().height) });
  }
  addEventListener('message', function (event) {
    var data = event.data;
    if (event.source !== parent || !data) return;
    if (data.type === '${TO_FRAME.theme}' && typeof data.css === 'string') document.getElementById('geno-theme').textContent = data.css;
    if (data.type === '${TO_FRAME.snapshot}' && typeof data.id === 'string') snapshot(data.id);
  });
  root.appendChild(fragment);
  report();
})();`;

/** The widget's text as a JavaScript string that cannot end its script element or open a comment. */
const scriptString = (text: string): string => JSON.stringify(text).replaceAll('<', '\\u003c');

/** The srcdoc of a widget's frame in a page whose scripts need `nonce`. */
export function frameDocument({ html, nonce, theme }: FrameInput): string {
  nonceOf(nonce);
  const boot = BOOT.replace('SOURCE', () => scriptString(html));
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${frameCsp(nonce)}">`,
    '<meta http-equiv="x-dns-prefetch-control" content="off">',
    `<style nonce="${nonce}">${BASE_CSS}</style>`,
    `<style nonce="${nonce}" id="geno-theme">${themeCss(theme)}</style>`,
    '</head><body><div id="geno-root"></div>',
    `<script nonce="${nonce}">${boot}</script></body></html>`,
  ].join('');
}

/** What a frame may tell the panel. */
export type FromWidget =
  | { readonly kind: 'height'; readonly height: number }
  | { readonly kind: 'link'; readonly href: string }
  | { readonly kind: 'snapshot'; readonly id: string; readonly markup: string; readonly width: number; readonly height: number };

const LINK_MAX = 2048;
const SNAPSHOT_MAX = 16 * 1024 * 1024;
const WEB = new Set(['http:', 'https:']);

const isRecord = (raw: unknown): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null;
const clamp = (n: number, { min, max }: { readonly min: number; readonly max: number }): number => Math.min(max, Math.max(min, Math.ceil(n)));

/** A web link a widget may ask to open, normalized, or undefined for anything that is not http or https. */
export function webLink(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > LINK_MAX) return undefined;
  try {
    const url = new URL(raw);
    return WEB.has(url.protocol) && url.href.length <= LINK_MAX ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A frame's message as the panel acts on it, or undefined for anything else. The caller has already checked that the
 * message came from that frame's window.
 */
export function fromWidget(data: unknown): FromWidget | undefined {
  if (!isRecord(data) || data['type'] !== 'gcode-widget') return undefined;
  const { kind } = data;
  if (kind === 'height') {
    const { height } = data;
    return typeof height === 'number' && Number.isFinite(height) ? { kind, height: clamp(height, FRAME_HEIGHT) } : undefined;
  }
  if (kind === 'link') {
    const href = webLink(data['href']);
    return href === undefined ? undefined : { kind, href };
  }
  if (kind === 'snapshot') {
    const { id, markup, width, height } = data;
    if (typeof id !== 'string' || typeof markup !== 'string' || markup.length > SNAPSHOT_MAX) return undefined;
    if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height)) return undefined;
    return { kind, id, markup, width: clamp(width, { min: 1, max: 4000 }), height: clamp(height, FRAME_HEIGHT) };
  }
  return undefined;
}
