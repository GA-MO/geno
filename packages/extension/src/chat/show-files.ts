/// <reference lib="dom" />
import { formatBytes } from '@g-code/core/attachments';
import type { RefusedFile, ShownFile, ShownFiles } from '@g-code/core/show-files';
import type { OpenTarget } from './attachment-model.js';
import { h, icon } from './dom.js';
import { srcOf } from './images.js';
import type { ToolBlock } from './messages.js';

type Open = (target: OpenTarget) => void;

const FILE_ICONS: Readonly<Record<string, string>> = { pdf: 'file-pdf', md: 'markdown', markdown: 'markdown', html: 'file-code', htm: 'file-code', svg: 'file-code', csv: 'table', tsv: 'table', json: 'json' };

const iconOf = (name: string): string => FILE_ICONS[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? 'file';

const openOf = (file: ShownFile, open: Open) => () => open({ kind: 'path', path: file.path });

/** A file the panel does not draw, or an image it cannot load from here: its name and size, and Open. */
function fileRow(file: ShownFile, open: Open): HTMLElement {
  return h(
    'li',
    { class: 'shown-file' },
    icon(file.show === 'image' ? 'file-media' : iconOf(file.name), 'shown-file-icon'),
    h('span', { class: 'shown-file-name', title: file.path }, file.name),
    h('span', { class: 'shown-file-size' }, formatBytes(file.bytes)),
    h('button', { type: 'button', class: 'button small secondary', 'data-focus': `show-open:${file.path}`, title: `Open ${file.name} in the editor`, onclick: openOf(file, open) }, 'Open'),
  );
}

/** An image the panel loads from the workspace or the session's own folders; one that fails to load becomes its file row. */
function imageTile(file: ShownFile, src: string, open: Open): HTMLElement {
  const img = h('img', { src, alt: file.name, draggable: 'false', loading: 'lazy' });
  const tile = h(
    'figure',
    { class: 'shown-image' },
    h('button', { type: 'button', class: 'shown-frame', 'data-focus': `show-open:${file.path}`, title: `Open ${file.name} full size`, 'aria-label': `Open ${file.name} full size`, onclick: openOf(file, open) }, img),
    h('figcaption', { class: 'shown-image-name', title: file.path }, file.name),
  );
  img.addEventListener('error', () => tile.replaceWith(h('ul', { class: 'shown-files' }, fileRow(file, open))), { once: true });
  return tile;
}

function refusedRow(file: RefusedFile): HTMLElement {
  return h(
    'li',
    { class: 'shown-refused' },
    icon('circle-slash', 'shown-file-icon'),
    h('span', { class: 'shown-refused-text', title: file.reason }, h('span', { class: 'shown-refused-name' }, file.given), h('span', { class: 'shown-refused-reason' }, file.reason)),
  );
}

/**
 * A show_files call's card: the caption, the images in a grid or one large each, then the other files as rows with
 * Open, then what was refused and why. HTML and SVG never render here; they open in the editor.
 */
export function showFilesStep(tool: ToolBlock & { readonly shown: ShownFiles }, open: Open): HTMLElement {
  const { shown } = tool;
  const files = shown.files.filter((entry): entry is ShownFile => entry.kind === 'shown');
  const images = files.flatMap((file) => {
    const src = file.show === 'image' ? srcOf(file.path) : undefined;
    return src === undefined ? [] : [{ file, src }];
  });
  const drawn = new Set(images.map(({ file }) => file));
  const rows = files.filter((file) => !drawn.has(file));
  const refused = shown.files.filter((entry): entry is RefusedFile => entry.kind === 'refused');
  return h(
    'section',
    { class: 'show-files', 'data-layout': shown.layout, 'data-tool': tool.id, 'aria-label': shown.caption ?? 'Files shown' },
    shown.caption !== undefined && h('p', { class: 'show-files-caption' }, shown.caption),
    images.length > 0 && h('div', { class: 'shown-images' }, ...images.map(({ file, src }) => imageTile(file, src, open))),
    rows.length > 0 && h('ul', { class: 'shown-files' }, ...rows.map((file) => fileRow(file, open))),
    refused.length > 0 && h('ul', { class: 'shown-files shown-refusals', 'aria-label': 'Not shown' }, ...refused.map(refusedRow)),
  );
}
