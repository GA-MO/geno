/**
 * A small HTML to markdown converter for web_fetch: enough structure (headings, lists, code, links, tables) for a
 * model to read a documentation page, without a parser dependency. It is lenient the way browsers are: unclosed
 * tags close when their parent does, and a stray end tag is ignored.
 */

type Element = { readonly tag: string; readonly attrs: Readonly<Record<string, string>>; readonly children: Node[]; readonly parent: Element | undefined };
type Node = Element | string;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'xmp', 'iframe', 'noembed', 'noframes']);
/** Never read: code, chrome around the content, controls, and whatever the page hides. */
const SKIPPED = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'object', 'head', 'nav', 'footer', 'aside', 'form', 'button', 'select', 'input', 'textarea', 'dialog', 'math']);
const BLOCKS = new Set([
  'address', 'article', 'blockquote', 'body', 'dd', 'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'html', 'li', 'main', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'ul',
]);
/** Opening the key closes the outermost open element of `closes` first, searching up to one of `within`. */
const CLOSES: Readonly<Record<string, { readonly closes: readonly string[]; readonly within: readonly string[] }>> = {
  li: { closes: ['li'], within: ['ul', 'ol', 'menu'] },
  dt: { closes: ['dt', 'dd'], within: ['dl'] },
  dd: { closes: ['dt', 'dd'], within: ['dl'] },
  tr: { closes: ['tr'], within: ['table', 'tbody', 'thead', 'tfoot'] },
  td: { closes: ['td', 'th'], within: ['tr', 'table'] },
  th: { closes: ['td', 'th'], within: ['tr', 'table'] },
  option: { closes: ['option'], within: ['select', 'datalist'] },
};
const BOUNDARIES = new Set(['ul', 'ol', 'dl', 'table', 'tbody', 'thead', 'tfoot', 'select', 'tr', 'td', 'th', 'li']);
const CLOSES_P = new Set([...BLOCKS, 'tbody', 'thead']);

const NAMED: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•', times: '×', larr: '←', rarr: '→',
  uarr: '↑', darr: '↓', deg: '°', para: '¶', sect: '§', zwj: '', zwnj: '', shy: '',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[name.toLowerCase()] ?? whole;
  });
}

const ATTR = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function attrsOf(body: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of body.matchAll(ATTR)) {
    const name = match[1]!.toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

/** The index just past the `>` that ends the tag starting at `start`, skipping quoted attribute values. */
function tagEnd(html: string, start: number): number {
  let quote: string | undefined;
  for (let i = start; i < html.length; i++) {
    const ch = html[i]!;
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i + 1;
  }
  return html.length;
}

const isTagStart = (ch: string | undefined): boolean => ch !== undefined && /[a-z]/i.test(ch);

export function parseHtml(html: string): Element {
  const root: Element = { tag: '#root', attrs: {}, children: [], parent: undefined };
  let current = root;
  const open = (tag: string): Element | undefined => {
    for (let node: Element | undefined = current; node !== undefined; node = node.parent) if (node.tag === tag) return node;
    return undefined;
  };
  const closeTo = (element: Element) => (current = element.parent ?? root);
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      current.children.push(decodeEntities(html.slice(i)));
      break;
    }
    if (lt > i) current.children.push(decodeEntities(html.slice(i, lt)));
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      i = tagEnd(html, lt);
      continue;
    }
    const closing = html[lt + 1] === '/';
    if (!isTagStart(html[closing ? lt + 2 : lt + 1])) {
      current.children.push('<');
      i = lt + 1;
      continue;
    }
    const end = tagEnd(html, lt);
    const body = html.slice(lt + (closing ? 2 : 1), html[end - 1] === '>' ? end - 1 : end);
    const name = (/^[^\s/>]+/.exec(body)?.[0] ?? '').toLowerCase();
    i = end;
    if (closing) {
      const element = open(name);
      if (element !== undefined) closeTo(element);
      continue;
    }
    const rule = CLOSES[name];
    if (rule !== undefined) {
      let outermost: Element | undefined;
      for (let node: Element | undefined = current; node !== undefined && !rule.within.includes(node.tag); node = node.parent) {
        if (rule.closes.includes(node.tag)) outermost = node;
      }
      if (outermost !== undefined) closeTo(outermost);
    }
    if (CLOSES_P.has(name)) {
      for (let node: Element | undefined = current; node !== undefined; node = node.parent) {
        if (node.tag === 'p') {
          closeTo(node);
          break;
        }
        if (BLOCKS.has(node.tag) || BOUNDARIES.has(node.tag)) break;
      }
    }
    const element: Element = { tag: name, attrs: attrsOf(body.slice(name.length)), children: [], parent: current };
    current.children.push(element);
    if (RAW_TEXT.has(name)) {
      const close = html.toLowerCase().indexOf(`</${name}`, i);
      const stop = close === -1 ? html.length : close;
      element.children.push(name === 'title' ? decodeEntities(html.slice(i, stop)) : html.slice(i, stop));
      i = close === -1 ? html.length : tagEnd(html, close);
      continue;
    }
    if (!VOID.has(name) && !body.trimEnd().endsWith('/')) current = element;
  }
  return root;
}

const isElement = (node: Node): node is Element => typeof node !== 'string';

function find(node: Element, tag: string): Element | undefined {
  for (const child of node.children) {
    if (!isElement(child)) continue;
    if (child.tag === tag) return child;
    const found = find(child, tag);
    if (found !== undefined) return found;
  }
  return undefined;
}

const hidden = (element: Element): boolean =>
  'hidden' in element.attrs || element.attrs['aria-hidden'] === 'true' || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(element.attrs['style'] ?? '');

const skipped = (element: Element): boolean => SKIPPED.has(element.tag) || hidden(element);

const collapse = (text: string): string => text.replace(/[\s ]+/g, ' ');

/** An element's visible text on one line. */
function textOf(node: Node): string {
  if (!isElement(node)) return node;
  if (skipped(node)) return '';
  if (node.tag === 'br') return ' ';
  if (node.tag === 'img') return node.attrs['alt'] ?? '';
  return node.children.map(textOf).join('');
}

const inlineText = (node: Node): string => collapse(textOf(node)).trim();

/** Lines of output, each with the prefixes of the blockquotes and list items it sits in. */
class Writer {
  private readonly lines: string[] = [];
  private line = '';
  private started = false;
  private breaks = 0;
  private readonly prefixes: { readonly first: string; readonly rest: string; used: boolean }[] = [];

  private prefix(): string {
    return this.prefixes
      .map((p) => {
        const text = p.used ? p.rest : p.first;
        p.used = true;
        return text;
      })
      .join('');
  }

  private newLine(): void {
    if (this.started) this.lines.push(this.line.trimEnd());
    // A blank line before a new blockquote or item belongs to what encloses it, so it takes only the prefixes already open.
    for (let i = 1; i < this.breaks && this.started; i++) this.lines.push(this.prefixes.filter((p) => p.used).map((p) => p.rest).join('').trimEnd());
    this.line = this.prefix();
    this.started = true;
    this.breaks = 0;
  }

  private get atLineStart(): boolean {
    return this.line.trim() === '' || /^[\s>]*(?:[-*] |\d+\. )?$/.test(this.line);
  }

  /** Inline text; runs of whitespace become one space. */
  text(raw: string): void {
    let text = collapse(raw);
    if (text === '' || (text === ' ' && (this.breaks > 0 || !this.started))) return;
    if (this.breaks > 0 || !this.started) {
      text = text.trimStart();
      if (text === '') return;
      this.newLine();
    }
    if (this.atLineStart || this.line.endsWith(' ')) text = text.trimStart();
    this.line += text;
  }

  /** Text that keeps its spaces, such as a link or inline code. */
  token(token: string): void {
    if (this.breaks > 0 || !this.started) this.newLine();
    this.line += token;
  }

  /** Lines that keep their spacing, such as a code block's. */
  verbatim(lines: readonly string[]): void {
    this.block();
    for (const line of lines) {
      this.breaks = Math.max(this.breaks, 1);
      this.newLine();
      this.line += line;
    }
    this.block();
  }

  block(): void {
    if (this.started) this.breaks = 2;
  }

  lineBreak(): void {
    if (this.started) this.breaks = Math.max(this.breaks, 1);
  }

  get nested(): boolean {
    return this.prefixes.length > 0;
  }

  /** Opens a blockquote or list item; `tight` separates it from what came before by a line break, not a blank line. */
  push(first: string, rest: string, tight = false): void {
    if (tight) this.lineBreak();
    else this.block();
    this.prefixes.push({ first, rest, used: false });
  }

  pop(tight = false): void {
    this.prefixes.pop();
    if (tight) this.lineBreak();
    else this.block();
  }

  done(): string {
    if (this.started) this.lines.push(this.line.trimEnd());
    return this.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
}

const absolute = (href: string, base: string | undefined): string | undefined => {
  if (href === '' || /^(?:javascript|data|vbscript):/i.test(href.trim())) return undefined;
  try {
    return base === undefined ? new URL(href).href : new URL(href, base).href;
  } catch {
    return href;
  }
};

function preText(node: Node): string {
  if (!isElement(node)) return node;
  if (node.tag === 'br') return '\n';
  if (skipped(node)) return '';
  return node.children.map(preText).join('');
}

const languageOf = (pre: Element): string => {
  const code = pre.children.find((child): child is Element => isElement(child) && child.tag === 'code');
  const classes = `${pre.attrs['class'] ?? ''} ${code?.attrs['class'] ?? ''} ${pre.attrs['data-language'] ?? ''}`;
  return /(?:language|lang)-([\w+#-]+)/.exec(classes)?.[1] ?? pre.attrs['data-language'] ?? '';
};

function table(element: Element, out: Writer): void {
  const rows: Element[] = [];
  const collect = (node: Element) => {
    for (const child of node.children) {
      if (!isElement(child) || skipped(child)) continue;
      if (child.tag === 'tr') rows.push(child);
      else if (child.tag !== 'table') collect(child);
    }
  };
  collect(element);
  const cells = rows.map((row) => row.children.filter((c): c is Element => isElement(c) && (c.tag === 'td' || c.tag === 'th')).map((c) => inlineText(c).replace(/\|/g, '\\|')));
  const width = Math.max(0, ...cells.map((row) => row.length));
  if (width === 0) return;
  const line = (row: readonly string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`;
  out.verbatim([line(cells[0]!), line(Array<string>(width).fill('---')), ...cells.slice(1).map(line)]);
}

function render(node: Node, out: Writer, base: string | undefined): void {
  if (!isElement(node)) {
    out.text(node);
    return;
  }
  if (skipped(node)) return;
  const children = () => {
    for (const child of node.children) render(child, out, base);
  };
  const { tag } = node;
  const heading = /^h([1-6])$/.exec(tag);
  if (heading !== null) {
    const text = inlineText(node);
    if (text !== '') {
      out.block();
      out.token(`${'#'.repeat(Number(heading[1]))} ${text}`);
      out.block();
    }
    return;
  }
  switch (tag) {
    case 'br':
      out.lineBreak();
      return;
    case 'hr':
      out.block();
      out.token('---');
      out.block();
      return;
    case 'pre': {
      const text = preText(node).replace(/^\n/, '').replace(/\s+$/, '');
      const fenceMark = /```/.test(text) ? '~~~~' : '```';
      out.verbatim([`${fenceMark}${languageOf(node)}`, ...text.split('\n'), fenceMark]);
      return;
    }
    case 'code':
    case 'kbd':
    case 'samp': {
      const text = collapse(textOf(node));
      if (text.trim() !== '') out.token(text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``);
      return;
    }
    case 'a': {
      const text = inlineText(node);
      const raw = node.attrs['href'] ?? '';
      const href = raw.startsWith('#') ? undefined : absolute(raw, base);
      if (text === '') return;
      out.token(href === undefined ? text : `[${text}](${href})`);
      return;
    }
    case 'img': {
      const alt = collapse(node.attrs['alt'] ?? '').trim();
      if (alt !== '') out.token(`![${alt}]`);
      return;
    }
    case 'strong':
    case 'b': {
      const text = inlineText(node);
      if (text !== '') out.token(`**${text}**`);
      return;
    }
    case 'em':
    case 'i': {
      const text = inlineText(node);
      if (text !== '') out.token(`*${text}*`);
      return;
    }
    case 'blockquote':
      out.push('> ', '> ');
      children();
      out.pop();
      return;
    case 'ul':
    case 'ol': {
      let n = Number(node.attrs['start'] ?? 1) || 1;
      const tight = out.nested;
      if (tight) out.lineBreak();
      else out.block();
      for (const child of node.children) {
        if (isElement(child) && child.tag === 'li') {
          if (skipped(child)) continue;
          const marker = tag === 'ol' ? `${n++}. ` : '- ';
          out.push(marker, ' '.repeat(marker.length), true);
          for (const grandchild of child.children) render(grandchild, out, base);
          out.pop(true);
        } else render(child, out, base);
      }
      if (tight) out.lineBreak();
      else out.block();
      return;
    }
    case 'table':
      table(node, out);
      return;
    case 'td':
    case 'th':
      out.text(' ');
      children();
      out.text(' ');
      return;
    case 'tr':
    case 'dt':
      out.lineBreak();
      children();
      out.lineBreak();
      return;
    case 'dd':
      out.push(': ', '  ');
      children();
      out.pop();
      return;
  }
  const block = BLOCKS.has(tag);
  if (block) out.block();
  children();
  if (block) out.block();
}

export type PageMarkdown = { readonly title: string | undefined; readonly markdown: string };

/**
 * A page's title and its main content as markdown. The content is the page's `<main>`, else its first `<article>`,
 * else its body; navigation, footers, asides, scripts and hidden elements are left out. Links become absolute
 * against `base`.
 */
export function htmlToMarkdown(html: string, base?: string): PageMarkdown {
  const root = parseHtml(html);
  const titleNode = find(root, 'title');
  const titleText = titleNode === undefined ? '' : inlineText(titleNode);
  const content = find(root, 'main') ?? find(root, 'article') ?? find(root, 'body') ?? root;
  const out = new Writer();
  render(content, out, base);
  const markdown = out.done();
  const h1 = find(content, 'h1');
  const title = titleText !== '' ? titleText : h1 === undefined ? undefined : inlineText(h1) || undefined;
  return { title, markdown };
}
