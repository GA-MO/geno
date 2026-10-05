/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import type { FromDiagramTab, ToDiagramTab } from './diagram-tab.js';
import { diagramBlock } from './diagram-view.js';
import { h, icon } from './dom.js';

/** The diagram tab's page: one diagram, fitted to the tab or at a chosen zoom. */

declare function acquireVsCodeApi(): { postMessage(message: FromDiagramTab): void };

const host = acquireVsCodeApi();

const ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4] as const;
type Zoom = 'fit' | (typeof ZOOMS)[number];
let zoom: Zoom = 'fit';

const stage = h('main', { class: 'diagram-stage', 'aria-label': 'Diagram' });
const level = h('button', { class: 'link-button zoom-level', title: 'Switch between fitting the tab and actual size', onclick: () => setZoom(zoom === 'fit' ? 1 : 'fit') });

/** The next zoom step from the current one; from fit, the step nearest the scale the fit shows. */
function step(by: 1 | -1): Zoom {
  const current = zoom === 'fit' ? fittedScale() : zoom;
  const next = by === 1 ? ZOOMS.find((z) => z > current + 0.01) : ZOOMS.findLast((z) => z < current - 0.01);
  return next ?? (by === 1 ? ZOOMS.at(-1)! : ZOOMS[0]);
}

function naturalWidth(svg: SVGSVGElement): number {
  return svg.viewBox.baseVal?.width || svg.getBoundingClientRect().width || 1;
}

function fittedScale(): number {
  const svg = stage.querySelector('svg');
  return svg === null ? 1 : svg.getBoundingClientRect().width / naturalWidth(svg);
}

/** Sizes the drawing for the zoom; a redrawn diagram, after a theme change, gets the same size. */
function applyZoom(): void {
  const svg = stage.querySelector<SVGSVGElement>('.diagram-canvas svg');
  stage.dataset['zoom'] = String(zoom);
  if (svg !== null) {
    svg.style.width = zoom === 'fit' ? '' : `${naturalWidth(svg) * zoom}px`;
    svg.style.height = zoom === 'fit' ? '' : 'auto';
  }
  level.textContent = zoom === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`;
}

function setZoom(next: Zoom): void {
  zoom = next;
  applyZoom();
}

const toolbar = h(
  'div',
  { class: 'diagram-tab-toolbar', role: 'toolbar', 'aria-label': 'Zoom' },
  h('button', { class: 'icon-button', title: 'Zoom Out', 'aria-label': 'Zoom out', onclick: () => setZoom(step(-1)) }, icon('zoom-out')),
  level,
  h('button', { class: 'icon-button', title: 'Zoom In', 'aria-label': 'Zoom in', onclick: () => setZoom(step(1)) }, icon('zoom-in')),
);
document.body.classList.add('diagram-tab');
document.body.append(toolbar, stage);
new MutationObserver(applyZoom).observe(stage, { childList: true, subtree: true });

window.addEventListener('message', (event: MessageEvent<ToDiagramTab>) => {
  const { source } = event.data;
  stage.replaceChildren(diagramBlock({ source, closed: true }, { copy: (text) => host.postMessage({ type: 'copy', text }) }));
  applyZoom();
});

host.postMessage({ type: 'ready' });
