/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { h, icon } from './dom.js';
import type { WidgetFromView } from './messages.js';
import type { WidgetTool } from './rail.js';
import { FRAME_HEIGHT, frameDocument, fromWidget, themeCss, TO_FRAME, WIDGET_SANDBOX, widgetTheme, type FromWidget, type WidgetTheme } from '@g-code/core/widget-frame';

/**
 * Widgets as a page shows them: the loading card while the model writes one, then its sandboxed frame. A frame says
 * only what `fromWidget` accepts, and only from its own window: a height, a link the user must approve, and a
 * snapshot of its markup that the page draws as an image.
 */

// The page's script carries the nonce the frames inherit their policy from.
const nonce = (document.currentScript as HTMLScriptElement | null)?.nonce ?? '';

type Snapshot = Extract<FromWidget, { kind: 'snapshot' }>;
type Mounted = { readonly frame: HTMLIFrameElement; readonly onLink: (href: string) => void; waiting?: ((snapshot: Snapshot) => void) | undefined };

const mounted = new Set<Mounted>();

let probe: HTMLElement | undefined;

/** A panel variable as the value a frame can use: a color resolved to rgb(), anything else as written. */
function resolved(name: string): string | undefined {
  const raw = getComputedStyle(document.body).getPropertyValue(name).trim();
  if (raw === '' || name.endsWith('font') || name.endsWith('mono')) return raw || undefined;
  probe ??= document.body.appendChild(h('span', { class: 'diagram-probe', 'aria-hidden': 'true' }));
  probe.style.color = '';
  probe.style.color = raw;
  return probe.style.color === '' ? undefined : getComputedStyle(probe).color;
}

const isLight = (): boolean => document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light');

let theme: WidgetTheme | undefined;
/** The widget theme of the page as it is now: the panel's `--widget-*` variables. */
export const currentTheme = (): WidgetTheme => (theme ??= widgetTheme(resolved, isLight() ? 'light' : 'dark'));

let watching = false;
function watch(): void {
  if (watching) return;
  watching = true;
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const entry = [...mounted].find((m) => m.frame.contentWindow !== null && m.frame.contentWindow === event.source);
    if (entry === undefined) return;
    const message = fromWidget(event.data);
    if (message?.kind === 'height') entry.frame.style.height = `${message.height}px`;
    // A link counts only right after the user clicked inside this widget, which gives its frame the focus: a widget
    // cannot raise the question on its own.
    if (message?.kind === 'link' && document.activeElement === entry.frame && navigator.userActivation?.isActive !== false) entry.onLink(message.href);
    if (message?.kind === 'snapshot') entry.waiting?.(message);
  });
  // VS Code swaps the theme by changing the body's classes and the root's color variables.
  const changed = new MutationObserver(() => {
    theme = undefined;
    const css = themeCss(currentTheme());
    for (const entry of mounted) {
      if (!entry.frame.isConnected) mounted.delete(entry);
      else entry.frame.contentWindow?.postMessage({ type: TO_FRAME.theme, css }, '*');
    }
  });
  changed.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-vscode-theme-id', 'data-style'] });
  changed.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
}

/** A widget's sandboxed frame, sized by what it reports. `name` lets a test find its frame. */
export function widgetFrame(html: string, title: string, name: string, onLink: (href: string) => void, frameTheme: WidgetTheme = currentTheme()): HTMLIFrameElement {
  watch();
  const frame = h('iframe', {
    class: 'widget-frame',
    name,
    title,
    sandbox: WIDGET_SANDBOX,
    referrerpolicy: 'no-referrer',
    style: `height:${FRAME_HEIGHT.min * 5}px`,
  });
  frame.srcdoc = frameDocument({ html, nonce, theme: frameTheme });
  mounted.add({ frame, onLink });
  return frame;
}

const SNAPSHOT_WAIT_MS = 5000;

/** The frame's markup as it is now, which its bootstrap sends when asked. */
function snapshotOf(frame: HTMLIFrameElement): Promise<Snapshot> {
  const entry = [...mounted].find((m) => m.frame === frame);
  if (entry === undefined || frame.contentWindow === null) return Promise.reject(new Error('the widget is not drawn'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the widget did not answer')), SNAPSHOT_WAIT_MS);
    entry.waiting = (snapshot) => {
      if (snapshot.id !== id) return;
      clearTimeout(timer);
      entry.waiting = undefined;
      resolve(snapshot);
    };
    frame.contentWindow!.postMessage({ type: TO_FRAME.snapshot, id }, '*');
  });
}

/**
 * Draws a snapshot to PNG. The markup only ever goes in as an SVG image, where no script runs and nothing loads, onto
 * the theme's background, at the screen's pixel density.
 */
async function rasterize({ markup, width, height }: Snapshot, background: string): Promise<Blob> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${markup}</foreignObject></svg>`;
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const scale = Math.max(1, window.devicePixelRatio || 1);
  const canvas = h('canvas', { width: Math.round(width * scale), height: Math.round(height * scale) });
  const context = canvas.getContext('2d')!;
  context.scale(scale, scale);
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob === null ? reject(new Error('the image is empty')) : resolve(blob)), 'image/png'));
}

const base64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};

/** Puts the widget on the clipboard as a PNG; when the clipboard refuses, the extension offers to save it. */
async function copyImage(frame: HTMLIFrameElement, title: string, post: (message: WidgetFromView) => void): Promise<'copied' | 'saved'> {
  const png = await rasterize(await snapshotOf(frame), currentTheme().vars['--bg'] ?? 'transparent');
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    return 'copied';
  } catch {
    post({ type: 'widget-image', title, png: await base64(png) });
    return 'saved';
  }
}

type Action = { readonly id: string; readonly label: string; readonly icon: string };
const ACTIONS: readonly Action[] = [
  { id: 'copy-image', label: 'Copy as Image', icon: 'device-camera' },
  { id: 'download', label: 'Download as HTML', icon: 'cloud-download' },
  { id: 'open', label: 'Open in Editor', icon: 'link-external' },
];

/** The ⋯ button and its menu of actions, which closes on Escape, Tab or a click elsewhere. */
function actionsMenu(toolId: string, run: (action: string) => void): HTMLElement {
  const menu = h('ul', { class: 'widget-menu', role: 'menu', 'aria-label': 'Widget actions', hidden: true });
  const button = h(
    'button',
    { type: 'button', class: 'icon-button widget-more', title: 'More Actions', 'aria-label': 'Widget actions', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-focus': `widget-more:${toolId}` },
    icon('ellipsis'),
  );
  const items = () => [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const close = (refocus: boolean) => {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (refocus) button.focus();
  };
  const open = () => {
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    items()[0]?.focus();
  };
  menu.append(
    ...ACTIONS.map((action) =>
      h(
        'li',
        {
          class: 'widget-menu-item',
          role: 'menuitem',
          tabindex: '-1',
          'data-action': action.id,
          onclick: () => {
            close(true);
            run(action.id);
          },
        },
        icon(action.icon),
        h('span', {}, action.label),
      ),
    ),
  );
  button.addEventListener('click', () => (menu.hidden ? open() : close(false)));
  menu.addEventListener('keydown', (event) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const moves: Readonly<Record<string, () => void>> = {
      ArrowDown: () => all[(at + 1) % all.length]?.focus(),
      ArrowUp: () => all[(at - 1 + all.length) % all.length]?.focus(),
      Enter: () => all[at]?.click(),
      ' ': () => all[at]?.click(),
      Escape: () => close(true),
      Tab: () => close(false),
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    move();
  });
  document.addEventListener('mousedown', (event) => {
    if (!menu.contains(event.target as Node) && !button.contains(event.target as Node)) close(false);
  });
  return h('div', { class: 'widget-actions' }, button, menu);
}

const LOADING_EVERY_MS = 2400;

/** The card while the model writes the widget: its title once known, and its loading lines in turn. */
function loadingCard(tool: WidgetTool & { readonly widget: { readonly state: 'drafting' } }): HTMLElement {
  const lines = tool.widget.loading.length === 0 ? ['Drawing the widget'] : tool.widget.loading;
  const line = h('span', { class: 'widget-loading-line shimmer' }, `${lines[0]}…`);
  if (lines.length > 1) {
    let i = 0;
    const timer = setInterval(() => {
      if (!line.isConnected) return clearInterval(timer);
      i = (i + 1) % lines.length;
      line.textContent = `${lines[i]}…`;
    }, LOADING_EVERY_MS);
  }
  return h('div', { class: 'widget-loading', role: 'status' }, icon('loading', 'codicon-modifier-spin'), line);
}

/**
 * The question a link raises, under the widget's title: the address in full, Open, and Cancel. Open is the only way a
 * widget's link reaches the extension, which then opens it in the browser.
 */
export function linkQuestion(href: string, open: () => void): HTMLElement {
  const close = () => element.remove();
  const element = h(
    'div',
    { class: 'widget-link-ask', role: 'group', 'aria-label': 'The widget asks to open a link' },
    icon('link-external'),
    h('span', { class: 'widget-link-text' }, 'Open ', h('code', { class: 'widget-link-href' }, href), '?'),
    h('button', { type: 'button', class: 'button ghost small', 'data-link': 'cancel', onclick: close }, 'Cancel'),
    h(
      'button',
      {
        type: 'button',
        class: 'button small',
        'data-link': 'open',
        onclick: () => {
          close();
          open();
        },
      },
      'Open',
    ),
  );
  element.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    close();
  });
  queueMicrotask(() => element.querySelector<HTMLElement>('[data-link="cancel"]')?.focus());
  return element;
}

/** Shows the link question after `anchor`, replacing any the widget raised before. */
export function askAbout(anchor: HTMLElement, href: string, open: () => void): void {
  anchor.parentElement?.querySelector(':scope > .widget-link-ask')?.remove();
  anchor.after(linkQuestion(href, open));
}

export type WidgetUi = { readonly post: (message: WidgetFromView) => void };

/** A show_widget step: the widget with its title and actions, its loading card, or why it is not drawn. */
export function widgetStep(tool: WidgetTool, ui: WidgetUi): HTMLElement {
  const { widget } = tool;
  const title = widget.state === 'drafting' ? (widget.title ?? 'Widget') : widget.title;
  const head = h('div', { class: 'widget-head' }, icon('graph', 'kind'), h('span', { class: 'widget-title' }, title), h('span', { class: 'spacer' }));
  const figure = h('figure', { class: 'widget', 'data-widget': tool.id, 'data-state': widget.state, 'aria-label': title }, head);
  if (widget.state === 'drafting') {
    figure.append(tool.status === 'failed' ? h('div', { class: 'widget-note widget-error' }, icon('error'), `Could not draw this widget: ${tool.output ?? 'the call failed'}`) : loadingCard({ ...tool, widget }));
  } else if (widget.state === 'missing') {
    figure.append(h('div', { class: 'widget-note' }, "This widget is no longer in the session's attachments folder."));
  } else {
    const frame = widgetFrame(widget.html, widget.title, `widget-${tool.id}`, (href) => askAbout(head, href, () => ui.post({ type: 'widget-link', href })));
    const flash = (text: string) => {
      head.dataset['flash'] = text;
      setTimeout(() => delete head.dataset['flash'], 1600);
    };
    const run = (action: string) => {
      if (action === 'copy-image') void copyImage(frame, widget.title, ui.post).then((how) => how === 'copied' && flash('Copied'), () => flash('Could not copy'));
      if (action === 'download') ui.post({ type: 'widget-download', toolId: tool.id, theme: currentTheme() });
      if (action === 'open') ui.post({ type: 'widget-open', toolId: tool.id, theme: currentTheme() });
    };
    head.append(actionsMenu(tool.id, run));
    figure.append(frame);
  }
  return figure;
}
