import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import {
  asSha256,
  ATTACHMENT_META,
  attachmentFileName,
  formatBytes,
  imageInfo,
  IMAGE_MEDIA_TYPES,
  looksBinary,
  MAX_IMAGE_SIDE,
  overLimit,
  type Attachment,
  type FileAttachment,
  type ImageAttachment,
  type Sha256,
  type SessionId,
  type StoredAttachments,
  type TurnEvent,
} from '@g-code/core';
import { isMissing, type Store } from './store.js';

/** A prompt block the engine refuses as an attachment, such as a binary file or a ninth image. */
export class AttachmentError extends Error {}

const storedFields = {
  sha256: z.string().regex(/^[0-9a-f]{64}$/).transform(asSha256),
  name: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  path: z.string().refine(path.isAbsolute, 'must be an absolute path').optional(),
};

export const imageAttachmentSchema = z.strictObject({
  kind: z.literal('image'),
  ...storedFields,
  mediaType: z.enum(IMAGE_MEDIA_TYPES),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export const attachmentSchema = z.discriminatedUnion('kind', [imageAttachmentSchema, z.strictObject({ kind: z.literal('file'), ...storedFields, mediaType: z.string().min(1) })]);

/** Where a session's attachments live: `$GCODE_HOME/sessions/<id>/attachments`, beside its log. */
export const attachmentsDir = (store: Store, id: SessionId): string => path.join(store.sessionsDir, id, 'attachments');

const sha256Of = (bytes: Uint8Array): Sha256 => asSha256(createHash('sha256').update(bytes).digest('hex'));

/**
 * Writes the bytes under their hash unless that file is there already, so storing the same image again, or
 * rerunning after a crash, changes nothing. A temporary file renamed into place means a crash never leaves a torn
 * file under the final name.
 */
async function writeOnce(dir: string, attachment: Attachment, bytes: Uint8Array): Promise<void> {
  const file = path.join(dir, attachmentFileName(attachment));
  const exists = await access(file).then(
    () => true,
    (error: unknown) => {
      if (isMissing(error)) return false;
      throw error;
    },
  );
  if (exists) return;
  await mkdir(dir, { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, file);
}

/** What an attachment is called and, when it was a file on disk, its absolute path. */
export type Origin = { readonly name: string; readonly path?: string | undefined };

/** Stores an image the read tool or the user sent. Its type and size come from its bytes. */
export async function storeImage(dir: string, bytes: Uint8Array, source: Origin): Promise<ImageAttachment> {
  const info = imageInfo(bytes);
  if (info === undefined) throw new AttachmentError(`${source.name} is not a PNG, JPEG, GIF or WebP image`);
  if (Math.max(info.width, info.height) > MAX_IMAGE_SIDE) {
    throw new AttachmentError(`${source.name} is ${info.width}x${info.height} pixels; images can be at most ${MAX_IMAGE_SIDE} pixels on a side`);
  }
  const image: ImageAttachment = { kind: 'image', sha256: sha256Of(bytes), name: source.name, bytes: bytes.length, ...info, ...(source.path === undefined ? {} : { path: source.path }) };
  await writeOnce(dir, image, bytes);
  return image;
}

export async function storeFile(dir: string, text: string, source: Origin & { readonly mediaType: string }): Promise<FileAttachment> {
  const bytes = new TextEncoder().encode(text);
  const file: FileAttachment = {
    kind: 'file',
    sha256: sha256Of(bytes),
    name: source.name,
    bytes: bytes.length,
    mediaType: source.mediaType,
    ...(source.path === undefined ? {} : { path: source.path }),
  };
  await writeOnce(dir, file, bytes);
  return file;
}

const referenced = (events: readonly TurnEvent[]): Attachment[] =>
  events.flatMap((e) => (e.kind === 'user' ? (e.attachments ?? []) : e.kind === 'tool-result' ? (e.images ?? []) : []));

/**
 * The stored bytes of every attachment `events` reference, for building a request. `cache` keeps what one run has
 * loaded, since every model call of a turn replays the same images. A file that is gone is left out, and the
 * replay says so to the model.
 */
export async function loadAttachments(dir: string, events: readonly TurnEvent[], cache: Map<Sha256, string> = new Map()): Promise<StoredAttachments> {
  for (const attachment of referenced(events)) {
    if (cache.has(attachment.sha256)) continue;
    try {
      const bytes = await readFile(path.join(dir, attachmentFileName(attachment)));
      cache.set(attachment.sha256, attachment.kind === 'image' ? bytes.toString('base64') : bytes.toString('utf8'));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return cache;
}

const attachmentMeta = z.object({ name: z.string().min(1).optional() }).loose();

/** Whether a prompt block is something the user attached, rather than a mention or the prompt's text. */
export const isAttachmentBlock = (block: acp.ContentBlock): boolean =>
  block.type === 'image' || (block.type === 'resource' && block._meta?.[ATTACHMENT_META] !== undefined);

function sourceOf(uri: string | null | undefined, meta: unknown, fallback: string): Origin {
  const parsed = attachmentMeta.safeParse(meta ?? {});
  const file = uri?.startsWith('file:') ? fileURLToPath(uri) : undefined;
  const name = (parsed.success ? parsed.data.name : undefined) ?? (file === undefined ? fallback : path.basename(file));
  return { name, path: file };
}

export type Incoming =
  | { readonly kind: 'image'; readonly bytes: Uint8Array; readonly source: Origin }
  | { readonly kind: 'file'; readonly text: string; readonly source: Origin & { readonly mediaType: string } };

/**
 * The images and files among a prompt's blocks, checked against the per-message limits before anything is
 * stored: an `image` block, and an embedded text `resource` marked with ATTACHMENT_META.
 */
export function incomingAttachments(blocks: readonly acp.ContentBlock[]): Incoming[] {
  const incoming: Incoming[] = [];
  const sizes: { kind: Attachment['kind']; bytes: number }[] = [];
  const add = (item: Incoming, bytes: number) => {
    const over = overLimit(sizes, { kind: item.kind, bytes });
    if (over !== undefined) throw new AttachmentError(over);
    sizes.push({ kind: item.kind, bytes });
    incoming.push(item);
  };
  blocks.forEach((block, i) => {
    if (block.type === 'image') {
      const bytes = Buffer.from(block.data, 'base64');
      add({ kind: 'image', bytes, source: sourceOf(block.uri, block._meta?.[ATTACHMENT_META], `image-${i + 1}`) }, bytes.length);
    } else if (block.type === 'resource' && block._meta?.[ATTACHMENT_META] !== undefined) {
      const source = sourceOf(block.resource.uri, block._meta[ATTACHMENT_META], `file-${i + 1}`);
      if (!('text' in block.resource)) throw new AttachmentError(`${source.name} is a binary file; attach an image or a text file`);
      const { text } = block.resource;
      if (looksBinary(new TextEncoder().encode(text.slice(0, 8000)))) throw new AttachmentError(`${source.name} is a binary file; attach an image or a text file`);
      add({ kind: 'file', text, source: { ...source, mediaType: block.resource.mimeType ?? 'text/plain' } }, Buffer.byteLength(text));
    }
  });
  return incoming;
}

/**
 * Stores a prompt's attachments and returns their references, in the order the user attached them. A path is
 * resolved through symlinks, as the workspace is, so a file inside it is named relative to it.
 */
export async function storeAttachments(dir: string, incoming: readonly Incoming[]): Promise<Attachment[]> {
  const attachments: Attachment[] = [];
  for (const item of incoming) {
    const file = item.source.path;
    const real = file === undefined ? undefined : await realpath(file).catch(() => file);
    attachments.push(
      item.kind === 'image' ? await storeImage(dir, item.bytes, { ...item.source, path: real }) : await storeFile(dir, item.text, { ...item.source, path: real }),
    );
  }
  return attachments;
}

export const describeImage = (shown: string, image: ImageAttachment): string =>
  `${shown} is a ${image.width}x${image.height} ${image.mediaType.slice('image/'.length).toUpperCase()} image (${formatBytes(image.bytes)}), attached below.`;
