/// <reference lib="dom" />
import type { ToView } from '../../src/chat/messages.js';
import { compose, composePeek, PEEK_MOVES, playhead, POSES, svgOf, type Grid, type PeekFrame, type Pose } from '../../src/chat/sprite.js';
import { TOKENS_STYLE_ID, tokenStyle } from '../../src/chat/tokens.js';
import { TICK_MS } from '../../src/chat/wander.js';

/**
 * The design-system page: everything on it is read from the panel's own stylesheet as the page loaded it, under the
 * gallery's theme and look, so a token the gallery changes changes here too.
 */

type Found = {
  /** Each Geno token and the selectors that declare it. */
  readonly tokens: Map<string, Set<string>>;
  readonly fontSizes: Map<string, number>;
  readonly spacing: Map<string, number>;
  readonly radii: Map<string, number>;
};

const SPACING = ['gap', 'row-gap', 'column-gap', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left'];
const RADII = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'];

function readSheets(): Found {
  const found: Found = { tokens: new Map(), fontSizes: new Map(), spacing: new Map(), radii: new Map() };
  const count = (map: Map<string, number>, value: string) => {
    if (value !== '' && !/^(0|0px|auto|inherit|initial|unset)$/.test(value)) map.set(value, (map.get(value) ?? 0) + 1);
  };
  const walk = (rules: CSSRuleList, scope: string) => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        const selector = rule.selectorText.startsWith('&') && scope !== '' ? `${scope} ${rule.selectorText.slice(1).trim()}` : rule.selectorText;
        for (const property of rule.style) {
          const value = rule.style.getPropertyValue(property).trim();
          if (property.startsWith('--') && !property.startsWith('--vscode-')) {
            const at = found.tokens.get(property) ?? new Set<string>();
            found.tokens.set(property, at.add(selector));
          } else if (property === 'font-size') count(found.fontSizes, value);
          else if (SPACING.includes(property)) count(found.spacing, value);
          else if (RADII.includes(property)) count(found.radii, value);
        }
        walk(rule.cssRules, selector);
      } else if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules, scope);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules, '');
    } catch {
      // A sheet from another origin cannot be read; the panel loads none.
    }
  }
  return found;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string | false)[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  for (const child of children) if (child !== false) element.append(child);
  return element;
}

const ROOTS = new Set([':root', 'body', 'html']);
const atRoot = (selectors: ReadonlySet<string>) => [...selectors].some((s) => ROOTS.has(s) || s.startsWith('body[') || s.startsWith('body.') || s.startsWith(':root'));

/** `value` resolved as `property` on a probe in the body, in px for a length. */
function resolve(property: string, value: string): string {
  const probe = h('div', { class: 'ds-probe' });
  probe.style.setProperty(property, value);
  document.body.append(probe);
  const resolved = getComputedStyle(probe).getPropertyValue(property);
  probe.remove();
  return resolved;
}

const byPx = (map: Map<string, number>, property: string) => {
  const rows = new Map<string, { px: number; values: string[]; uses: number }>();
  for (const [value, uses] of map) {
    const resolved = resolve(property, value);
    const px = parseFloat(resolved);
    if (!Number.isFinite(px) || !resolved.endsWith('px') || resolved.includes(' ')) continue;
    const row = rows.get(resolved) ?? { px, values: [], uses: 0 };
    row.values.push(value);
    row.uses += uses;
    rows.set(resolved, row);
  }
  return [...rows.entries()].sort((a, b) => b[1].px - a[1].px);
};

const groupOf = (name: string, all: readonly string[]) => {
  const prefix = name.slice(2).split('-')[0]!;
  return all.filter((n) => n.slice(2).split('-')[0] === prefix).length > 1 ? prefix : 'base';
};

const sprite = (grid: Grid, label: string) => {
  const box = h('figure', { class: 'ds-sprite' });
  const art = h('div', { class: 'ds-sprite-art', role: 'img', 'aria-label': label });
  art.innerHTML = svgOf(grid);
  box.append(art, h('figcaption', {}, label));
  return { box, art };
};

let timers: number[] = [];

function render(): void {
  for (const timer of timers) clearInterval(timer);
  timers = [];
  const found = readSheets();
  const body = getComputedStyle(document.body);
  const names = [...found.tokens.keys()].sort();
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const tokenGroups = [...new Set(names.map((n) => groupOf(n, names)))].sort((a, b) => (a === 'base' ? -1 : b === 'base' ? 1 : a.localeCompare(b)));
  const colors = h(
    'section',
    { class: 'ds-section' },
    h('h2', {}, `Tokens (${names.length})`),
    h('p', { class: 'ds-note' }, 'Every custom property the stylesheet declares, apart from VS Code’s own, with its value in this theme and look. A token set only inside a component shows where.'),
    ...tokenGroups.map((group) =>
      h(
        'div',
        { class: 'ds-group' },
        h('h3', {}, group),
        h(
          'ul',
          { class: 'ds-tokens' },
          ...names
            .filter((n) => groupOf(n, names) === group)
            .map((name) => {
              const selectors = found.tokens.get(name)!;
              const value = body.getPropertyValue(name).trim();
              const color = value !== '' && CSS.supports('color', value);
              const swatch = h('span', { class: `ds-swatch${color ? '' : ' none'}` });
              if (color) swatch.style.background = `var(${name})`;
              return h(
                'li',
                { class: 'ds-token', 'data-token': name },
                swatch,
                h('code', { class: 'ds-name' }, name),
                h('span', { class: 'ds-value' }, value === '' ? '' : value),
                !atRoot(selectors) && h('span', { class: 'ds-scope' }, `on ${[...selectors].slice(0, 3).join(', ')}`),
              );
            }),
        ),
      ),
    ),
  );

  const scale = (title: string, note: string, rows: ReturnType<typeof byPx>, draw: (px: number) => HTMLElement) =>
    h(
      'section',
      { class: 'ds-section' },
      h('h2', {}, title),
      h('p', { class: 'ds-note' }, note),
      h('ul', { class: 'ds-scale' }, ...rows.map(([resolved, row]) => h('li', {}, draw(row.px), h('span', { class: 'ds-px' }, resolved), h('code', { class: 'ds-from' }, row.values.slice(0, 4).join(' · ')), h('span', { class: 'ds-uses' }, `${row.uses}×`)))),
    );
  const type = scale('Type scale', 'Each font size the stylesheet sets, resolved in this theme, largest first.', byPx(found.fontSizes, 'font-size'), (px) => {
    const sample = h('span', { class: 'ds-type' }, 'Noodle reads the diff');
    sample.style.fontSize = `${px}px`;
    return sample;
  });
  const spacing = scale('Spacing', 'Gaps, padding and margins the stylesheet sets, resolved, largest first.', byPx(found.spacing, 'padding-top'), (px) => {
    const bar = h('span', { class: 'ds-bar' });
    bar.style.width = `${Math.min(px, 160)}px`;
    return bar;
  });
  const radii = scale('Radii', 'Corner radii the stylesheet sets, resolved, largest first.', byPx(found.radii, 'border-top-left-radius'), (px) => {
    const corner = h('span', { class: 'ds-corner' });
    corner.style.borderRadius = `${px}px`;
    return corner;
  });

  const data = JSON.parse(document.getElementById('design-data')?.textContent ?? '{"icons":[]}') as { icons: string[] };
  const icons = h(
    'section',
    { class: 'ds-section' },
    h('h2', {}, `Icons (${data.icons.length})`),
    h('p', { class: 'ds-note' }, 'Every codicon the panel’s source draws.'),
    h('ul', { class: 'ds-icons' }, ...data.icons.map((name) => h('li', { title: name }, h('span', { class: `codicon codicon-${name}`, 'aria-hidden': 'true' }), h('code', {}, name)))),
  );

  function animated<F extends { readonly hold?: number }>(pose: Pose<F>, draw: (frame: F) => Grid, label: string): HTMLElement {
    const { box, art } = sprite(draw(playhead(pose, 0, true).frame), label);
    if (!still) {
      let t = 0;
      timers.push(window.setInterval(() => (art.innerHTML = svgOf(draw(playhead(pose, ++t, true).frame))), TICK_MS));
    }
    return box;
  }
  const dino = h(
    'section',
    { class: 'ds-section' },
    h('h2', {}, 'Noodle'),
    h('p', { class: 'ds-note' }, still ? 'Each pose and peek move, held on its first frame under reduced motion.' : 'Each pose and peek move, playing at the panel’s tick.'),
    h('div', { class: 'ds-sprites' }, ...Object.entries(POSES).map(([name, pose]) => animated(pose, compose, name))),
    h('h3', {}, 'Peek'),
    h('div', { class: 'ds-sprites' }, ...Object.entries(PEEK_MOVES).map(([name, move]) => animated<PeekFrame>(move, composePeek, name))),
  );

  const kind = [...document.body.classList].find((c) => c.startsWith('vscode-')) ?? '';
  const page = h('main', { class: 'ds' });
  page.append(
    h('header', { class: 'ds-head' }, h('h1', {}, 'Geno design system'), h('p', { class: 'ds-note' }, `${document.body.dataset['vscodeThemeName'] ?? kind}, ${document.body.dataset['style'] ?? ''} style. Read from the stylesheet as loaded.`)),
    colors,
    type,
    spacing,
    radii,
    icons,
    dino,
  );
  document.body.replaceChildren(page);
}

window.addEventListener('message', (event: MessageEvent<ToView>) => {
  if (event.data.type !== 'look') return;
  document.body.dataset['style'] = event.data.look.style;
  document.body.dataset['detail'] = event.data.look.detail;
  document.getElementById(TOKENS_STYLE_ID)!.textContent = tokenStyle(event.data.look.tokens);
  requestAnimationFrame(render);
});

render();
