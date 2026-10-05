import type { ImageBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ContextItem } from './context.js';
import { linesOf, numberedPage } from './page.js';
import type { Brand } from './types.js';

/**
 * Images and files the user sends with a prompt, and images the read tool returns. The bytes live once in the
 * session's attachments folder, named by their SHA-256; the session log keeps only an Attachment, the reference.
 * Nothing here touches the disk, so the webview shares the sizing and limit rules.
 */

export type Sha256 = Brand<string, 'Sha256'>;
export const asSha256 = (raw: string): Sha256 => raw as Sha256;

/** The image types the model reads. */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];
export const isImageMediaType = (raw: string): raw is ImageMediaType => (IMAGE_MEDIA_TYPES as readonly string[]).includes(raw);

const EXTENSIONS: Readonly<Record<ImageMediaType, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

type Stored = {
  readonly sha256: Sha256;
  /** The file name the user saw, such as `screenshot.png`. */
  readonly name: string;
  readonly bytes: number;
  /** Where it came from, absolute, when that was a file on disk; a pasted image has none. */
  readonly path?: string | undefined;
};

export type ImageAttachment = Stored & { readonly kind: 'image'; readonly mediaType: ImageMediaType; readonly width: number; readonly height: number };

/** A text file, sent as its content like an `@file`. */
export type FileAttachment = Stored & { readonly kind: 'file'; readonly mediaType: string };

export type Attachment = ImageAttachment | FileAttachment;

/** The file an attachment is stored in, inside the session's attachments folder. */
export const attachmentFileName = (attachment: Attachment): string =>
  `${attachment.sha256}.${attachment.kind === 'image' ? EXTENSIONS[attachment.mediaType] : 'txt'}`;

/** What the attachments folder held for a session's references when a request was built: base64 for an image, text for a file. */
export type StoredAttachments = ReadonlyMap<Sha256, string>;

export const NO_ATTACHMENTS: StoredAttachments = new Map();

const missing = (image: ImageAttachment): TextBlockParam => ({
  type: 'text',
  text: `[The image ${image.name} the user attached is no longer in the session's attachments folder.]`,
});

/** An image reference as the block the model reads; the bytes are the stored ones, so a replay sends what the first request sent. */
export function imageBlock(image: ImageAttachment, stored: StoredAttachments): ImageBlockParam | TextBlockParam {
  const data = stored.get(image.sha256);
  return data === undefined ? missing(image) : { type: 'image', source: { type: 'base64', media_type: image.mediaType, data } };
}

/** A file attachment as the context item an `@file` of the same text would be; `shown` is the path the model sees. */
export function fileItem(file: FileAttachment, stored: StoredAttachments, shown: string): ContextItem {
  const text = stored.get(file.sha256);
  if (text === undefined) return { kind: 'file', path: shown, text: `[${shown} is no longer in the session's attachments folder.]` };
  return { kind: 'file', path: shown, text: text === '' ? `${shown} is empty` : numberedPage(linesOf(text), 1, undefined) };
}

/** The most an image's long side may be before the webview scales it down, the size the model reads without resizing. */
export const MAX_LONG_SIDE = 1568;
export const MAX_IMAGES = 8;
/** Per message, after downscaling, counting files too. */
export const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
/** Past this either way the model refuses an image, so the read tool does too. */
export const MAX_IMAGE_SIDE = 8000;

/** The size an image is drawn at so its long side is at most `max`, keeping its aspect ratio. */
export function fitWithin(width: number, height: number, max: number = MAX_LONG_SIDE): { readonly width: number; readonly height: number } {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const scale = max / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Why one more attachment would not fit in a message that already has `current`, or undefined when it fits. */
export function overLimit(current: readonly Pick<Attachment, 'kind' | 'bytes'>[], next: Pick<Attachment, 'kind' | 'bytes'>): string | undefined {
  if (next.kind === 'image' && current.filter((a) => a.kind === 'image').length >= MAX_IMAGES) {
    return `A message holds up to ${MAX_IMAGES} images.`;
  }
  const total = current.reduce((sum, a) => sum + a.bytes, 0) + next.bytes;
  if (total > MAX_MESSAGE_BYTES) {
    return `This would bring the message to ${formatBytes(total)}; a message holds up to ${formatBytes(MAX_MESSAGE_BYTES)} of attachments.`;
  }
  return undefined;
}

/** Why a file that is neither an image nor text is refused. */
export const refusalOf = (name: string, mediaType: string): string =>
  mediaType === 'application/pdf' || name.toLowerCase().endsWith('.pdf')
    ? `${name} is a PDF, which Geno cannot read yet.`
    : `${name} is a binary file; attach an image or a text file.`;

// Git's heuristic, as the read tool uses it: a NUL byte in the first 8000 bytes means binary.
export const looksBinary = (head: Uint8Array): boolean => head.subarray(0, 8000).includes(0);

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

export type ImageInfo = { readonly mediaType: ImageMediaType; readonly width: number; readonly height: number };

function jpegSize(b: Uint8Array): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return undefined;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    // Start-of-frame markers, every SOFn but the DHT, JPG and DAC markers that share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    i += 2 + u16be(b, i + 2);
  }
  return undefined;
}

function webpSize(b: Uint8Array): { width: number; height: number } | undefined {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ' && b.length >= 30) return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  if (chunk === 'VP8L' && b.length >= 25) {
    const [b0, b1, b2, b3] = [b[21]!, b[22]!, b[23]!, b[24]!];
    return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
  }
  if (chunk === 'VP8X' && b.length >= 30) return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
  return undefined;
}

/** The type and pixel size of an image from its own bytes, whatever its name says; undefined when it is not one the model reads. */
export function imageInfo(b: Uint8Array): ImageInfo | undefined {
  const sized = (mediaType: ImageMediaType, size: { width: number; height: number } | undefined): ImageInfo | undefined =>
    size === undefined || size.width <= 0 || size.height <= 0 ? undefined : { mediaType, ...size };
  if (b.length >= 24 && u32be(b, 0) === 0x89504e47 && u32be(b, 4) === 0x0d0a1a0a) return sized('image/png', { width: u32be(b, 16), height: u32be(b, 20) });
  if (b.length >= 10 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return sized('image/gif', { width: u16le(b, 6), height: u16le(b, 8) });
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return sized('image/jpeg', jpegSize(b));
  if (b.length >= 16 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return sized('image/webp', webpSize(b));
  return undefined;
}
