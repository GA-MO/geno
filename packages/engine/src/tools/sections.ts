import { formatBytes, MAX_IMAGES, MAX_MESSAGE_BYTES, PAGE_MAX_CHARS, type ImageAttachment } from '@g-code/core';
import { AttachmentError, storeImage } from '../attachments.js';
import type { ToolContext, ToolReply } from './context.js';

/** A PDF page or a notebook cell: text, and images that go to the model as images. */
export type SectionPart = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'image'; readonly bytes: Uint8Array; readonly label: string };
export type Section = { readonly heading: string; readonly parts: readonly SectionPart[] };

export type SectionRead = {
  /** The first line, which names the file and how many sections it has. */
  readonly intro: string;
  readonly unit: 'page' | 'cell';
  /** The input field that picks sections, for the hint that continues a read. */
  readonly field: 'pages' | 'cells';
  readonly first: number;
  readonly last: number;
  readonly total: number;
  /** How many sections the continuing read should ask for. */
  readonly span: number;
  readonly section: (number: number) => Section;
  readonly origin: string;
};

const count = (n: number): string => n.toLocaleString('en-US');

/**
 * Sections `first` to `last` under one reply's limits: PAGE_MAX_CHARS of text, MAX_IMAGES images and
 * MAX_MESSAGE_BYTES of image bytes. A read that hits a limit stops at a section boundary and says how to go on.
 */
export async function readSections(ctx: ToolContext, read: SectionRead): Promise<ToolReply> {
  const blocks: string[] = [read.intro];
  const images: ImageAttachment[] = [];
  let chars = read.intro.length;
  let imageBytes = 0;
  let shownLast = read.first - 1;
  for (let number = read.first; number <= read.last; number++) {
    const section = read.section(number);
    const kept: ImageAttachment[] = [];
    const lines = [`--- ${section.heading} ---`];
    for (const part of section.parts) {
      if (part.kind === 'text') {
        lines.push(part.text);
        continue;
      }
      if (images.length + kept.length >= MAX_IMAGES) {
        lines.push(`[${part.label}: image left out; one read returns at most ${MAX_IMAGES} images. Read ${read.unit} ${number} on its own to see it.]`);
        continue;
      }
      if (imageBytes + part.bytes.length > MAX_MESSAGE_BYTES) {
        lines.push(`[${part.label}: ${formatBytes(part.bytes.length)} image left out; one read returns at most ${formatBytes(MAX_MESSAGE_BYTES)} of images.${number > read.first ? ` Read ${read.unit} ${number} on its own to see it.` : ''}]`);
        continue;
      }
      try {
        const image = await storeImage(ctx.attachmentsDir, part.bytes, { name: `${read.unit}-${number}`, path: read.origin });
        kept.push(image);
        imageBytes += image.bytes;
        lines.push(`[${part.label}: ${image.width}x${image.height} ${image.mediaType.slice('image/'.length).toUpperCase()} image (${formatBytes(image.bytes)}), attached below as image ${images.length + kept.length}]`);
      } catch (error) {
        if (!(error instanceof AttachmentError)) throw error;
        lines.push(`[${part.label}: ${error.message}]`);
      }
    }
    let block = lines.join('\n');
    if (chars + block.length + 1 > PAGE_MAX_CHARS) {
      if (number > read.first) break;
      block = `${block.slice(0, PAGE_MAX_CHARS - chars - 200)}\n[${read.unit} ${number} is longer than one read returns, ${count(PAGE_MAX_CHARS)} characters; this shows its start]`;
    }
    blocks.push(block);
    images.push(...kept);
    chars += block.length + 1;
    shownLast = number;
  }
  if (shownLast < read.total) {
    const next = shownLast + 1;
    const end = Math.min(read.total, next + read.span - 1);
    const stopped = shownLast < read.last ? ` This read stopped at the ${count(PAGE_MAX_CHARS)} character limit.` : '';
    blocks.push(`[${read.unit}s ${read.first}-${shownLast} of ${read.total}.${stopped} Read again with ${read.field}="${next === end ? next : `${next}-${end}`}" to continue.]`);
  }
  const text = blocks.join('\n');
  return images.length === 0 ? text : { text, images };
}
