import {
  imageInfo,
  looksBinary,
  MAX_LONG_SIDE,
  overLimit,
  refusalOf,
  type ImageInfo,
  type ImageMediaType,
} from '@g-code/core/attachments';

/**
 * Attachments as the panel handles them, shared by the webview, which reads, sizes and shows them, and the
 * extension, which sends them to the engine. Nothing here touches the DOM or VS Code.
 */

/** An attachment ready to send: an image as base64 after downscaling, or a text file's content. */
export type OutgoingAttachment =
  | {
      readonly kind: 'image';
      readonly name: string;
      /** Absolute, when the image came from a file on disk. */
      readonly path?: string | undefined;
      readonly mediaType: ImageMediaType;
      readonly data: string;
      readonly bytes: number;
      readonly width: number;
      readonly height: number;
      /** A small data URL the webview drew for the chip and the sent message. */
      readonly thumb: string;
    }
  | { readonly kind: 'file'; readonly name: string; readonly path?: string | undefined; readonly mediaType: string; readonly text: string; readonly bytes: number };

/** What a click on an attachment opens: the file it came from, or its copy in the session's attachments folder. */
export type OpenTarget = { readonly kind: 'path'; readonly path: string } | { readonly kind: 'stored'; readonly file: string };

/** An attachment as a sent message shows it: no bytes, just what the chip needs. */
export type AttachmentView = {
  readonly kind: OutgoingAttachment['kind'];
  readonly name: string;
  readonly bytes: number;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly thumb?: string | undefined;
  readonly open: OpenTarget;
};

/** A file the extension read for the composer, from the file picker or a drop from the explorer. */
export type PickedFile = { readonly name: string; readonly path: string; readonly data: string };

/** A file the extension would not read for the composer, and why. */
export type Refused = { readonly name: string; readonly reason: string };

/** One attachment in the composer, from the moment it is added until the message is sent or it is removed. */
export type Draft =
  | { readonly id: string; readonly name: string; readonly state: 'reading' }
  | { readonly id: string; readonly name: string; readonly state: 'ready'; readonly attachment: OutgoingAttachment }
  | { readonly id: string; readonly name: string; readonly state: 'rejected'; readonly reason: string };

/** What a dropped or pasted file is, from its bytes. */
export type Classified = { readonly kind: 'image'; readonly info: ImageInfo } | { readonly kind: 'text'; readonly text: string } | { readonly kind: 'refused'; readonly reason: string };

export function classify(name: string, mediaType: string, bytes: Uint8Array): Classified {
  const info = imageInfo(bytes);
  if (info !== undefined) return { kind: 'image', info };
  if (looksBinary(bytes)) return { kind: 'refused', reason: refusalOf(name, mediaType) };
  try {
    return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { kind: 'refused', reason: refusalOf(name, mediaType) };
  }
}

/** An image smaller than this, and within the size the model reads, goes as it is. */
export const KEEP_BYTES = 1024 * 1024;

/** Whether an image must be drawn again: it is too big to send as it is. */
export const needsRedraw = (info: ImageInfo, bytes: number): boolean => Math.max(info.width, info.height) > MAX_LONG_SIDE || bytes > KEEP_BYTES;

/**
 * The type to send a redrawn image as. A photo stays JPEG. Anything else is PNG, which keeps screenshots and line
 * art sharp, unless it is large and JPEG comes to less than half of it, which is what a photo saved as PNG does.
 */
export function chooseEncoding(source: string, pngBytes: number, jpegBytes: number): ImageMediaType {
  if (source === 'image/jpeg') return 'image/jpeg';
  return pngBytes > KEEP_BYTES && jpegBytes < pngBytes / 2 ? 'image/jpeg' : 'image/png';
}

/** The long side of a chip's thumbnail, at twice its size on screen. */
export const THUMB_SIDE = 96;

/** The drafts after `id` became ready, or rejected if it would take the message past a limit. */
export function admit(drafts: readonly Draft[], id: string, attachment: OutgoingAttachment): Draft[] {
  const ready = drafts.flatMap((d) => (d.state === 'ready' ? [d.attachment] : []));
  const reason = overLimit(ready, attachment);
  return drafts.map((d) => (d.id !== id ? d : reason === undefined ? { id, name: d.name, state: 'ready', attachment } : { id, name: d.name, state: 'rejected', reason }));
}

export const viewOf = (attachment: OutgoingAttachment, open: OpenTarget): AttachmentView =>
  attachment.kind === 'image'
    ? { kind: 'image', name: attachment.name, bytes: attachment.bytes, width: attachment.width, height: attachment.height, thumb: attachment.thumb, open }
    : { kind: 'file', name: attachment.name, bytes: attachment.bytes, open };
