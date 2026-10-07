/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { DiagramStore, diagramTitle, errorLine, themeOf, type Basis, type Diagram, type DiagramState, type DiagramTheme, type SettledState } from './diagram.js';
import type * as Renderer from './diagram-render.js';
import { h, icon } from './dom.js';
import { codeBlock, copyButton } from './markdown.js';
import type { DrawnDiagram } from './page-model.js';

/**
 * Diagrams as the panel shows them. Each source is drawn once per theme and panel width, and every element that
 * shows it is repainted in place when a drawing settles, so streamed text around a diagram never redraws it.
 */

export type DiagramActions = { readonly copy: (text: string) => void; readonly open?: (source: string) => void };

// The page's script tag names the diagram chunk and carries the nonce its style elements need.
const script = document.currentScript as HTMLScriptElement | null;
const chunk = script?.dataset['diagrams'];
const nonce = script?.nonce ?? '';

let renderer: Promise<typeof Renderer> | undefined;
const load = (): Promise<typeof Renderer> => {
  if (chunk === undefined) return Promise.reject(new Error('the page names no diagram chunk'));
  renderer ??= import(chunk) as Promise<typeof Renderer>;
  // A failed load is tried again next time rather than cached.
  renderer.catch(() => (renderer = undefined));
  return renderer;
};

const store = new DiagramStore();
const sources = new WeakMap<Element, { readonly diagram: Diagram; readonly actions: DiagramActions }>();
const parsed = new WeakMap<DiagramState, SVGSVGElement>();

let probe: HTMLElement | undefined;

/** A color variable as an `rgb()` value mermaid's color math can read, or undefined when the theme lacks it. */
function resolveColor(name: string): string | undefined {
  // Read from the body, where a panel style may set its own colors over the theme's.
  const raw = getComputedStyle(document.body).getPropertyValue(name).trim();
  if (raw === '') return undefined;
  probe ??= document.body.appendChild(h('span', { class: 'diagram-probe', 'aria-hidden': 'true' }));
  probe.style.color = '';
  probe.style.color = raw;
  return probe.style.color === '' ? undefined : getComputedStyle(probe).color;
}

/**
 * The theme diagrams are drawn in. A panel style that paints its own surfaces names them in `--diagram-scheme`,
 * `--diagram-surface` and `--diagram-border`; otherwise the theme's kind, the page's background and the theme's
 * colors decide.
 */
function readTheme(): DiagramTheme {
  const body = getComputedStyle(document.body);
  const scheme = body.getPropertyValue('--diagram-scheme').trim();
  const light = scheme === '' ? document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light') : scheme === 'light';
  const surface = resolveColor('--diagram-surface') ?? (body.backgroundColor === 'rgba(0, 0, 0, 0)' ? undefined : body.backgroundColor);
  return themeOf(resolveColor, { family: body.fontFamily, size: body.fontSize }, !light, surface, resolveColor('--diagram-border'));
}

/** The panel as diagrams are drawn for it, read once and again only after the observers see it change. */
type Panel = { readonly theme: DiagramTheme; readonly basis: Basis };
let panel: Panel | undefined;

function currentPanel(): Panel {
  if (panel === undefined) {
    const theme = readTheme();
    panel = { theme, basis: { theme: JSON.stringify(theme), width: document.body.clientWidth } };
  }
  return panel;
}

/** Draws `source` unless it is drawn or being drawn for the panel as it is now. A hidden panel waits until shown. */
function draw(source: string): void {
  const { theme, basis } = currentPanel();
  if (basis.width === 0 || !store.start(source, basis)) return;
  void load()
    .then(
      (r) => r.renderDiagram(source, theme, nonce),
      (error: unknown) => Promise.reject(new Error(`the diagram library did not load (${error instanceof Error ? error.message : String(error)})`)),
    )
    .then(
      (svg): SettledState => ({ status: 'rendered', svg }),
      (error: unknown): SettledState => ({ status: 'failed', message: errorLine(error instanceof Error ? error.message : String(error)) }),
    )
    .then((state) => {
      if (!store.settle(source, basis, state)) return;
      for (const element of document.querySelectorAll('.diagram')) if (sources.get(element)?.diagram.source === source) paint(element);
    });
}

const SVG_NS = 'http://www.w3.org/2000/svg';
/** A wide diagram shrinks to fit the panel only this far, so its labels stay legible; past it the canvas scrolls. */
const MIN_SCALE = 0.75;
const STYLE = /<style[^>]*>([\s\S]*?)<\/style>/;

/**
 * The SVG as nodes in this document. The style element is lifted out and made again with the nonce; parsed in
 * place it would lack one, and the CSP would refuse it.
 */
function svgOf(state: Extract<DiagramState, { status: 'rendered' }>): SVGSVGElement {
  let svg = parsed.get(state);
  if (svg === undefined) {
    const parsedDoc = new DOMParser().parseFromString(state.svg.replace(STYLE, ''), 'text/html');
    svg = document.importNode(parsedDoc.querySelector('svg')!, true);
    const style = document.createElementNS(SVG_NS, 'style');
    style.textContent = STYLE.exec(state.svg)?.[1] ?? '';
    svg.prepend(style);
    parsed.set(state, svg);
  }
  const copy = svg.cloneNode(true) as SVGSVGElement;
  // A clone does not keep its original's nonce.
  copy.querySelector('style')!.nonce = nonce;
  const width = copy.viewBox.baseVal?.width;
  if (width) copy.style.minWidth = `${Math.round(width * MIN_SCALE)}px`;
  return copy;
}

const muted = (kind: 'pending' | 'error', text: string): HTMLElement => h('div', { class: `diagram-note diagram-${kind}` }, text);

const VIEWS: { readonly [K in DiagramState['status']]: (state: Extract<DiagramState, { status: K }>, diagram: Diagram, actions: DiagramActions) => Node[] } = {
  pending: (_state, { source }, { copy }) => [codeBlock(source, 'mermaid', copy), muted('pending', 'Drawing diagram…')],
  rendered: (state, { source }, { copy, open }) => [
    h(
      'div',
      { class: 'diagram-toolbar' },
      copyButton(source, copy, 'Copy diagram source'),
      open !== undefined &&
        h('button', { class: 'icon-button open', title: 'Open in Editor', 'aria-label': 'Open diagram in an editor tab', onclick: () => open(source) }, icon('link-external')),
    ),
    h('div', { class: 'diagram-canvas' }, svgOf(state)),
  ],
  failed: (state, { source }, { copy }) => [codeBlock(source, 'mermaid', copy), muted('error', `Could not draw this diagram: ${state.message}`)],
};

function paint(element: Element): void {
  const mounted = sources.get(element);
  if (mounted === undefined) return;
  const { diagram, actions } = mounted;
  const state = store.stateOf(diagram);
  element.setAttribute('data-state', state.status);
  element.replaceChildren(...(VIEWS[state.status] as (s: DiagramState, d: Diagram, a: DiagramActions) => Node[])(state, diagram, actions));
}

/** Redraws every diagram on the page that was drawn, for a new theme or width; the old drawing shows meanwhile. */
function redrawShown(): void {
  const shown = new Set<string>();
  for (const element of document.querySelectorAll('.diagram')) {
    const source = sources.get(element)?.diagram.source;
    if (source !== undefined && store.isRendered(source)) shown.add(source);
  }
  for (const source of shown) draw(source);
}

let watching = false;
let resizeTimer: ReturnType<typeof setTimeout> | undefined;

/** VS Code swaps the theme by changing the body's classes and the root element's color variables. */
function watch(): void {
  if (watching) return;
  watching = true;
  const themeChanged = new MutationObserver(() => {
    panel = undefined;
    redrawShown();
  });
  themeChanged.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-id', 'data-style'] });
  themeChanged.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      panel = undefined;
      redrawShown();
      // A diagram that arrived while the panel was hidden is drawn once the panel has a size.
      for (const element of document.querySelectorAll('.diagram[data-state="pending"]')) {
        const diagram = sources.get(element)?.diagram;
        if (diagram?.closed === true) draw(diagram.source);
      }
    }, 200);
  }).observe(document.body);
}

/** The diagrams drawn under `root`, once each, with the scheme they were drawn for: what a saved page shows of them. */
export function drawnDiagrams(root: ParentNode): DrawnDiagram[] {
  const scheme = currentPanel().theme.darkMode ? 'dark' : 'light';
  const drawn = new Map<string, DrawnDiagram>();
  for (const element of root.querySelectorAll('.diagram[data-state="rendered"]')) {
    const diagram = sources.get(element)?.diagram;
    const state = diagram === undefined ? undefined : store.stateOf(diagram);
    if (diagram !== undefined && state?.status === 'rendered') drawn.set(diagram.source, { source: diagram.source, svg: state.svg, scheme });
  }
  return [...drawn.values()];
}

/** A diagram fence as the panel shows it: its source while pending or broken, else the drawing and a toolbar. */
export function diagramBlock(diagram: Diagram, actions: DiagramActions): HTMLElement {
  const element = h('figure', { class: 'diagram', 'aria-label': diagramTitle(diagram.source) });
  sources.set(element, { diagram, actions });
  paint(element);
  if (diagram.closed) {
    watch();
    draw(diagram.source);
  }
  return element;
}
