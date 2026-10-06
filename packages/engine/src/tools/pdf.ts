import { crc32, deflateSync } from 'node:zlib';
import { loadFont, type Font } from './pdf-fonts.js';
import {
  arrayOf,
  decodeStream,
  isDict,
  latin1,
  Name,
  nameOf,
  numberOf,
  Op,
  Parser,
  PdfError,
  Ref,
  Stream,
  textString,
  type Dict,
  type Value,
} from './pdf-syntax.js';

export { PdfError };

/**
 * One page as read returns it. A page with no text that draws an image is a scan: its largest image is the page.
 * The image is a JPEG passed through as stored, or a PNG made from the raw pixels.
 */
export type PdfPage =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'scan'; readonly image: Uint8Array }
  | { readonly kind: 'unreadable'; readonly reason: string }
  | { readonly kind: 'blank' };

export type PdfDocument = { readonly pageCount: number; readonly page: (number: number) => PdfPage };

type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];
const apply = (m: Matrix, x: number, y: number): { x: number; y: number } => ({ x: x * m[0] + y * m[2] + m[4], y: x * m[1] + y * m[3] + m[5] });
const matrixOf = (value: Value | undefined): Matrix | undefined => {
  const list = arrayOf(value)?.map((v) => numberOf(v));
  return list?.length === 6 && list.every((n) => n !== undefined) ? (list as unknown as Matrix) : undefined;
};

const OBJECT = /(?<![0-9])(\d+)\s+(\d+)\s+obj\b/g;
const MAX_PAGES = 100_000;
const MAX_OPERATORS = 2_000_000;
const MAX_FORM_DEPTH = 12;
/** Raw scans are scaled down to the side the model reads without resizing. */
const MAX_SCAN_SIDE = 1568;

/** Every object in the file, found by scanning for `n g obj` rather than trusting the cross-reference table. */
function indexObjects(bytes: Uint8Array, text: string): { objects: Map<number, Value>; trailers: Dict[] } {
  const objects = new Map<number, Value>();
  const trailers: Dict[] = [];
  const parser = new Parser(bytes);
  OBJECT.lastIndex = 0;
  for (let match = OBJECT.exec(text); match !== null; match = OBJECT.exec(text)) {
    parser.pos = match.index + match[0].length;
    let value: Value;
    try {
      const parsed = parser.object();
      if (parsed instanceof Op) continue;
      value = parsed;
    } catch {
      continue;
    }
    const after = parser.pos;
    parser.skipSpace();
    if (isDict(value) && text.startsWith('stream', parser.pos)) {
      let start = parser.pos + 6;
      if (bytes[start] === 13) start++;
      if (bytes[start] === 10) start++;
      const length = numberOf(value.get('Length'));
      const fits = length !== undefined && /^\s*endstream/.test(text.slice(start + length, start + length + 32));
      const end = fits ? start + length : text.indexOf('endstream', start);
      if (end === -1) continue;
      const stream = new Stream(value, bytes.subarray(start, fits ? end : trimEol(bytes, start, end)));
      value = stream;
      OBJECT.lastIndex = end + 9;
      if (nameOf(value.dict.get('Type')) === 'XRef') trailers.push(value.dict);
      if (nameOf(value.dict.get('Type')) === 'ObjStm') expandObjectStream(stream, objects);
    } else OBJECT.lastIndex = Math.max(OBJECT.lastIndex, after);
    objects.set(Number(match[1]), value);
  }
  for (let at = text.indexOf('trailer'); at !== -1; at = text.indexOf('trailer', at + 7)) {
    parser.pos = at + 7;
    try {
      const dict = parser.object();
      if (isDict(dict)) trailers.push(dict);
    } catch {
      // A damaged trailer is skipped like a damaged object; the catalog can still be found by type.
    }
  }
  return { objects, trailers };
}

function trimEol(bytes: Uint8Array, start: number, end: number): number {
  let at = end;
  if (at > start && bytes[at - 1] === 10) at--;
  if (at > start && bytes[at - 1] === 13) at--;
  return at;
}

function expandObjectStream(stream: Stream, objects: Map<number, Value>): void {
  const count = numberOf(stream.dict.get('N')) ?? 0;
  const first = numberOf(stream.dict.get('First')) ?? 0;
  let bytes: Uint8Array;
  try {
    bytes = decodeStream(stream).bytes;
  } catch {
    return;
  }
  const header = new Parser(bytes.subarray(0, first));
  const entries: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const num = header.token();
    const offset = header.token();
    if (typeof num !== 'number' || typeof offset !== 'number') break;
    entries.push([num, offset]);
  }
  const body = new Parser(bytes);
  for (const [num, offset] of entries) {
    body.pos = first + offset;
    try {
      const value = body.object();
      if (!(value instanceof Op)) objects.set(num, value);
    } catch {
      // One damaged member does not lose the others.
    }
  }
}

class Document {
  private readonly fonts = new Map<Dict, Font>();

  constructor(private readonly objects: Map<number, Value>) {}

  resolve = (value: Value | undefined): Value | undefined => {
    for (let hops = 0; value instanceof Ref && hops < 32; hops++) value = this.objects.get(value.num) ?? null;
    return value instanceof Ref ? undefined : value;
  };

  dict(value: Value | undefined): Dict | undefined {
    const resolved = this.resolve(value);
    return isDict(resolved) ? resolved : resolved instanceof Stream ? resolved.dict : undefined;
  }

  font(dict: Dict): Font {
    let font = this.fonts.get(dict);
    if (font === undefined) {
      try {
        font = loadFont(dict, this.resolve);
      } catch {
        font = { codes: (bytes) => Array.from(bytes, (code) => ({ code, length: 1 })), text: () => undefined, width: () => 500 };
      }
      this.fonts.set(dict, font);
    }
    return font;
  }

  /** The leaves of the page tree in order, each with the resources it inherits. */
  pages(root: Dict): { readonly page: Dict; readonly resources: Dict | undefined }[] {
    const out: { page: Dict; resources: Dict | undefined }[] = [];
    const seen = new Set<Dict>();
    const walk = (node: Dict | undefined, inherited: Dict | undefined, depth: number): void => {
      if (node === undefined || seen.has(node) || depth > 64 || out.length >= MAX_PAGES) return;
      seen.add(node);
      const resources = this.dict(node.get('Resources')) ?? inherited;
      const kids = arrayOf(this.resolve(node.get('Kids')));
      if (kids !== undefined && nameOf(node.get('Type')) !== 'Page') for (const kid of kids) walk(this.dict(kid), resources, depth + 1);
      else out.push({ page: node, resources });
    };
    walk(this.dict(root.get('Pages')), undefined, 0);
    return out;
  }

  contents(page: Dict): Uint8Array {
    const value = this.resolve(page.get('Contents'));
    const parts = (arrayOf(value) ?? [value]).map((part) => this.resolve(part)).filter((part): part is Stream => part instanceof Stream);
    const decoded = parts.map((part) => decodeStream(part).bytes);
    const joined = new Uint8Array(decoded.reduce((sum, part) => sum + part.length + 1, 0));
    let at = 0;
    for (const part of decoded) {
      joined.set(part, at);
      joined[at + part.length] = 10;
      at += part.length + 1;
    }
    return joined;
  }
}

type ImageUse = { readonly stream: Stream; readonly area: number };

/** Walks a page's content the way a viewer would, but only to place text and note images. Nothing in it runs. */
class TextWalker {
  private out = '';
  private last: { x: number; y: number; size: number } | undefined;
  private missingGlyphs = 0;
  private operators = 0;
  readonly images: ImageUse[] = [];

  constructor(private readonly doc: Document) {}

  run(content: Uint8Array, resources: Dict | undefined, ctm: Matrix, depth: number, forms: Set<Stream>): void {
    const parser = new Parser(content);
    const operands: Value[] = [];
    const stack: Matrix[] = [];
    const actual: { text: string | undefined; shown: boolean }[] = [];
    let font: Font | undefined;
    let size = 0;
    let charSpace = 0;
    let wordSpace = 0;
    let scale = 1;
    let leading = 0;
    let rise = 0;
    let tm: Matrix = IDENTITY;
    let tlm: Matrix = IDENTITY;
    const nextLine = (tx: number, ty: number): void => {
      tlm = multiply([1, 0, 0, 1, tx, ty], tlm);
      tm = tlm;
    };
    const show = (bytes: Uint8Array): void => {
      if (font === undefined) return;
      const replacement = actual.findLast((a) => a.text !== undefined);
      // Glyph by glyph, because character spacing alone can open a word gap inside one string.
      for (const { code, length } of font.codes(bytes)) {
        const rendering = multiply([size * scale, 0, 0, size, 0, rise], multiply(tm, ctm));
        const glyphSize = Math.hypot(rendering[2], rendering[3]);
        if (replacement === undefined) {
          this.place(apply(rendering, 0, 0), glyphSize);
          const text = font.text(code);
          if (text === undefined) this.missingGlyphs++;
          else this.out += text;
        } else if (!replacement.shown) {
          this.place(apply(rendering, 0, 0), glyphSize);
          this.out += replacement.text;
          replacement.shown = true;
        }
        const width = (font.width(code) / 1000) * size * scale;
        this.last = { ...apply(multiply([1, 0, 0, 1, width, 0], multiply(tm, ctm)), 0, rise), size: glyphSize };
        tm = multiply([1, 0, 0, 1, width + (charSpace + (length === 1 && code === 32 ? wordSpace : 0)) * scale, 0], tm);
      }
    };
    while (!parser.atEnd()) {
      if (++this.operators > MAX_OPERATORS) throw new PdfError('a page has more than 2,000,000 drawing operators');
      const token = parser.object();
      if (!(token instanceof Op)) {
        operands.push(token);
        continue;
      }
      const n = (i: number): number => numberOf(operands[i]) ?? 0;
      switch (token.value) {
        case 'q':
          stack.push(ctm);
          break;
        case 'Q':
          ctm = stack.pop() ?? ctm;
          break;
        case 'cm':
          ctm = multiply([n(0), n(1), n(2), n(3), n(4), n(5)], ctm);
          break;
        case 'BT':
          tm = tlm = IDENTITY;
          break;
        case 'Tf': {
          const fonts = this.doc.dict(resources?.get('Font'));
          const dict = this.doc.dict(fonts?.get(nameOf(operands[0]) ?? ''));
          font = dict === undefined ? undefined : this.doc.font(dict);
          size = n(1);
          break;
        }
        case 'Tc':
          charSpace = n(0);
          break;
        case 'Tw':
          wordSpace = n(0);
          break;
        case 'Tz':
          scale = n(0) / 100;
          break;
        case 'TL':
          leading = n(0);
          break;
        case 'Ts':
          rise = n(0);
          break;
        case 'Td':
          nextLine(n(0), n(1));
          break;
        case 'TD':
          leading = -n(1);
          nextLine(n(0), n(1));
          break;
        case 'Tm':
          tm = tlm = [n(0), n(1), n(2), n(3), n(4), n(5)];
          break;
        case 'T*':
          nextLine(0, -leading);
          break;
        case 'Tj':
          if (operands[0] instanceof Uint8Array) show(operands[0]);
          break;
        case "'":
          nextLine(0, -leading);
          if (operands[0] instanceof Uint8Array) show(operands[0]);
          break;
        case '"':
          wordSpace = n(0);
          charSpace = n(1);
          nextLine(0, -leading);
          if (operands[2] instanceof Uint8Array) show(operands[2]);
          break;
        case 'TJ':
          for (const item of arrayOf(operands[0]) ?? []) {
            if (item instanceof Uint8Array) show(item);
            else if (typeof item === 'number') tm = multiply([1, 0, 0, 1, (-item / 1000) * size * scale, 0], tm);
          }
          break;
        case 'BDC': {
          const props = isDict(operands[1]) ? operands[1] : this.doc.dict(this.doc.dict(resources?.get('Properties'))?.get(nameOf(operands[1]) ?? ''));
          const text = props?.get('ActualText');
          actual.push({ text: text instanceof Uint8Array ? textString(text) : undefined, shown: false });
          break;
        }
        case 'BMC':
          actual.push({ text: undefined, shown: false });
          break;
        case 'EMC':
          actual.pop();
          break;
        case 'BI':
          this.skipInlineImage(parser);
          break;
        case 'Do': {
          const xobject = this.doc.resolve(this.doc.dict(resources?.get('XObject'))?.get(nameOf(operands[0]) ?? ''));
          if (!(xobject instanceof Stream)) break;
          const subtype = nameOf(xobject.dict.get('Subtype'));
          if (subtype === 'Image') this.images.push({ stream: xobject, area: Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) });
          else if (subtype === 'Form' && depth < MAX_FORM_DEPTH && !forms.has(xobject)) {
            forms.add(xobject);
            const matrix = matrixOf(this.doc.resolve(xobject.dict.get('Matrix'))) ?? IDENTITY;
            try {
              this.run(decodeStream(xobject).bytes, this.doc.dict(xobject.dict.get('Resources')) ?? resources, multiply(matrix, ctm), depth + 1, forms);
            } finally {
              forms.delete(xobject);
            }
          }
          break;
        }
      }
      operands.length = 0;
    }
  }

  /** Breaks a line when the text moves down, and puts a space where it jumps right by more than a thin gap. */
  private place(at: { x: number; y: number }, size: number): void {
    const last = this.last;
    if (last === undefined || this.out === '') return;
    const height = Math.max(size, last.size, 0.001);
    if (Math.abs(at.y - last.y) > height * 0.5) this.out += '\n';
    else if (Math.abs(at.x - last.x) > height * 0.15 && !/\s$/.test(this.out)) this.out += ' ';
  }

  private skipInlineImage(parser: Parser): void {
    for (let token = parser.object(); !(token instanceof Op && (token.value === 'ID' || token.value === '')); token = parser.object());
    const b = Buffer.from(parser.bytes.buffer, parser.bytes.byteOffset, parser.bytes.byteLength);
    const space = (at: number): boolean => at >= b.length || b[at] === 32 || b[at] === 10 || b[at] === 13 || b[at] === 9;
    let at = b.indexOf('EI', parser.pos + 1, 'latin1');
    while (at !== -1 && !(space(at - 1) && space(at + 2))) at = b.indexOf('EI', at + 1, 'latin1');
    parser.pos = at === -1 ? b.length : at + 2;
  }

  result(): { text: string; missingGlyphs: number } {
    const text = this.out
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/, ''))
      .join('\n')
      .trim();
    return { text, missingGlyphs: this.missingGlyphs };
  }
}

function pngOf(width: number, height: number, channels: 1 | 3, pixels: Uint8Array): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 1 ? 0 : 2;
  const rows = Buffer.alloc((width * channels + 1) * height);
  for (let y = 0; y < height; y++) rows.set(pixels.subarray(y * width * channels, (y + 1) * width * channels), y * (width * channels + 1) + 1);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', new Uint8Array())]);
}

function shrink(width: number, height: number, channels: number, pixels: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  const factor = Math.ceil(Math.max(width, height) / MAX_SCAN_SIDE);
  if (factor <= 1) return { width, height, pixels };
  const w = Math.floor(width / factor);
  const h = Math.floor(height / factor);
  const out = new Uint8Array(w * h * channels);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy++) for (let dx = 0; dx < factor; dx++) sum += pixels[((y * factor + dy) * width + x * factor + dx) * channels + c]!;
        out[(y * w + x) * channels + c] = Math.round(sum / (factor * factor));
      }
    }
  }
  return { width: w, height: h, pixels: out };
}

const IMAGE_FORMATS: Record<string, string> = { JPXDecode: 'JPEG 2000', CCITTFaxDecode: 'CCITT fax', JBIG2Decode: 'JBIG2' };

/** A scanned page's image as a PNG or JPEG file, or why read cannot show it. */
function scanImage(doc: Document, stream: Stream): { image: Uint8Array } | { reason: string } {
  const { bytes, imageFilter } = decodeStream(stream);
  if (imageFilter === 'DCTDecode') return { image: bytes };
  if (imageFilter !== undefined) return { reason: `its image is ${IMAGE_FORMATS[imageFilter] ?? imageFilter}, which read cannot show` };
  const width = numberOf(doc.resolve(stream.dict.get('Width'))) ?? 0;
  const height = numberOf(doc.resolve(stream.dict.get('Height'))) ?? 0;
  const bpc = numberOf(doc.resolve(stream.dict.get('BitsPerComponent'))) ?? 8;
  let space = doc.resolve(stream.dict.get('ColorSpace'));
  let palette: { base: number; table: Uint8Array } | undefined;
  const components = (value: Value | undefined): number | undefined => {
    const name = nameOf(value) ?? nameOf(arrayOf(value)?.[0]);
    if (name === 'DeviceGray' || name === 'CalGray' || name === 'G') return 1;
    if (name === 'DeviceRGB' || name === 'CalRGB' || name === 'RGB') return 3;
    if (name === 'DeviceCMYK' || name === 'CMYK') return 4;
    if (name === 'ICCBased') {
      const profile = doc.resolve(arrayOf(value)?.[1]);
      return profile instanceof Stream ? numberOf(profile.dict.get('N')) : undefined;
    }
    return undefined;
  };
  if (nameOf(arrayOf(space)?.[0]) === 'Indexed' || nameOf(arrayOf(space)?.[0]) === 'I') {
    const list = arrayOf(space)!;
    const base = components(doc.resolve(list[1]));
    const lookup = doc.resolve(list[3]);
    const table = lookup instanceof Stream ? decodeStream(lookup).bytes : lookup instanceof Uint8Array ? lookup : undefined;
    if (base === undefined || table === undefined) return { reason: 'its image uses a color palette read cannot decode' };
    palette = { base, table };
    space = undefined;
  }
  const channels = palette === undefined ? (stream.dict.get('ImageMask') === true ? 1 : components(space)) : 1;
  if (channels === undefined || width <= 0 || height <= 0 || ![1, 2, 4, 8].includes(bpc) || (palette === undefined && bpc !== 8 && channels !== 1)) {
    return { reason: 'its image uses a color format read cannot decode' };
  }
  const rowBytes = Math.ceil((width * channels * bpc) / 8);
  if (bytes.length < rowBytes * height) return { reason: 'its image data is cut short' };
  const out = channels === 1 && palette === undefined ? 1 : 3;
  const pixels = new Uint8Array(width * height * out);
  const max = (1 << bpc) - 1;
  const invert = stream.dict.get('ImageMask') === true;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sample = (c: number): number => {
        const bit = (x * channels + c) * bpc;
        const byte = bytes[y * rowBytes + (bit >> 3)]!;
        return bpc === 8 ? byte : (byte >> (8 - bpc - (bit & 7))) & max;
      };
      const at = (y * width + x) * out;
      if (palette !== undefined) {
        const index = sample(0);
        for (let c = 0; c < 3; c++) {
          const base = palette.base === 1 ? palette.table[index]! : palette.base === 3 ? palette.table[index * 3 + c]! : cmyk(palette.table, index * 4, c);
          pixels[at + c] = base ?? 0;
        }
      } else if (channels === 1) pixels[at] = Math.round(((invert ? max - sample(0) : sample(0)) * 255) / max);
      else if (channels === 3) for (let c = 0; c < 3; c++) pixels[at + c] = sample(c);
      else for (let c = 0; c < 3; c++) pixels[at + c] = cmyk(Uint8Array.from([sample(0), sample(1), sample(2), sample(3)]), 0, c);
    }
  }
  const small = shrink(width, height, out, pixels);
  return { image: pngOf(small.width, small.height, out === 1 ? 1 : 3, small.pixels) };
}

const cmyk = (table: Uint8Array, at: number, channel: number): number => Math.round((255 - table[at + channel]!) * (1 - table[at + 3]! / 255));

/** Opens a PDF for reading. Throws PdfError for a file that is not a PDF, is encrypted, or has no readable pages. */
export function openPdf(bytes: Uint8Array): PdfDocument {
  const text = latin1(bytes);
  if (!text.slice(0, 1024).includes('%PDF-')) throw new PdfError('is not a PDF: it has no %PDF- header');
  const { objects, trailers } = indexObjects(bytes, text);
  const doc = new Document(objects);
  if (trailers.some((trailer) => trailer.has('Encrypt'))) throw new PdfError('is encrypted; read cannot open password-protected PDFs');
  const roots = trailers.map((trailer) => doc.dict(trailer.get('Root'))).filter((root): root is Dict => root?.has('Pages') === true);
  const root = roots.at(-1) ?? [...objects.values()].map((value) => (isDict(value) ? value : undefined)).findLast((value) => nameOf(value?.get('Type')) === 'Catalog');
  if (root === undefined) throw new PdfError('is damaged: read found no page tree in it');
  const pages = doc.pages(root);
  if (pages.length === 0) throw new PdfError('is damaged: its page tree holds no pages');
  return {
    pageCount: pages.length,
    page(number) {
      const { page, resources } = pages[number - 1]!;
      const walker = new TextWalker(doc);
      try {
        walker.run(doc.contents(page), resources, IDENTITY, 0, new Set());
      } catch (error) {
        if (!(error instanceof PdfError)) throw error;
        const partial = walker.result().text;
        return partial === '' ? { kind: 'unreadable', reason: error.message } : { kind: 'text', text: `${partial}\n[the rest of this page could not be read: ${error.message}]` };
      }
      const { text, missingGlyphs } = walker.result();
      if (text !== '') return { kind: 'text', text };
      const largest = walker.images.reduce<ImageUse | undefined>((best, use) => (best === undefined || use.area > best.area ? use : best), undefined);
      if (largest !== undefined) {
        const scan = scanImage(doc, largest.stream);
        return 'image' in scan ? { kind: 'scan', image: scan.image } : { kind: 'unreadable', reason: `it is a scan, and ${scan.reason}` };
      }
      if (missingGlyphs > 0) return { kind: 'unreadable', reason: 'its text uses a font with no map to Unicode' };
      return { kind: 'blank' };
    },
  };
}

