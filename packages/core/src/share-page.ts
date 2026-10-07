import { lexer, type MarkedToken, type Token, type Tokens } from 'marked';
import { codeTokens, type CodeToken } from './code-tokens.js';
import { FRAME_HEIGHT, frameCsp, frameDocument, themeCss, WIDGET_SANDBOX, type WidgetSchemes } from './widget-frame.js';
import { WIDGET_PALETTE } from './widget.js';

/**
 * A shared page (U66): a widget or an answer as one standalone HTML file to show someone else. Everything it shows is
 * inside the file, so it opens the same from a disk, a mail attachment or a phone, and loads nothing. It runs under the
 * widget frame's own policy, and a widget in it runs in the same sandboxed frame it has in the panel.
 */

/** A `data:` address: the only kind of address a page's images have. */
export type DataUri = string & { readonly __brand: 'DataUri' };

/** The image files a page inlines, by extension. */
export const PAGE_IMAGE_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
} as const;
export type PageImageType = (typeof PAGE_IMAGE_TYPES)[keyof typeof PAGE_IMAGE_TYPES];

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export const dataUri = (type: PageImageType, bytes: Uint8Array): DataUri => `data:${type};base64,${base64(bytes)}` as DataUri;

/** One block of the page, in order: what the user asked, the answer's text, or a widget. */
export type PagePart =
  | { readonly kind: 'request'; readonly text: string }
  | { readonly kind: 'markdown'; readonly text: string }
  | { readonly kind: 'widget'; readonly title: string; readonly html: string };

/** A diagram the panel drew, as its SVG, and the scheme it was drawn for, which the page keeps around it. */
export type PageDiagram = { readonly svg: string; readonly scheme: 'light' | 'dark' };

/** The page's colors and fonts: the widget variables, and what markdown needs besides. */
export const PAGE_TOKENS = [
  '--bg',
  '--surface',
  '--fg',
  '--muted',
  '--border',
  '--accent',
  '--warn',
  '--danger',
  '--font',
  '--mono',
  '--link',
  '--code-bg',
  '--diagram',
  '--tok-comment',
  '--tok-keyword',
  '--tok-string',
  '--tok-number',
  '--tok-name',
  '--tok-inserted',
  '--tok-deleted',
] as const;
export type PageToken = (typeof PAGE_TOKENS)[number] | `--chart-${1 | 2 | 3 | 4 | 5 | 6}`;
export type PageTokens = Readonly<Record<PageToken, string>>;
export type PageTheme = { readonly light: PageTokens; readonly dark: PageTokens };

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const CHARTS = Object.fromEntries(WIDGET_PALETTE.map((color, i) => [`--chart-${i + 1}`, color])) as Record<`--chart-${1 | 2 | 3 | 4 | 5 | 6}`, string>;

/** Geno's glass colors, light and dark, the same values the panel gives widgets. A reader has no VS Code theme. */
export const PAGE_THEME: PageTheme = {
  light: {
    '--bg': '#f5f5f5',
    '--surface': 'rgb(0 0 0 / 4%)',
    '--fg': '#1c1c1c',
    '--muted': '#5c5c5c',
    '--border': 'rgb(0 0 0 / 10%)',
    '--accent': '#1f8a4c',
    '--warn': '#b26a00',
    '--danger': '#c42b1c',
    '--font': FONT,
    '--mono': MONO,
    '--link': '#0a5fc2',
    '--code-bg': '#ebebeb',
    '--diagram': '#ffffff',
    '--tok-comment': '#5c5c5c',
    '--tok-keyword': '#1650b8',
    '--tok-string': '#a31515',
    '--tok-number': '#0b7a50',
    '--tok-name': '#8a3fa0',
    '--tok-inserted': '#23753b',
    '--tok-deleted': '#bb3324',
    ...CHARTS,
  },
  dark: {
    '--bg': '#1e1e20',
    '--surface': 'rgb(255 255 255 / 5%)',
    '--fg': '#dcdcdc',
    '--muted': '#a8a8a8',
    '--border': 'rgb(255 255 255 / 10%)',
    '--accent': '#6fd39c',
    '--warn': '#f0c35a',
    '--danger': '#ff8f86',
    '--font': FONT,
    '--mono': MONO,
    '--link': '#7cc4ff',
    '--code-bg': '#18181a',
    '--diagram': '#232326',
    '--tok-comment': '#a8a8a8',
    '--tok-keyword': '#6fb3ff',
    '--tok-string': '#e9a37f',
    '--tok-number': '#b9dca0',
    '--tok-name': '#d79be0',
    '--tok-inserted': '#7fd99f',
    '--tok-deleted': '#ff9a8a',
    ...CHARTS,
  },
};

/**
 * Everything a page shows. `images` holds the data of the images the markdown links, by the address it gives;
 * `diagrams` holds the drawings of its mermaid fences, by source. An image or diagram missing from them shows as a
 * link or as its source. `nonce` lets the page's one script and its widgets' scripts run, and nothing else.
 */
export type PageDocument = {
  readonly title: string;
  readonly parts: readonly PagePart[];
  readonly images: ReadonlyMap<string, DataUri>;
  readonly diagrams: ReadonlyMap<string, PageDiagram>;
  readonly theme: PageTheme;
  readonly nonce: string;
};

/** A page has the widget frame's policy: no network, scripts only with the nonce, styles and images inline. */
export const pageCsp = frameCsp;

const escapeText = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const escapeAttr = (text: string): string => escapeText(text).replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/** Links open in the reader's browser; any other scheme is shown as text. */
const SAFE_LINK = /^(https?:|mailto:)/i;

type Assets = Pick<PageDocument, 'images' | 'diagrams'>;
type Kind = MarkedToken['type'];
type Renderers = { readonly [K in Kind]?: (token: Extract<MarkedToken, { type: K }>, assets: Assets) => string };

function render(table: Renderers, token: Token, assets: Assets, fallback: (raw: string) => string): string {
  const renderer = table[token.type as Kind] as ((t: Token, a: Assets) => string) | undefined;
  return renderer === undefined ? fallback(token.raw) : renderer(token, assets);
}

const inline = (tokens: readonly Token[] | undefined, assets: Assets): string => (tokens ?? []).map((token) => render(INLINE, token, assets, escapeText)).join('');

const link = (href: string, title: string, body: string): string => `<a href="${escapeAttr(href)}" title="${escapeAttr(title)}" rel="noopener noreferrer">${body}</a>`;

const checkbox = (checked: boolean): string => `<input type="checkbox" disabled${checked ? ' checked' : ''}> `;

const INLINE: Renderers = {
  text: (t, a) => (t.tokens === undefined ? escapeText(t.text) : inline(t.tokens, a)),
  escape: (t) => escapeText(t.text),
  strong: (t, a) => `<strong>${inline(t.tokens, a)}</strong>`,
  em: (t, a) => `<em>${inline(t.tokens, a)}</em>`,
  del: (t, a) => `<del>${inline(t.tokens, a)}</del>`,
  codespan: (t) => `<code>${escapeText(t.text)}</code>`,
  br: () => '<br>',
  link: (t, a) => (SAFE_LINK.test(t.href) ? link(t.href, t.title ?? t.href, inline(t.tokens, a)) : inline(t.tokens, a)),
  image: (t, a) => {
    const data = a.images.get(t.href);
    if (data !== undefined) return `<img src="${escapeAttr(data)}" alt="${escapeAttr(t.text)}">`;
    return SAFE_LINK.test(t.href) ? link(t.href, t.href, escapeText(t.text || t.href)) : escapeText(t.text);
  },
  html: (t) => escapeText(t.raw),
  checkbox: (t) => checkbox(t.checked),
};

const tokenHtml = (token: CodeToken): string => (typeof token === 'string' ? escapeText(token) : `<span class="${escapeAttr(token.classes)}">${token.content.map(tokenHtml).join('')}</span>`);

const VIEW_BOX = /viewBox="[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)/;

/** A drawn diagram as an image, where its SVG can run no script and load nothing, on the surface it was drawn for. */
function diagramHtml({ svg, scheme }: PageDiagram): string {
  const width = VIEW_BOX.exec(svg)?.[1];
  const sized = width === undefined ? '' : ` width="${Math.round(Number(width))}"`;
  return `<figure class="diagram diagram-${scheme}"><img src="${dataUri('image/svg+xml', new TextEncoder().encode(svg))}" alt="Diagram"${sized}></figure>`;
}

function codeHtml(code: string, lang: string | undefined): string {
  const label = lang?.trim().split(/\s/)[0] || undefined;
  const caption = label === undefined ? '' : `<span class="code-lang">${escapeText(label)}</span>`;
  return `<div class="code">${caption}<pre><code>${codeTokens(code, label).map(tokenHtml).join('')}</code></pre></div>`;
}

const listItem = (item: Tokens.ListItem, a: Assets): string => `<li${item.task ? ' class="task"' : ''}>${blocks(item.tokens, a)}</li>`;

const cell = (tag: 'th' | 'td', c: Tokens.TableCell, a: Assets): string => `<${tag}${c.align === null ? '' : ` class="align-${c.align}"`}>${inline(c.tokens, a)}</${tag}>`;

const BLOCK: Renderers = {
  space: () => '',
  def: () => '',
  paragraph: (t, a) => `<p>${inline(t.tokens, a)}</p>`,
  text: (t, a) => (t.tokens === undefined ? escapeText(t.text) : inline(t.tokens, a)),
  heading: (t, a) => {
    const level = Math.min(Math.max(t.depth, 1), 6);
    return `<h${level}>${inline(t.tokens, a)}</h${level}>`;
  },
  code: (t, a) => {
    const diagram = t.lang?.trim().split(/\s/)[0]?.toLowerCase() === 'mermaid' ? a.diagrams.get(t.text) : undefined;
    return diagram === undefined ? codeHtml(t.text, t.lang) : diagramHtml(diagram);
  },
  blockquote: (t, a) => `<blockquote>${blocks(t.tokens, a)}</blockquote>`,
  hr: () => '<hr>',
  // A task item's box comes first among its blocks.
  checkbox: (t) => checkbox(t.checked),
  html: (t) => `<p>${escapeText(t.raw)}</p>`,
  list: (t, a) => {
    const items = t.items.map((item) => listItem(item, a)).join('');
    if (!t.ordered) return `<ul>${items}</ul>`;
    return t.start === '' || t.start === 1 ? `<ol>${items}</ol>` : `<ol start="${Number(t.start)}">${items}</ol>`;
  },
  table: (t, a) =>
    `<div class="table-scroll"><table><thead><tr>${t.header.map((c) => cell('th', c, a)).join('')}</tr></thead><tbody>${t.rows
      .map((row) => `<tr>${row.map((c) => cell('td', c, a)).join('')}</tr>`)
      .join('')}</tbody></table></div>`,
};

function blocks(tokens: readonly Token[], a: Assets): string {
  return tokens.map((token) => render(BLOCK, token, a, (raw) => `<p>${escapeText(raw)}</p>`)).join('');
}

/** Markdown as page markup. Every node is built from token fields as escaped text, so model text is never markup. */
export const markdownHtml = (text: string, assets: Assets): string => blocks(lexer(text, { gfm: true }), assets);

/** The address of every image the markdown shows, in order, so the page's builder can inline the ones it may. */
export function imageHrefs(text: string): string[] {
  const found: string[] = [];
  const walk = (tokens: readonly Token[]) => {
    for (const token of tokens) {
      if (token.type === 'image') found.push((token as Tokens.Image).href);
      const nested = token as { tokens?: Token[]; items?: Token[]; header?: { tokens: Token[] }[]; rows?: { tokens: Token[] }[][] };
      if (nested.tokens !== undefined) walk(nested.tokens);
      if (nested.items !== undefined) walk(nested.items);
      for (const c of nested.header ?? []) walk(c.tokens);
      for (const row of nested.rows ?? []) for (const c of row) walk(c.tokens);
    }
  };
  walk(lexer(text, { gfm: true }));
  return [...new Set(found)];
}

const TITLE_MAX = 80;

/** What an answer's page is called: the first line the user asked, else the answer's first heading, else "Answer". */
export function answerTitle(prompt: string, answer: string): string {
  const heading = lexer(answer, { gfm: true }).find((token): token is Tokens.Heading => token.type === 'heading');
  const line = prompt.split('\n').find((l) => l.trim() !== '')?.trim() || heading?.text.replace(/[*_`~]/g, '').trim() || 'Answer';
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1).trimEnd()}…` : line;
}

const SLUG_MAX = 60;

/** A page's file name from its title: letters and digits of any script, joined by dashes. */
export function pageFileName(title: string): string {
  const slug = [...title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')]
    .slice(0, SLUG_MAX)
    .join('')
    .replace(/-+$/, '');
  return `${slug || 'page'}.html`;
}

const BASE_CSS = [
  '*,*::before,*::after{box-sizing:border-box}',
  'html{background:var(--bg);color:var(--fg);-webkit-text-size-adjust:100%}',
  'body{margin:0;font:16px/1.6 var(--font);overflow-wrap:break-word}',
  'main{max-width:46rem;margin:0 auto;padding:32px 16px 48px}',
  'h1,h2,h3,h4,h5,h6{line-height:1.25;font-weight:600;margin:28px 0 12px}',
  '.page-title{font-size:1.75rem;margin:0 0 20px}',
  'h1{font-size:1.5rem}h2{font-size:1.3rem}h3{font-size:1.1rem}h4,h5,h6{font-size:1rem}',
  'p,ul,ol{margin:12px 0}ul,ol{padding-left:1.5em}li>p{margin:4px 0}li.task{list-style:none}li.task input{margin:0 6px 0 -1.3em}',
  'a{color:var(--link)}',
  'code{font-family:var(--mono);font-size:.875em;padding:1px 4px;border-radius:4px;background:var(--code-bg)}',
  '.code{margin:16px 0;border:1px solid var(--border);border-radius:10px;background:var(--code-bg);overflow:hidden}',
  '.code-lang{display:block;padding:4px 14px;border-bottom:1px solid var(--border);color:var(--muted);font:12px/1.6 var(--font)}',
  'pre{margin:0;padding:12px 14px;overflow-x:auto;line-height:1.55;tab-size:2}',
  'pre code{padding:0;border-radius:0;background:none;font-size:.85rem}',
  'blockquote{margin:16px 0;padding:0 0 0 14px;border-left:3px solid var(--border);color:var(--muted)}',
  'hr{height:1px;margin:24px 0;border:0;background:var(--border)}',
  '.table-scroll{margin:16px 0;overflow-x:auto}table{border-collapse:collapse}',
  'th,td{padding:4px 10px;border:1px solid var(--border);text-align:left}.align-center{text-align:center}.align-right{text-align:right}',
  'img{max-width:100%;height:auto}figure{margin:16px 0}',
  '.request{margin:0 0 24px;padding:10px 14px;border:1px solid var(--border);border-radius:12px;background:var(--surface);white-space:pre-wrap}',
  '.diagram{padding:12px;border:1px solid var(--border);border-radius:10px;overflow-x:auto;text-align:center}',
  '.widget{border:1px solid var(--border);border-radius:10px;background:var(--surface);overflow:hidden}',
  '.widget figcaption{padding:6px 12px;border-bottom:1px solid var(--border);color:var(--muted);font-size:13px}',
  `.widget-frame{display:block;width:100%;height:${FRAME_HEIGHT.min * 5}px;border:0}`,
  'footer{margin-top:40px;color:var(--muted);font-size:13px}',
  '.token.comment,.token.prolog,.token.doctype,.token.cdata,.token.shebang{color:var(--tok-comment);font-style:italic}',
  '.token.keyword,.token.boolean,.token.builtin,.token.important,.token.atrule,.token.selector{color:var(--tok-keyword)}',
  '.token.string,.token.char,.token.template-string,.token.attr-value,.token.regex,.token.url{color:var(--tok-string)}',
  '.token.number,.token.constant,.token.symbol,.token.unit{color:var(--tok-number)}',
  '.token.function,.token.class-name,.token.tag,.token.property,.token.attr-name,.token.key{color:var(--tok-name)}',
  '.token.inserted{color:var(--tok-inserted)}.token.deleted{color:var(--tok-deleted)}',
].join('');

/** A diagram keeps the surface of the scheme it was drawn for, whichever scheme the page shows. */
const diagramCss = (theme: PageTheme): string => `.diagram-light{background:${theme.light['--diagram']}}.diagram-dark{background:${theme.dark['--diagram']}}`;

/**
 * The page's one script: it sizes each widget's frame to what the frame reports, and opens a link the reader clicked
 * inside a widget. A frame may say nothing else, and a link it sends without the reader's click opens nothing.
 */
const SCRIPT = String.raw`(function () {
  var frames = document.querySelectorAll('iframe.widget-frame');
  addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== 'gcode-widget') return;
    Array.prototype.forEach.call(frames, function (frame) {
      if (frame.contentWindow !== event.source) return;
      if (data.kind === 'height' && typeof data.height === 'number' && isFinite(data.height)) frame.style.height = Math.min(${FRAME_HEIGHT.max}, Math.max(${FRAME_HEIGHT.min}, Math.ceil(data.height))) + 'px';
      var clicked = document.activeElement === frame && navigator.userActivation && navigator.userActivation.isActive;
      if (data.kind === 'link' && typeof data.href === 'string' && /^https?:/i.test(data.href) && clicked) window.open(data.href, '_blank', 'noopener,noreferrer');
    });
  });
})();`;

function partHtml(part: PagePart, doc: PageDocument, schemes: WidgetSchemes): string {
  switch (part.kind) {
    case 'request':
      return `<div class="request">${escapeText(part.text)}</div>`;
    case 'markdown':
      return `<div class="markdown">${markdownHtml(part.text, doc)}</div>`;
    case 'widget': {
      const caption = part.title === doc.title ? '' : `<figcaption>${escapeText(part.title)}</figcaption>`;
      const frame = frameDocument({ html: part.html, nonce: doc.nonce, theme: schemes });
      return `<figure class="widget">${caption}<iframe class="widget-frame" title="${escapeAttr(part.title)}" sandbox="${WIDGET_SANDBOX}" referrerpolicy="no-referrer" srcdoc="${escapeAttr(frame)}"></iframe></figure>`;
    }
  }
}

/** The page as one HTML document. */
export function renderPage(doc: PageDocument): string {
  const schemes: WidgetSchemes = { light: doc.theme.light, dark: doc.theme.dark };
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${pageCsp(doc.nonce)}">`,
    '<meta http-equiv="x-dns-prefetch-control" content="off">',
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${escapeText(doc.title)}</title>`,
    `<style>${themeCss(schemes)}${BASE_CSS}${diagramCss(doc.theme)}</style>`,
    '</head><body><main>',
    `<h1 class="page-title">${escapeText(doc.title)}</h1>`,
    ...doc.parts.map((part) => partHtml(part, doc, schemes)),
    '<footer>Saved from Geno.</footer>',
    `</main><script nonce="${doc.nonce}">${SCRIPT}</script></body></html>`,
  ].join('');
}
