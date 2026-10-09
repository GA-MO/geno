/// <reference lib="dom" />
import { CHAT_DETAILS, UI_STYLES, type ChatDetail, type Look, type ToView, type UiStyle } from '../../src/chat/messages.js';
import { themeKindOf, themeTokensOf, tokenNamesIn, tokenValueProblem, type ThemeKind, type ThemeTokens } from '../../src/chat/tokens.js';
import { REVIEW_MODES, type ReviewMode } from '../../src/review/mode.js';
import { answerReady, FakeHost } from '../webview/host.js';
import type { ThemeDump, ThemeSlug } from '../webview/theme.js';
import { overflowing } from './checks.js';
import { FIXTURES, GROUPS } from './fixtures.js';
import type { Fixture, Stage } from './stage.js';

type Mode = 'grid' | 'single';
type View = 'states' | 'design';

type Controls = {
  readonly view: View;
  readonly mode: Mode;
  readonly selected: string;
  /** The group the grid shows, or every group. */
  readonly group: string | undefined;
  readonly query: string;
  readonly theme: ThemeSlug;
  readonly style: UiStyle;
  readonly detail: ChatDetail;
  readonly review: ReviewMode;
  readonly width: number;
  readonly reduced: boolean;
  readonly tokensOpen: boolean;
  readonly tokens: ThemeTokens;
};

const THEME_NAMES: Readonly<Record<ThemeSlug, string>> = { dark: 'Dark Modern', light: 'Light Modern', 'high-contrast': 'Dark High Contrast', 'high-contrast-light': 'Light High Contrast' };
const KIND_NAMES: Readonly<Record<ThemeKind, string>> = { dark: 'dark', light: 'light', highContrast: 'high contrast', highContrastLight: 'high contrast light' };
const THEME_SLUGS = Object.keys(THEME_NAMES) as readonly ThemeSlug[];
const WIDTHS = [300, 420, 600] as const;
const STORE = 'geno-ui-gallery';

const DEFAULTS: Controls = {
  view: 'states',
  mode: 'grid',
  selected: FIXTURES[0]!.id,
  group: undefined,
  query: '',
  theme: 'dark',
  style: 'glass',
  detail: 'compact',
  review: 'auto',
  width: 420,
  reduced: false,
  tokensOpen: false,
  tokens: {},
};

function restore(): Controls {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Partial<Controls>;
    return { ...DEFAULTS, ...saved };
  } catch {
    return DEFAULTS;
  }
}

let controls = restore();
const save = () => {
  try {
    localStorage.setItem(STORE, JSON.stringify(controls));
  } catch {
    // A private window keeps no storage; the gallery works without it.
  }
};

const themes = new Map<ThemeSlug, ThemeDump>();
await Promise.all(THEME_SLUGS.map(async (slug) => themes.set(slug, (await (await fetch(`/themes/${slug}.json`)).json()) as ThemeDump)));
const TOKEN_NAMES = tokenNamesIn(await (await fetch('/webview.css')).text());
const KNOWN = new Set(TOKEN_NAMES);

const kindOf = (slug: ThemeSlug): ThemeKind => {
  const classes = themes.get(slug)!.bodyClasses;
  return themeKindOf({ contains: (name) => classes.includes(name) });
};
const backdropOf = (slug: ThemeSlug) => /--vscode-sideBar-background:\s*(#[0-9a-fA-F]+)/.exec(themes.get(slug)!.htmlStyle)?.[1] ?? '#1e1e1e';

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string | false | undefined)[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on')) element.addEventListener(key.slice(2), value as EventListener);
    else if (key in element && typeof value !== 'string') (element as unknown as Record<string, unknown>)[key] = value;
    else element.setAttribute(key, String(value));
  }
  for (const child of children) if (child !== undefined && child !== false) element.append(child);
  return element;
}

/** One frame of the real panel, the fixture that drives it, and what went wrong in it. */
type Mounted = {
  readonly fixture: Fixture;
  readonly iframe: HTMLIFrameElement;
  readonly host: FakeHost;
  readonly errors: string[];
  overflow: readonly string[];
  readonly badge: HTMLElement;
};

const mounted = new Map<HTMLIFrameElement, Mounted>();

const lookFor = (fixture: Fixture | undefined): Look => ({ style: controls.style, detail: controls.detail, review: controls.review, ...fixture?.look, tokens: controls.tokens });

const frameQuery = (look: Look) => new URLSearchParams({ theme: controls.theme, style: look.style, detail: look.detail, review: look.review, ...(controls.reduced ? { motion: 'reduce' } : {}) }).toString();

/** Delivers `message` into the frame as VS Code does, cloned into the frame's own realm. */
function deliver(iframe: HTMLIFrameElement, message: ToView): Promise<void> {
  const view = iframe.contentWindow as (Window & typeof globalThis) | null;
  if (view === null) return Promise.resolve();
  view.dispatchEvent(new view.MessageEvent('message', { data: view.structuredClone(message) }));
  return Promise.resolve();
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stageOf(iframe: HTMLIFrameElement, host: FakeHost): Stage {
  const doc = () => iframe.contentDocument!;
  const find = (selector: string) => doc().querySelector<HTMLElement>(selector);
  const shows = async (selector: string) => {
    for (let waited = 0; find(selector) === null; waited += 50) {
      if (waited > 5000) throw new Error(`the panel never showed ${selector}`);
      await pause(50);
    }
  };
  return {
    host,
    shows,
    click: async (selector) => {
      await shows(selector);
      find(selector)!.click();
    },
    fill: async (selector, text) => {
      await shows(selector);
      const field = find(selector) as HTMLTextAreaElement | HTMLInputElement;
      const view = doc().defaultView!;
      field.focus({ preventScroll: true });
      field.value = text;
      field.dispatchEvent(new view.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    },
    reveal: async (selector) => {
      await shows(selector);
      await frames(doc().defaultView!);
      find(selector)!.scrollIntoView({ block: 'start' });
    },
  };
}

const frames = (view: Window) => new Promise<void>((resolve) => view.requestAnimationFrame(() => view.requestAnimationFrame(() => resolve())));

function showBadge(m: Mounted): void {
  const problems = [...m.errors.map((e) => `Error: ${e}`), ...m.overflow.map((o) => `Overflow: ${o}`)];
  m.badge.textContent = problems.length === 0 ? '' : `${m.errors.length > 0 ? `${m.errors.length} error${m.errors.length === 1 ? '' : 's'}` : ''}${m.errors.length > 0 && m.overflow.length > 0 ? ' · ' : ''}${m.overflow.length > 0 ? `${m.overflow.length} past the edge` : ''}`;
  m.badge.title = problems.join('\n');
  m.badge.hidden = problems.length === 0;
}

async function check(m: Mounted): Promise<void> {
  const view = m.iframe.contentWindow;
  if (view === null || m.iframe.contentDocument?.body == null) return;
  await frames(view);
  m.overflow = overflowing(m.iframe.contentDocument);
  showBadge(m);
}

function mount(fixture: Fixture, height: number): { readonly iframe: HTMLIFrameElement; readonly badge: HTMLElement } {
  const look = lookFor(fixture);
  const iframe = h('iframe', { class: 'panel-frame', title: fixture.title, src: `/panel.html?${frameQuery(look)}` });
  iframe.style.width = `${controls.width}px`;
  iframe.style.height = `${height}px`;
  const badge = h('span', { class: 'badge', hidden: true });
  const host = new FakeHost((message) => deliver(iframe, message), { model: 'qwen3.8-flash', turns: [] });
  const m: Mounted = { fixture, iframe, host, errors: [], overflow: [], badge };
  host.on('ready', async () => {
    await answerReady(host, fixture.focused ?? true);
    if (Object.keys(controls.tokens).length > 0) await host.post({ type: 'look', look });
    try {
      await fixture.play(stageOf(iframe, host));
    } catch (error) {
      m.errors.push(`the fixture failed: ${String(error)}`);
    }
    await check(m);
    tokenPanel.refresh();
  });
  mounted.set(iframe, m);
  new ResizeObserver(() => void check(m)).observe(iframe);
  return { iframe, badge };
}

/** Called by each frame's stub before the panel's own script runs, so nothing it logs is missed. */
function attach(iframe: HTMLIFrameElement, view: Window & typeof globalThis): void {
  const m = mounted.get(iframe);
  if (m === undefined) return;
  const add = (text: string) => {
    m.errors.push(text);
    showBadge(m);
  };
  for (const type of ['wheel', 'keydown', 'touchmove']) view.addEventListener(type, () => void (userAt = Date.now()), { passive: true });
  // In VS Code each panel has the window to itself. Here, panels that each take the focus as a card arrives would pass
  // it back and forth for ever, so a panel takes it only while no other frame holds it, and in the grid without scrolling.
  const focus = view.HTMLElement.prototype.focus;
  view.HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
    const active = document.activeElement;
    if (active === iframe || active === document.body || active === null) focus.call(this, { ...options, preventScroll: controls.mode === 'grid' || options?.preventScroll === true });
  };
  view.addEventListener('error', (event) => add(event.message));
  view.addEventListener('unhandledrejection', (event) => add(String(event.reason)));
  view.document.addEventListener('securitypolicyviolation', (event) => add(`CSP refused ${event.violatedDirective}${event.blockedURI === '' ? '' : ` ${event.blockedURI}`}`));
  const original = view.console.error.bind(view.console);
  view.console.error = (...args: unknown[]) => {
    add(args.map(String).join(' '));
    original(...args);
  };
}

Object.assign(window, { __gallery: { receive: (iframe: HTMLIFrameElement, message: never) => mounted.get(iframe)?.host.receive(message), attach } });

function unmountAll(): void {
  for (const iframe of mounted.keys()) iframe.remove();
  mounted.clear();
}

/** Tells every frame the look, the tokens among it, as the extension does when a setting changes. */
function restyleAll(): void {
  for (const m of mounted.values()) void m.host.post({ type: 'look', look: lookFor(m.fixture) });
  if (designFrame !== undefined) void deliver(designFrame, { type: 'look', look: lookFor(undefined) });
  setTimeout(() => {
    for (const m of mounted.values()) void check(m);
    tokenPanel.refresh();
  }, 50);
}

const app = h('div', { class: 'app' });
const sidebar = h('nav', { class: 'sidebar', 'aria-label': 'States' });
const toolbar = h('header', { class: 'toolbar' });
const stage = h('main', { class: 'stage' });
const drawer = h('aside', { class: 'drawer', 'aria-label': 'Theme tokens' });
const banner = h('div', { class: 'banner', hidden: true, role: 'alert' });
app.append(sidebar, h('div', { class: 'center' }, toolbar, banner, stage), drawer);
document.body.append(app);

let designFrame: HTMLIFrameElement | undefined;

// A panel that focuses or reveals one of its elements scrolls the gallery too; only the user's own scroll moves it.
let userAt = 0;
let kept = 0;
for (const type of ['wheel', 'pointerdown', 'keydown', 'touchmove']) stage.addEventListener(type, () => void (userAt = Date.now()), { passive: true });
window.addEventListener('keydown', () => void (userAt = Date.now()));
stage.addEventListener('scroll', () => {
  if (Date.now() - userAt < 1000) kept = stage.scrollTop;
  else if (stage.scrollTop !== kept) stage.scrollTop = kept;
});

function set(change: Partial<Controls>, { remount = true } = {}): void {
  controls = { ...controls, ...change };
  save();
  renderSidebar();
  renderToolbar();
  if (remount) renderStage();
  drawer.hidden = !controls.tokensOpen;
  tokenPanel.refresh();
}

function select<T extends string>(label: string, values: readonly T[], current: T, names: (value: T) => string, onchange: (value: T) => void): HTMLElement {
  const element = h('select', { 'aria-label': label, onchange: (event: Event) => onchange((event.target as HTMLSelectElement).value as T) }, ...values.map((value) => h('option', { value, selected: value === current }, names(value))));
  return h('label', { class: 'control' }, h('span', {}, label), element);
}

function renderToolbar(): void {
  const segment = <T extends string>(label: string, values: readonly (readonly [T, string])[], current: T, pick: (value: T) => void) =>
    h('div', { class: 'segment', role: 'group', 'aria-label': label }, ...values.map(([value, text]) => h('button', { type: 'button', 'aria-pressed': String(value === current), onclick: () => pick(value) }, text)));
  const custom = h('input', { type: 'number', min: '240', max: '1200', step: '10', value: String(controls.width), 'aria-label': 'Custom panel width', onchange: (event: Event) => setWidth(Number((event.target as HTMLInputElement).value)) });
  toolbar.replaceChildren(
    segment<View>('View', [['states', 'States'], ['design', 'Design system']], controls.view, (view) => set({ view })),
    ...(controls.view === 'states' ? [segment<Mode>('Layout', [['grid', 'Grid'], ['single', 'Single']], controls.mode, (mode) => set({ mode }))] : []),
    select('Theme', THEME_SLUGS, controls.theme, (slug) => THEME_NAMES[slug], (theme) => set({ theme })),
    select('Style', UI_STYLES, controls.style, (s) => (s === 'glass' ? 'Glass' : 'Plain'), (style) => (set({ style }, { remount: false }), restyleAll())),
    select('Detail', CHAT_DETAILS, controls.detail, (d) => (d === 'full' ? 'Full' : 'Compact'), (detail) => (set({ detail }, { remount: false }), restyleAll())),
    select('Review', REVIEW_MODES, controls.review, (r) => (r === 'review' ? 'Keep or Undo' : 'Auto'), (review) => (set({ review }, { remount: false }), restyleAll())),
    h('div', { class: 'control' }, h('span', {}, 'Width'), segment('Width', WIDTHS.map((w) => [String(w), `${w}`] as const), String(controls.width), (w) => setWidth(Number(w))), custom),
    h('label', { class: 'control check' }, h('input', { type: 'checkbox', checked: controls.reduced, onchange: (event: Event) => set({ reduced: (event.target as HTMLInputElement).checked }) }), h('span', {}, 'Reduced motion')),
    h('button', { type: 'button', class: 'tokens-toggle', 'aria-pressed': String(controls.tokensOpen), onclick: () => set({ tokensOpen: !controls.tokensOpen }, { remount: false }) }, 'Tokens'),
  );
}

function setWidth(width: number): void {
  if (!Number.isFinite(width) || width < 240) return;
  set({ width }, { remount: false });
  for (const iframe of mounted.keys()) iframe.style.width = `${width}px`;
  if (designFrame !== undefined) designFrame.style.width = `${Math.max(width, 600)}px`;
}

function renderSidebar(): void {
  const query = controls.query.toLowerCase();
  const search = h('input', { type: 'search', placeholder: 'Find a state', value: controls.query, 'aria-label': 'Find a state', oninput: (event: Event) => set({ query: (event.target as HTMLInputElement).value }, { remount: false }) });
  const groups = GROUPS.map((group) => {
    const states = FIXTURES.filter((f) => f.group === group && (query === '' || `${f.title} ${f.id}`.toLowerCase().includes(query)));
    if (states.length === 0) return undefined;
    return h(
      'section',
      { class: 'group' },
      h('button', { type: 'button', class: 'group-name', 'aria-current': String(controls.view === 'states' && controls.mode === 'grid' && controls.group === group), onclick: () => set({ view: 'states', mode: 'grid', group }) }, group, h('span', { class: 'count' }, String(states.length))),
      h('ul', {}, ...states.map((f) => h('li', {}, h('button', { type: 'button', 'aria-current': String(controls.view === 'states' && controls.mode === 'single' && controls.selected === f.id), onclick: () => set({ view: 'states', mode: 'single', selected: f.id }) }, f.title)))),
    );
  });
  sidebar.replaceChildren(
    h('div', { class: 'brand' }, h('strong', {}, 'Geno'), ' UI gallery'),
    search,
    h('button', { type: 'button', class: 'group-name all', 'aria-current': String(controls.view === 'states' && controls.mode === 'grid' && controls.group === undefined), onclick: () => set({ view: 'states', mode: 'grid', group: undefined }) }, 'Every state', h('span', { class: 'count' }, String(FIXTURES.length))),
    ...groups.filter((g) => g !== undefined),
  );
  // Keeping the field's focus across a rerender lets the search filter as the user types.
  if (document.activeElement === document.body && controls.query !== '') search.focus();
}

let lazy: IntersectionObserver | undefined;

function renderStage(): void {
  unmountAll();
  kept = 0;
  stage.scrollTop = 0;
  lazy?.disconnect();
  designFrame = undefined;
  stage.style.setProperty('--backdrop', backdropOf(controls.theme));
  if (controls.view === 'design') {
    const look = lookFor(undefined);
    designFrame = h('iframe', { class: 'design-frame', title: 'Design system', src: `/design.html?${frameQuery(look)}` });
    designFrame.style.width = `${Math.max(controls.width, 600)}px`;
    designFrame.addEventListener('load', () => {
      void deliver(designFrame!, { type: 'look', look });
      tokenPanel.refresh();
    });
    stage.replaceChildren(designFrame);
    return;
  }
  if (controls.mode === 'single') {
    const fixture = FIXTURES.find((f) => f.id === controls.selected) ?? FIXTURES[0]!;
    const { iframe, badge } = mount(fixture, Math.max(480, window.innerHeight - 140));
    stage.replaceChildren(h('div', { class: 'single' }, h('div', { class: 'card-head' }, h('span', { class: 'card-title' }, fixture.title), h('code', {}, fixture.id), badge), iframe));
    return;
  }
  const shown = FIXTURES.filter((f) => controls.group === undefined || f.group === controls.group);
  lazy = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        lazy!.unobserve(entry.target);
        const slot = entry.target as HTMLElement;
        const fixture = FIXTURES.find((f) => f.id === slot.dataset['fixture'])!;
        const { iframe, badge } = mount(fixture, 520);
        slot.querySelector('.card-head')!.append(badge);
        slot.append(iframe);
      }
    },
    { rootMargin: '400px' },
  );
  const cards = shown.map((fixture) => {
    const card = h(
      'article',
      { class: 'card', 'data-fixture': fixture.id },
      h('div', { class: 'card-head' }, h('button', { type: 'button', class: 'card-title', title: 'Open alone', onclick: () => set({ mode: 'single', selected: fixture.id }) }, fixture.title), h('code', {}, fixture.id)),
    );
    card.style.setProperty('--frame-width', `${controls.width}px`);
    lazy!.observe(card);
    return card;
  });
  stage.replaceChildren(h('div', { class: 'grid' }, ...cards));
}

/** The document whose computed values the token panel shows: the design page, or the first frame that drew. */
const probe = (): Document | undefined => {
  if (designFrame?.contentDocument?.body != null) return designFrame.contentDocument;
  for (const iframe of mounted.keys()) if (iframe.contentDocument?.body != null && iframe.contentDocument.readyState === 'complete') return iframe.contentDocument;
  return undefined;
};

const canvas = document.createElement('canvas').getContext('2d')!;
/** `value` as the canvas reads a color: `#rrggbb`, or `rgba(…)` with its alpha, or undefined when it is no color. */
function colorOf(value: string): string | undefined {
  if (value === '' || !CSS.supports('color', value) || /var\(/.test(value)) return undefined;
  canvas.fillStyle = '#010203';
  canvas.fillStyle = value;
  const first = canvas.fillStyle;
  canvas.fillStyle = '#030201';
  canvas.fillStyle = value;
  return first === canvas.fillStyle ? first : undefined;
}
const hexOf = (color: string): string => {
  if (color.startsWith('#')) return color;
  const [r, g, b] = (color.match(/[\d.]+/g) ?? []).map(Number);
  return `#${[r, g, b].map((n) => Math.round(n ?? 0).toString(16).padStart(2, '0')).join('')}`;
};
const withAlphaOf = (hex: string, previous: string): string => {
  const alpha = previous.startsWith('rgba') ? (previous.match(/[\d.]+/g) ?? []).map(Number)[3] : undefined;
  if (alpha === undefined) return hex;
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `rgb(${n(1)} ${n(3)} ${n(5)} / ${Math.round(alpha * 1000) / 10}%)`;
};

/** The token panel: every Geno token by prefix, its value under the current theme, and the user's own value for this kind. */
const tokenPanel = (() => {
  let filter = '';
  let problems: readonly string[] = [];
  let pending: number | undefined;
  const groupOf = (name: string) => {
    const prefix = name.slice(2).split('-')[0]!;
    return TOKEN_NAMES.filter((n) => n.slice(2).split('-')[0] === prefix).length > 1 ? prefix : 'base';
  };

  function setToken(name: string, value: string | undefined): void {
    const kind = kindOf(controls.theme);
    const problem = value === undefined || value.trim() === '' ? undefined : tokenValueProblem(value);
    problems = problem === undefined ? [] : [`The value of ${name} ${problem}, so the setting would ignore it.`];
    if (problem !== undefined) return render();
    const current = { ...controls.tokens[kind] };
    if (value === undefined || value.trim() === '') delete current[name];
    else current[name] = value.trim();
    const tokens = { ...controls.tokens, [kind]: current };
    if (Object.keys(current).length === 0) delete (tokens as Record<string, unknown>)[kind];
    set({ tokens }, { remount: false });
    restyleAll();
  }

  function exportTokens(): void {
    const blob = new Blob([`${JSON.stringify(controls.tokens, null, 2)}\n`], { type: 'application/json' });
    const link = h('a', { href: URL.createObjectURL(blob), download: 'geno-theme.json' });
    link.click();
    URL.revokeObjectURL(link.href);
  }

  async function importTokens(file: File): Promise<void> {
    try {
      const parsed = themeTokensOf(JSON.parse(await file.text()), KNOWN);
      problems = parsed.problems;
      set({ tokens: parsed.tokens }, { remount: false });
      restyleAll();
    } catch (error) {
      problems = [`${file.name} is not JSON: ${String(error)}`];
      render();
    }
  }

  function row(name: string, doc: Document | undefined): HTMLElement {
    const kind = kindOf(controls.theme);
    const own = controls.tokens[kind]?.[name];
    const computed = doc === undefined ? '' : doc.defaultView!.getComputedStyle(doc.body).getPropertyValue(name).trim();
    const color = colorOf(own ?? computed);
    const text = h('input', {
      type: 'text',
      value: own ?? '',
      placeholder: 'Theme value',
      'aria-label': `Value of ${name}`,
      spellcheck: 'false',
      onchange: (event: Event) => setToken(name, (event.target as HTMLInputElement).value),
    });
    const picker =
      color !== undefined &&
      h('input', { type: 'color', value: hexOf(color), 'aria-label': `Pick a color for ${name}`, oninput: (event: Event) => setToken(name, withAlphaOf((event.target as HTMLInputElement).value, color)) });
    return h(
      'li',
      { class: `token${own === undefined ? '' : ' changed'}`, 'data-token': name },
      h('div', { class: 'token-name' }, h('code', {}, name), color !== undefined && h('span', { class: 'chip', style: `background: ${own ?? computed}` })),
      h('div', { class: 'token-edit' }, text, picker, own !== undefined && h('button', { type: 'button', class: 'link', title: 'Back to the theme value', onclick: () => setToken(name, undefined) }, 'Reset')),
      h('div', { class: 'token-computed', title: 'As the panel computes it in this theme' }, computed === '' ? 'set per component' : computed),
    );
  }

  function render(): void {
    if (!controls.tokensOpen) return;
    const kind = kindOf(controls.theme);
    const doc = probe();
    const shown = TOKEN_NAMES.filter((n) => filter === '' || n.includes(filter));
    const groups = [...new Set(shown.map(groupOf))].sort((a, b) => (a === 'base' ? -1 : b === 'base' ? 1 : a.localeCompare(b)));
    const input = h('input', { type: 'file', accept: 'application/json,.json', hidden: true, onchange: (event: Event) => void importTokens((event.target as HTMLInputElement).files![0]!) });
    const changed = Object.values(controls.tokens).reduce((n, values) => n + Object.keys(values ?? {}).length, 0);
    drawer.replaceChildren(
      h('div', { class: 'drawer-head' }, h('h2', {}, 'Theme tokens'), h('p', { class: 'hint' }, `Edits apply to ${KIND_NAMES[kind]} themes${kind.startsWith('highContrast') ? ', which take tokens only when the theme names them' : ''}. ${changed} set across kinds.`)),
      h(
        'div',
        { class: 'drawer-actions' },
        h('button', { type: 'button', onclick: exportTokens }, 'Export'),
        h('button', { type: 'button', onclick: () => input.click() }, 'Import'),
        h('button', { type: 'button', disabled: controls.tokens[kind] === undefined, onclick: () => (set({ tokens: Object.fromEntries(Object.entries(controls.tokens).filter(([k]) => k !== kind)) }, { remount: false }), restyleAll()) }, `Reset ${KIND_NAMES[kind]}`),
        input,
      ),
      ...(problems.length > 0 ? [h('ul', { class: 'problems', role: 'alert' }, ...problems.map((p) => h('li', {}, p)))] : []),
      h('input', { type: 'search', class: 'token-filter', placeholder: `Filter ${TOKEN_NAMES.length} tokens`, value: filter, 'aria-label': 'Filter tokens', oninput: (event: Event) => ((filter = (event.target as HTMLInputElement).value), render()) }),
      ...(controls.tokens[kind] === undefined ? [] : [h('section', { class: 'token-group' }, h('h3', {}, 'Changed'), h('ul', {}, ...shown.filter((n) => controls.tokens[kind]![n] !== undefined).map((n) => row(n, doc))))]),
      ...groups.map((group) => h('section', { class: 'token-group' }, h('h3', {}, group), h('ul', {}, ...shown.filter((n) => groupOf(n) === group).map((n) => row(n, doc))))),
    );
    const field = drawer.querySelector<HTMLInputElement>('.token-filter');
    if (filter !== '') field?.focus();
  }

  return {
    refresh: () => {
      if (pending !== undefined) clearTimeout(pending);
      pending = window.setTimeout(render, 30);
    },
  };
})();

/** Rebuilds come from the server's watch; a new version reloads every frame, the controls kept. */
let version: number | undefined;
setInterval(() => {
  void fetch('/version')
    .then((r) => r.json() as Promise<{ version: number; failure: string | undefined }>)
    .then((next) => {
      banner.hidden = next.failure === undefined;
      banner.textContent = next.failure === undefined ? '' : `The build failed:\n${next.failure}`;
      if (version !== undefined && next.version !== version && next.failure === undefined) location.reload();
      version = next.version;
    })
    .catch(() => undefined);
}, 1000);

set({});
