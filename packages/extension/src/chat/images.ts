/// <reference lib="dom" />
import { formatBytes } from '@g-code/core/attachments';
import type { AttachmentView, OpenTarget } from './attachment-model.js';
import { h, icon } from './dom.js';
import type { ToolBlock, WebviewRoot } from './messages.js';

/**
 * Images in the transcript. Only files inside a workspace folder load, through the webview's own address for that
 * folder; the page's CSP refuses every other source, and the markdown renderer never asks for one.
 */

let roots: readonly WebviewRoot[] = [];

export const setRoots = (next: readonly WebviewRoot[]): void => {
  roots = next;
};

/** `file` with `.` and `..` resolved, or undefined when it climbs above the filesystem root. */
function normalized(file: string): string | undefined {
  const parts: string[] = [];
  for (const part of file.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.pop() === undefined) return undefined;
    } else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/** The webview address of an absolute path inside a workspace folder, or undefined for any other path. */
export function srcOf(file: string): string | undefined {
  const target = normalized(file);
  if (target === undefined) return undefined;
  for (const root of roots) {
    const base = root.path.endsWith('/') ? root.path.slice(0, -1) : root.path;
    if (!target.startsWith(`${base}/`)) continue;
    return `${root.uri.replace(/\/$/, '')}/${target.slice(base.length + 1).split('/').map(encodeURIComponent).join('/')}`;
  }
  return undefined;
}

/** Where a markdown image points: a workspace file the panel shows, or something it will not load, and why. */
export type ImageTarget =
  | { readonly kind: 'local'; readonly path: string; readonly src: string }
  | { readonly kind: 'remote'; readonly href: string }
  | { readonly kind: 'outside'; readonly href: string };

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Resolves a markdown image's address against the first workspace folder, as the model writes paths. */
export function imageTarget(href: string): ImageTarget {
  let file: string;
  if (/^file:\/\//i.test(href)) {
    try {
      file = decodeURIComponent(new URL(href).pathname);
    } catch {
      return { kind: 'outside', href };
    }
  } else if (SCHEME.test(href) || href.startsWith('//')) {
    return { kind: 'remote', href };
  } else {
    const relative = decodeURIComponent(href.split(/[?#]/)[0]!);
    file = relative.startsWith('/') ? relative : `${roots[0]?.path ?? ''}/${relative}`;
  }
  const path = normalized(file);
  const src = path === undefined ? undefined : srcOf(path);
  return path === undefined || src === undefined ? { kind: 'outside', href } : { kind: 'local', path, src };
}

/** A thumbnail in a rounded glass frame that opens its file when clicked. */
export function thumbnail(src: string, name: string, open: () => void, className = 'thumb'): HTMLElement {
  const frame = h('button', { type: 'button', class: className, title: `Open ${name}`, 'aria-label': `Open ${name}`, onclick: open });
  const img = h('img', { src, alt: name, draggable: 'false' });
  img.addEventListener('error', () => frame.replaceChildren(icon('file-media')), { once: true });
  frame.append(img);
  return frame;
}

type Open = (target: OpenTarget) => void;

/** The images and files the user sent, above the prompt's bubble. */
export function sentAttachments(views: readonly AttachmentView[], open: Open): HTMLElement | undefined {
  if (views.length === 0) return undefined;
  return h(
    'div',
    { class: 'sent-attachments', role: 'list', 'aria-label': 'Attached' },
    ...views.map((view) =>
      view.kind === 'image' && view.thumb !== undefined
        ? h('div', { role: 'listitem' }, thumbnail(view.thumb, view.name, () => open(view.open)))
        : h(
            'button',
            { type: 'button', role: 'listitem', class: 'sent-file', title: `Open ${view.name}`, onclick: () => open(view.open) },
            icon('file'),
            h('span', { class: 'attachment-name' }, view.name),
            h('span', { class: 'attachment-detail' }, formatBytes(view.bytes)),
          ),
    ),
  );
}

/** Thumbnails of the images a step's tools returned, such as a read of a PNG. */
export function toolImages(tools: readonly ToolBlock[], open: Open): HTMLElement | undefined {
  const shown = tools
    .flatMap((tool) => tool.images ?? [])
    .flatMap((image) => {
      const src = srcOf(image.path);
      return src === undefined ? [] : [thumbnail(src, image.name, () => open({ kind: 'path', path: image.path }))];
    });
  return shown.length === 0 ? undefined : h('div', { class: 'step-images' }, ...shown);
}

/** An image in the answer: a workspace file inline, anything else a note that it was not loaded. */
export function markdownImage(href: string, alt: string, open: Open): HTMLElement {
  const target = imageTarget(href);
  if (target.kind === 'local') {
    const name = alt || target.path.slice(target.path.lastIndexOf('/') + 1);
    return h('span', { class: 'inline-image' }, thumbnail(target.src, name, () => open({ kind: 'path', path: target.path }), 'thumb thumb-inline'));
  }
  const label = alt || href;
  return h(
    'span',
    { class: 'blocked-image', title: href },
    icon('file-media'),
    /^https?:/i.test(href) ? h('a', { href }, label) : h('span', {}, label),
    h('span', { class: 'blocked-note' }, target.kind === 'remote' ? ' (remote image, not loaded)' : ' (outside the workspace, not shown)'),
  );
}
