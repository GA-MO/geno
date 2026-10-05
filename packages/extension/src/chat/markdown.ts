/// <reference lib="dom" />
import { lexer, type MarkedToken, type Token, type Tokens } from 'marked';
import { h, icon, type Child } from './dom.js';
import { highlight } from './highlight.js';

/**
 * Assistant markdown as DOM. marked only tokenizes; every node here is built from token fields as text, and raw
 * HTML from the model is shown as the text it is, so the model can never inject markup or script.
 */

export type MarkdownContext = { readonly copy: (text: string) => void };

type Kind = MarkedToken['type'];
/** A renderer per token type; a type missing from a table is shown as its source text. */
type Renderers = { readonly [K in Kind]?: (token: Extract<MarkedToken, { type: K }>, ctx: MarkdownContext) => Child };

function render(table: Renderers, token: Token, ctx: MarkdownContext, fallback: (raw: string) => Child): Child {
  const renderer = table[token.type as Kind] as ((t: Token, c: MarkdownContext) => Child) | undefined;
  return renderer === undefined ? fallback(token.raw) : renderer(token, ctx);
}

/** Links open in the browser through VS Code; any other scheme is shown as text. */
const SAFE_LINK = /^(https?:|mailto:)/i;

const inline = (tokens: readonly Token[] | undefined, ctx: MarkdownContext): Child[] => (tokens ?? []).map((token) => inlineNode(token, ctx));

const INLINE: Renderers = {
  text: (t, ctx) => (t.tokens === undefined ? t.text : h('span', {}, ...inline(t.tokens, ctx))),
  escape: (t) => t.text,
  strong: (t, ctx) => h('strong', {}, ...inline(t.tokens, ctx)),
  em: (t, ctx) => h('em', {}, ...inline(t.tokens, ctx)),
  del: (t, ctx) => h('del', {}, ...inline(t.tokens, ctx)),
  codespan: (t) => h('code', {}, t.text),
  br: () => h('br'),
  link: (t, ctx) =>
    SAFE_LINK.test(t.href) ? h('a', { href: t.href, title: t.title ?? t.href }, ...inline(t.tokens, ctx)) : h('span', {}, ...inline(t.tokens, ctx)),
  image: (t) => (SAFE_LINK.test(t.href) ? h('a', { href: t.href, title: t.href }, t.text || t.href) : t.text),
  html: (t) => t.raw,
  checkbox: (t) => icon(t.checked ? 'pass-filled' : 'circle-large-outline', 'task'),
};

const inlineNode = (token: Token, ctx: MarkdownContext): Child => render(INLINE, token, ctx, (raw) => raw);

function codeBlock(code: string, lang: string | undefined, ctx: MarkdownContext): HTMLElement {
  const label = lang?.trim().split(/\s/)[0] || undefined;
  const copy = h(
    'button',
    {
      class: 'icon-button copy',
      title: 'Copy',
      'aria-label': 'Copy code',
      onclick: () => {
        ctx.copy(code);
        copy.replaceChildren(icon('check'));
        setTimeout(() => copy.replaceChildren(icon('copy')), 1500);
      },
    },
    icon('copy'),
  );
  const pre = h('pre', {}, h('code', {}, ...highlight(code, label)));
  return h('div', { class: 'code-block' }, h('div', { class: 'code-toolbar' }, label !== undefined && h('span', { class: 'code-lang' }, label), copy), pre);
}

function listItem(item: Tokens.ListItem, ctx: MarkdownContext): HTMLElement {
  return h('li', { class: item.task ? 'task-item' : undefined }, ...blocks(item.tokens, ctx));
}

const BLOCK: Renderers = {
  space: () => undefined,
  def: () => undefined,
  paragraph: (t, ctx) => h('p', {}, ...inline(t.tokens, ctx)),
  // Inside a tight list item marked yields bare text tokens for its lines.
  text: (t, ctx) => h('span', {}, ...(t.tokens === undefined ? [t.text] : inline(t.tokens, ctx))),
  heading: (t, ctx) => h(`h${Math.min(Math.max(t.depth, 1), 6)}` as 'h1', {}, ...inline(t.tokens, ctx)),
  code: (t, ctx) => codeBlock(t.text, t.lang, ctx),
  blockquote: (t, ctx) => h('blockquote', {}, ...blocks(t.tokens, ctx)),
  hr: () => h('hr'),
  html: (t) => h('p', {}, t.raw),
  list: (t, ctx) =>
    t.ordered
      ? h('ol', { start: t.start === '' || t.start === 1 ? undefined : t.start }, ...t.items.map((item) => listItem(item, ctx)))
      : h('ul', {}, ...t.items.map((item) => listItem(item, ctx))),
  table: (t, ctx) => {
    const cell = (tag: 'th' | 'td', c: Tokens.TableCell) => h(tag, { class: c.align === null ? undefined : `align-${c.align}` }, ...inline(c.tokens, ctx));
    return h(
      'div',
      { class: 'table-scroll' },
      h('table', {}, h('thead', {}, h('tr', {}, ...t.header.map((c) => cell('th', c)))), h('tbody', {}, ...t.rows.map((row) => h('tr', {}, ...row.map((c) => cell('td', c)))))),
    );
  },
};

function blocks(tokens: readonly Token[], ctx: MarkdownContext): Child[] {
  return tokens.map((token) => render(BLOCK, token, ctx, (raw) => h('p', {}, raw)));
}

export function renderMarkdown(text: string, ctx: MarkdownContext): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const child of blocks(lexer(text, { gfm: true }), ctx)) if (child !== undefined && child !== false) fragment.append(child);
  return fragment;
}
