/// <reference lib="dom" />
import { fitWithin, formatBytes } from '@g-code/core/attachments';
import { admit, chooseEncoding, classify, needsRedraw, THUMB_SIDE, type Draft, type OutgoingAttachment, type PickedFile, type Refused } from './attachment-model.js';
import { h, icon } from './dom.js';
import type { FromView } from './messages.js';

/**
 * The composer's attachments: images and files pasted, dropped, or picked, each a chip that reads, then is ready
 * or refused with its reason. Images are scaled down here, where a canvas is at hand, before anything is sent.
 */

const dataUrlOf = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
    reader.readAsDataURL(blob);
  });

const base64Of = async (blob: Blob): Promise<string> => (await dataUrlOf(blob)).replace(/^data:[^,]*,/, '');

function canvasOf(bitmap: ImageBitmap, size: { readonly width: number; readonly height: number }): HTMLCanvasElement {
  const canvas = h('canvas', { width: size.width, height: size.height });
  const context = canvas.getContext('2d')!;
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  return canvas;
}

const encode = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> =>
  new Promise((resolve, reject) => canvas.toBlob((blob) => (blob === null ? reject(new Error(`could not encode ${type}`)) : resolve(blob)), type, quality));

const JPEG_QUALITY = 0.85;

/** A file as an attachment: text as it is, an image scaled to the size the model reads, anything else refused. */
async function prepare(name: string, blob: Blob, path: string | undefined): Promise<OutgoingAttachment | string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const kind = classify(name, blob.type, bytes);
  if (kind.kind === 'refused') return kind.reason;
  if (kind.kind === 'text') return { kind: 'file', name, path, mediaType: blob.type || 'text/plain', text: kind.text, bytes: bytes.length };
  const { info } = kind;
  const bitmap = await createImageBitmap(blob);
  try {
    const thumb = canvasOf(bitmap, fitWithin(bitmap.width, bitmap.height, THUMB_SIDE)).toDataURL('image/webp', 0.8);
    if (!needsRedraw(info, bytes.length)) {
      return { kind: 'image', name, path, mediaType: info.mediaType, data: await base64Of(blob), bytes: bytes.length, width: info.width, height: info.height, thumb };
    }
    const size = fitWithin(info.width, info.height);
    const canvas = canvasOf(bitmap, size);
    const jpeg = await encode(canvas, 'image/jpeg', JPEG_QUALITY);
    const png = info.mediaType === 'image/jpeg' ? jpeg : await encode(canvas, 'image/png');
    const chosen = chooseEncoding(info.mediaType, png.size, jpeg.size) === 'image/jpeg' ? jpeg : png;
    const mediaType = chosen === jpeg ? 'image/jpeg' : 'image/png';
    // A redrawn image is a new file, so it no longer opens as the one on disk.
    return { kind: 'image', name, path: undefined, mediaType, data: await base64Of(chosen), bytes: chosen.size, ...size, thumb };
  } finally {
    bitmap.close();
  }
}

const blobOfBase64 = (data: string): Blob => new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))]);

/** Paths in a drop's URI list, from the explorer or another editor; comment lines start with `#`. */
const urisOf = (data: DataTransfer): string[] =>
  [data.getData('application/vnd.code.uri-list'), data.getData('text/uri-list')]
    .flatMap((list) => list.split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line, i, all) => line !== '' && !line.startsWith('#') && all.indexOf(line) === i);

export type ComposerAttachments = {
  /** The chip strip, shown above the composer's text while it holds anything. */
  readonly element: HTMLElement;
  /** What the next message sends: the ready attachments. */
  ready(): OutgoingAttachment[];
  /** True while a file is still being read, when sending would leave it behind. */
  busy(): boolean;
  clear(): void;
  /** Files the extension read from the picker or the explorer. */
  picked(files: readonly PickedFile[], refused: readonly Refused[]): void;
};

/** Wires paste and drop on `target` and keeps the drafts. `changed` runs whenever the drafts change. */
export function composerAttachments(target: HTMLElement, post: (message: FromView) => void, changed: () => void): ComposerAttachments {
  let drafts: Draft[] = [];
  let next = 0;
  const element = h('div', { class: 'attachment-chips', role: 'list', 'aria-label': 'Attachments for the next message', hidden: true });

  const set = (updated: Draft[]) => {
    drafts = updated;
    render();
    changed();
  };

  function add(name: string, blob: Blob, path?: string): void {
    const id = `a${next++}`;
    set([...drafts, { id, name, state: 'reading' }]);
    prepare(name, blob, path).then(
      (result) => {
        if (!drafts.some((d) => d.id === id)) return;
        set(typeof result === 'string' ? drafts.map((d) => (d.id === id ? { id, name, state: 'rejected', reason: result } : d)) : admit(drafts, id, result));
      },
      (error: unknown) => set(drafts.map((d) => (d.id === id ? { id, name, state: 'rejected', reason: `${name} could not be read: ${String(error)}` } : d))),
    );
  }

  const remove = (id: string) => set(drafts.filter((d) => d.id !== id));

  function chip(draft: Draft): HTMLElement {
    const ready = draft.state === 'ready' ? draft.attachment : undefined;
    const preview =
      ready?.kind === 'image'
        ? h('span', { class: 'thumb' }, h('img', { src: ready.thumb, alt: '' }))
        : h('span', { class: 'thumb thumb-icon' }, icon(draft.state === 'reading' ? 'loading' : draft.state === 'rejected' ? 'error' : 'file', draft.state === 'reading' ? 'codicon-modifier-spin' : ''));
    const detail = draft.state === 'reading' ? 'Reading…' : draft.state === 'rejected' ? 'Not attached' : ready!.kind === 'image' ? `${ready!.width}×${ready!.height} · ${formatBytes(ready!.bytes)}` : formatBytes(ready!.bytes);
    return h(
      'div',
      { class: `attachment-chip attachment-${draft.state}`, role: 'listitem', 'data-attachment': draft.name, title: draft.state === 'rejected' ? draft.reason : draft.name },
      preview,
      h('span', { class: 'attachment-text' }, h('span', { class: 'attachment-name' }, draft.name), h('span', { class: 'attachment-detail' }, detail)),
      h('button', { type: 'button', class: 'chip-remove', 'aria-label': `Remove ${draft.name}`, title: 'Remove', onclick: () => remove(draft.id) }, icon('close')),
    );
  }

  function render(): void {
    element.hidden = drafts.length === 0;
    const reasons = drafts.flatMap((d) => (d.state === 'rejected' ? [d.reason] : []));
    element.replaceChildren(...drafts.map(chip), ...(reasons.length === 0 ? [] : [h('div', { class: 'attachment-note', role: 'alert' }, reasons.join(' '))]));
  }

  target.addEventListener('paste', (event) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    event.preventDefault();
    for (const file of files) add(file.name || 'pasted image', file);
  });
  target.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy';
    target.classList.add('dropping');
  });
  target.addEventListener('dragleave', () => target.classList.remove('dropping'));
  target.addEventListener('drop', (event) => {
    target.classList.remove('dropping');
    const data = event.dataTransfer;
    if (data === null) return;
    event.preventDefault();
    const files = [...data.files];
    if (files.length > 0) for (const file of files) add(file.name, file);
    else {
      const uris = urisOf(data);
      if (uris.length > 0) post({ type: 'attach-uris', uris });
    }
  });

  return {
    element,
    ready: () => drafts.flatMap((d) => (d.state === 'ready' ? [d.attachment] : [])),
    busy: () => drafts.some((d) => d.state === 'reading'),
    clear: () => set([]),
    picked(files, refused) {
      for (const file of files) add(file.name, blobOfBase64(file.data), file.path);
      if (refused.length > 0) set([...drafts, ...refused.map(({ name, reason }): Draft => ({ id: `a${next++}`, name, state: 'rejected', reason }))]);
    },
  };
}
