import { describe, expect, it } from 'vitest';
import { answerTitle, dataUri, imageHrefs, markdownHtml, PAGE_THEME, pageCsp, pageFileName, renderPage, type PageDocument, type PagePart } from '../src/share-page.js';
import { frameCsp, frameDocument, themeCss } from '../src/widget-frame.js';

const NONCE = 'cGFnZS1ub25jZS0xMjM0NQ==';
const PNG = dataUri('image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 412.5 120" style="max-width: 412px"><text>A</text></svg>';

const page = (parts: readonly PagePart[], extra: Partial<PageDocument> = {}): string =>
  renderPage({ title: 'Speed', parts, images: new Map(), diagrams: new Map(), theme: PAGE_THEME, nonce: NONCE, ...extra });

const META = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/g;
const unescapeAttr = (text: string): string => text.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const srcdocs = (html: string): string[] => [...html.matchAll(/srcdoc="([^"]*)"/g)].map((m) => unescapeAttr(m[1]!));
/** The page with each frame's document cut out: what the page itself parses as markup. */
const outside = (html: string): string => html.replace(/srcdoc="[^"]*"/g, 'srcdoc=""');

const RICH: readonly PagePart[] = [
  { kind: 'request', text: 'Where does a run spend its time?' },
  {
    kind: 'markdown',
    text: [
      '# Timing',
      'See [the docs](https://example.com/docs) and ![local](shots/a.png) and ![remote](https://example.com/remote.png).',
      '```mermaid\nflowchart LR\n  A --> B\n```',
      '```ts\nconst answer: number = 42;\n```',
    ].join('\n\n'),
  },
  { kind: 'widget', title: 'Bars', html: '<img src="https://example.com/beacon.png"><script>fetch("https://example.com/x")</script>' },
];
const RICH_ASSETS = { images: new Map([['shots/a.png', PNG]]), diagrams: new Map([['flowchart LR\n  A --> B', { svg: SVG, scheme: 'dark' as const }]]) };

describe('a shared page', () => {
  it('has one policy, the widget frame’s, first in the head: no network, scripts only with the nonce', () => {
    const html = page(RICH, RICH_ASSETS);
    expect(pageCsp(NONCE)).toBe(frameCsp(NONCE));
    expect([...outside(html).matchAll(META)].map((m) => m[1])).toEqual([pageCsp(NONCE)]);
    expect(pageCsp(NONCE)).toContain("default-src 'none'");
    expect(pageCsp(NONCE)).not.toMatch(/connect-src|https?:/);
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<style'));
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
  });

  it('runs one script of its own, with the nonce, and every script in it needs that nonce', () => {
    const html = outside(page(RICH, RICH_ASSETS));
    expect(html.match(/<script[^>]*>/g)).toEqual([`<script nonce="${NONCE}">`]);
  });

  it('references no http or https resource: every image is a data URI, and web addresses are only links', () => {
    const html = outside(page(RICH, RICH_ASSETS));
    expect(html).not.toMatch(/\b(src|srcset|poster|data|action|background|formaction)\s*=\s*["']?\s*(https?:)?\/\//i);
    expect(html).not.toMatch(/url\(\s*["']?\s*(https?:)?\/\//i);
    expect(html).not.toMatch(/<link\b|@import|<base\b|<object\b|<embed\b/i);
    const sources = [...html.matchAll(/\ssrc="([^"]*)"/g)].map((m) => m[1]!);
    expect(sources).toHaveLength(2);
    expect(sources.every((src) => src.startsWith('data:image/'))).toBe(true);
    const webAddresses = [...html.matchAll(/https?:\/\/[^\s"'<)]*/g)].map((m) => m[0]);
    const links = [...html.matchAll(/<a href="(https?:[^"]*)"/g)].map((m) => m[1]);
    expect(webAddresses.every((address) => links.includes(address) || html.includes(`title="${address}"`))).toBe(true);
    expect(links).toEqual(['https://example.com/docs', 'https://example.com/remote.png']);
  });

  it('runs a widget in the same sandboxed frame as the panel, under the same policy and the page’s nonce', () => {
    const html = page(RICH, RICH_ASSETS);
    expect(html).toMatch(/<iframe class="widget-frame" title="Bars" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="/);
    expect(html).not.toContain('allow-same-origin');
    const [frame] = srcdocs(html);
    expect(frame).toBe(frameDocument({ html: RICH[2]!.kind === 'widget' ? RICH[2]!.html : '', nonce: NONCE, theme: { light: PAGE_THEME.light, dark: PAGE_THEME.dark } }));
    expect([...frame!.matchAll(META)].map((m) => m[1])).toEqual([frameCsp(NONCE)]);
  });

  it('bakes in light and dark colors, the dark ones under prefers-color-scheme, for the page and its widgets', () => {
    const html = page(RICH, RICH_ASSETS);
    const css = themeCss({ light: PAGE_THEME.light, dark: PAGE_THEME.dark });
    expect(css).toMatch(/^:root\{color-scheme:light;--bg:#f5f5f5;.*\}@media \(prefers-color-scheme: dark\)\{:root\{color-scheme:dark;--bg:#1e1e20;.*\}\}$/);
    expect(outside(html)).toContain(css);
    expect(srcdocs(html)[0]).toContain(css);
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
  });

  it('escapes the title, the request and the model’s markdown, so none of it becomes markup', () => {
    const html = outside(
      page(
        [
          { kind: 'request', text: '</div><script>alert(1)</script>' },
          { kind: 'markdown', text: '<script>alert(2)</script>\n\nInline <script>alert(5)</script> and <img src=x onerror=alert(3)>\n\n[click](javascript:alert(4)) `<b>`\n\n<iframe src="https://evil.example"></iframe>' },
        ],
        { title: 'A <b>"title"</b>' },
      ),
    );
    expect(html).toContain('<title>A &lt;b&gt;"title"&lt;/b&gt;</title>');
    expect(html).toContain('<h1 class="page-title">A &lt;b&gt;"title"&lt;/b&gt;</h1>');
    expect(html).toContain('&lt;/div&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).not.toMatch(/<img|<iframe|<[^>]*onerror|href="javascript/);
    expect(html).toContain('<code>&lt;b&gt;</code>');
    expect(html).toContain('click');
  });

  it('shows a widget’s title as its caption unless the page is named for it', () => {
    expect(page([{ kind: 'widget', title: 'Speed', html: '' }])).not.toContain('<figcaption>');
    expect(page([{ kind: 'widget', title: 'Bars & <lines>', html: '' }])).toContain('<figcaption>Bars &amp; &lt;lines&gt;</figcaption>');
  });

  it('refuses a nonce that could break out of its attribute', () => {
    expect(() => page([], { nonce: 'a" onload="x' })).toThrow('not a nonce');
  });
});

describe('markdown on a page', () => {
  const none = { images: new Map(), diagrams: new Map() };

  it('colors code with the panel’s grammars, under a caption naming the language', () => {
    expect(markdownHtml('```ts\nconst a = "<x>";\n```', none)).toBe(
      '<div class="code"><span class="code-lang">ts</span><pre><code><span class="token keyword">const</span> a <span class="token operator">=</span> <span class="token string">"&lt;x&gt;"</span><span class="token punctuation">;</span></code></pre></div>',
    );
    expect(markdownHtml('```\n<plain>\n```', none)).toBe('<div class="code"><pre><code>&lt;plain&gt;</code></pre></div>');
  });

  it('draws a mermaid fence the panel drew as an SVG image on the surface it was drawn for, and shows its source otherwise', () => {
    const source = 'flowchart LR\n  A --> B';
    const drawn = markdownHtml(`\`\`\`mermaid\n${source}\n\`\`\``, { images: new Map(), diagrams: new Map([[source, { svg: SVG, scheme: 'light' }]]) });
    const [, data, width] = /^<figure class="diagram diagram-light"><img src="data:image\/svg\+xml;base64,([^"]+)" alt="Diagram" width="(\d+)"><\/figure>$/.exec(drawn)!;
    expect(new TextDecoder().decode(Uint8Array.from(atob(data!), (c) => c.charCodeAt(0)))).toBe(SVG);
    expect(width).toBe('413');
    expect(markdownHtml(`\`\`\`mermaid\n${source}\n\`\`\``, none)).toContain('<span class="code-lang">mermaid</span>');
  });

  it('inlines an image it has data for, links a web image, and shows any other as its alt text', () => {
    const html = markdownHtml('![a](a.png) ![b](https://example.com/b.png) ![c](file:///etc/c.png)', { images: new Map([['a.png', PNG]]), diagrams: new Map() });
    expect(html).toBe(`<p><img src="${PNG}" alt="a"> <a href="https://example.com/b.png" title="https://example.com/b.png" rel="noopener noreferrer">b</a> c</p>`);
  });

  it('renders tables, task lists and numbered lists that start late', () => {
    expect(markdownHtml('| a | b |\n|:-:|--:|\n| 1 | 2 |', none)).toBe(
      '<div class="table-scroll"><table><thead><tr><th class="align-center">a</th><th class="align-right">b</th></tr></thead><tbody><tr><td class="align-center">1</td><td class="align-right">2</td></tr></tbody></table></div>',
    );
    expect(markdownHtml('- [x] done\n- [ ] next', none)).toBe('<ul><li class="task"><input type="checkbox" disabled checked> done</li><li class="task"><input type="checkbox" disabled> next</li></ul>');
    expect(markdownHtml('3. c\n4. d', none)).toBe('<ol start="3"><li>c</li><li>d</li></ol>');
  });

  it('lists the images it shows, in lists and tables too, once each', () => {
    expect(imageHrefs('![a](a.png)\n\n- ![b](b.png)\n\n| x |\n|---|\n| ![c](c.png) ![a](a.png) |')).toEqual(['a.png', 'b.png', 'c.png']);
  });
});

describe('naming a page', () => {
  it('calls an answer by its first heading, else the first line asked, else Answer', () => {
    expect(answerTitle('ignored', 'Intro\n\n## The **cache** plan\n\ntext')).toBe('The cache plan');
    expect(answerTitle('\n  Why is the build slow?\nmore', 'No heading here.')).toBe('Why is the build slow?');
    expect(answerTitle('', 'text')).toBe('Answer');
    expect(answerTitle('x'.repeat(200), '')).toBe(`${'x'.repeat(79)}…`);
  });

  it('names the file from the title in any script, never empty', () => {
    expect(pageFileName('Where a run spends its time')).toBe('where-a-run-spends-its-time.html');
    expect(pageFileName('แผนการ cache ของ Next.js')).toBe('แผนการ-cache-ของ-next-js.html');
    expect(pageFileName('?!')).toBe('page.html');
    expect(pageFileName('a'.repeat(100))).toBe(`${'a'.repeat(60)}.html`);
  });
});
