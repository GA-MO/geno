import { constants, inflateSync } from 'node:zlib';

/** A PDF that cannot be read: not a PDF, encrypted, or too damaged to find its pages. */
export class PdfError extends Error {}

export class Name {
  constructor(readonly value: string) {}
}

export class Ref {
  constructor(
    readonly num: number,
    readonly gen: number,
  ) {}
}

/** A bare keyword: an operator in a content stream, or `obj`, `stream`, `R` and the like in the file. */
export class Op {
  constructor(readonly value: string) {}
}

export class Stream {
  constructor(
    readonly dict: Dict,
    readonly raw: Uint8Array,
  ) {}
}

export type Dict = ReadonlyMap<string, Value>;
export type Value = null | boolean | number | Name | Uint8Array | Ref | readonly Value[] | Dict | Stream;
type Token = Value | Op;

const EOF = new Op('');
const WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITERS = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));
const isRegular = (byte: number): boolean => !WHITESPACE.has(byte) && !DELIMITERS.has(byte);
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;

export const isDict = (value: unknown): value is Dict => value instanceof Map;
export const nameOf = (value: Value | undefined): string | undefined => (value instanceof Name ? value.value : undefined);
export const numberOf = (value: Value | undefined): number | undefined => (typeof value === 'number' ? value : undefined);
export const arrayOf = (value: Value | undefined): readonly Value[] | undefined => (Array.isArray(value) ? (value as readonly Value[]) : undefined);
export const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1');

/** Reads PDF objects from bytes. Content streams use the same syntax, so it reads those too. */
export class Parser {
  constructor(
    readonly bytes: Uint8Array,
    public pos = 0,
  ) {}

  skipSpace(): void {
    const b = this.bytes;
    while (this.pos < b.length) {
      const c = b[this.pos]!;
      if (WHITESPACE.has(c)) this.pos++;
      else if (c === 0x25) while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
      else break;
    }
  }

  private regularRun(): string {
    const start = this.pos;
    while (this.pos < this.bytes.length && isRegular(this.bytes[this.pos]!)) this.pos++;
    return latin1(this.bytes.subarray(start, this.pos));
  }

  token(): Token {
    this.skipSpace();
    const b = this.bytes;
    if (this.pos >= b.length) return EOF;
    const c = b[this.pos]!;
    if (c === 0x2f) {
      this.pos++;
      return new Name(this.regularRun().replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))));
    }
    if (c === 0x28) return this.literalString();
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) {
        this.pos += 2;
        return new Op('<<');
      }
      return this.hexString();
    }
    if (c === 0x3e && b[this.pos + 1] === 0x3e) {
      this.pos += 2;
      return new Op('>>');
    }
    if (DELIMITERS.has(c)) {
      this.pos++;
      return new Op(String.fromCharCode(c));
    }
    const word = this.regularRun();
    if (NUMBER.test(word)) return Number(word);
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return new Op(word);
  }

  private literalString(): Uint8Array {
    const b = this.bytes;
    const out: number[] = [];
    let depth = 1;
    this.pos++;
    while (this.pos < b.length) {
      const c = b[this.pos++]!;
      if (c === 0x5c) {
        const e = b[this.pos++];
        if (e === undefined) break;
        const simple: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 };
        if (simple[e] !== undefined) out.push(simple[e]);
        else if (e >= 0x30 && e <= 0x37) {
          let code = e - 0x30;
          for (let i = 0; i < 2 && b[this.pos]! >= 0x30 && b[this.pos]! <= 0x37; i++) code = code * 8 + (b[this.pos++]! - 0x30);
          out.push(code & 0xff);
        } else if (e === 13) {
          if (b[this.pos] === 10) this.pos++;
        } else if (e !== 10) out.push(e);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return Uint8Array.from(out);
  }

  private hexString(): Uint8Array {
    const b = this.bytes;
    this.pos++;
    let digits = '';
    while (this.pos < b.length && b[this.pos] !== 0x3e) {
      const ch = String.fromCharCode(b[this.pos++]!);
      if (/[0-9a-fA-F]/.test(ch)) digits += ch;
    }
    this.pos++;
    if (digits.length % 2 === 1) digits += '0';
    return Uint8Array.from(Buffer.from(digits, 'hex'));
  }

  /** One whole object, or the operator or closing bracket that stands in its place. */
  object(depth = 0): Token {
    if (depth > 100) throw new PdfError('objects nest too deeply');
    const token = this.token();
    if (token instanceof Op) {
      if (token.value === '[') {
        const items: Value[] = [];
        for (;;) {
          const item = this.object(depth + 1);
          if (item instanceof Op) {
            if (item.value === ']' || item === EOF) return items;
            continue;
          }
          items.push(item);
        }
      }
      if (token.value === '<<') {
        const dict = new Map<string, Value>();
        for (;;) {
          const key = this.object(depth + 1);
          if (key instanceof Op && (key.value === '>>' || key === EOF)) return dict;
          if (!(key instanceof Name)) continue;
          const value = this.object(depth + 1);
          if (value instanceof Op) {
            if (value.value === '>>' || value === EOF) return dict;
            continue;
          }
          dict.set(key.value, value);
        }
      }
      return token;
    }
    if (typeof token === 'number' && Number.isInteger(token) && token >= 0) {
      const save = this.pos;
      const gen = this.token();
      if (typeof gen === 'number' && Number.isInteger(gen)) {
        const r = this.token();
        if (r instanceof Op && r.value === 'R') return new Ref(token, gen);
      }
      this.pos = save;
    }
    return token;
  }

  atEnd(): boolean {
    this.skipSpace();
    return this.pos >= this.bytes.length;
  }
}

/** The most bytes one stream may inflate to, so a small file cannot unpack into gigabytes. */
export const MAX_STREAM_BYTES = 64 * 1024 * 1024;

function inflate(data: Uint8Array): Uint8Array {
  try {
    return inflateSync(data, { maxOutputLength: MAX_STREAM_BYTES, finishFlush: constants.Z_SYNC_FLUSH });
  } catch (error) {
    if (error instanceof RangeError || (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw new PdfError('a stream unpacks to more than 64 MB');
    throw new PdfError('a compressed stream is damaged');
  }
}

function asciiHex(data: Uint8Array): Uint8Array {
  const text = latin1(data);
  const end = text.indexOf('>');
  let digits = (end === -1 ? text : text.slice(0, end)).replace(/[^0-9a-fA-F]/g, '');
  if (digits.length % 2 === 1) digits += '0';
  return Uint8Array.from(Buffer.from(digits, 'hex'));
}

function ascii85(data: Uint8Array): Uint8Array {
  const text = latin1(data).replace(/^\s*<~/, '');
  const end = text.indexOf('~>');
  const body = (end === -1 ? text : text.slice(0, end)).replace(/\s/g, '');
  const out: number[] = [];
  let group: number[] = [];
  const flush = (count: number): void => {
    let value = 0;
    for (const digit of group) value = value * 85 + digit;
    for (let i = 3; i >= 4 - count; i--) out.push((value >>> (i * 8)) & 0xff);
  };
  for (const ch of body) {
    if (ch === 'z' && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      flush(4);
      group = [];
    }
  }
  if (group.length > 1) {
    const count = group.length - 1;
    while (group.length < 5) group.push(84);
    flush(count);
  }
  return Uint8Array.from(out);
}

/** Undoes the PNG row filters that `/Predictor` 10 and up add before Flate. */
function unpredict(data: Uint8Array, parms: Dict | undefined): Uint8Array {
  const predictor = numberOf(parms?.get('Predictor')) ?? 1;
  if (predictor < 10) return data;
  const colors = numberOf(parms?.get('Colors')) ?? 1;
  const bpc = numberOf(parms?.get('BitsPerComponent')) ?? 8;
  const columns = numberOf(parms?.get('Columns')) ?? 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLength = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowLength + 1));
  const out = new Uint8Array(rows * rowLength);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLength + 1)]!;
    const row = data.subarray(r * (rowLength + 1) + 1, (r + 1) * (rowLength + 1));
    const at = r * rowLength;
    for (let i = 0; i < rowLength; i++) {
      const left = i >= bpp ? out[at + i - bpp]! : 0;
      const up = r > 0 ? out[at - rowLength + i]! : 0;
      const upLeft = r > 0 && i >= bpp ? out[at - rowLength + i - bpp]! : 0;
      const x = row[i]!;
      let value = x;
      if (type === 1) value = x + left;
      else if (type === 2) value = x + up;
      else if (type === 3) value = x + ((left + up) >> 1);
      else if (type === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value = x + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      out[at + i] = value & 0xff;
    }
  }
  return out;
}

/** Filters that leave image bytes in a format of their own; decoding stops before them. */
export const IMAGE_FILTERS: ReadonlySet<string> = new Set(['DCTDecode', 'JPXDecode', 'CCITTFaxDecode', 'JBIG2Decode']);

export function filtersOf(stream: Stream): { readonly names: readonly string[]; readonly parms: readonly (Dict | undefined)[] } {
  const filter = stream.dict.get('Filter');
  const names = (filter instanceof Name ? [filter] : (arrayOf(filter) ?? [])).map((f) => nameOf(f) ?? '');
  const raw = stream.dict.get('DecodeParms');
  const list = arrayOf(raw) ?? [raw];
  return { names, parms: names.map((_, i) => (isDict(list[i]) ? list[i] : undefined)) };
}

/** A stream's bytes with every filter undone, up to the first image format filter. */
export function decodeStream(stream: Stream): { readonly bytes: Uint8Array; readonly imageFilter: string | undefined } {
  const { names, parms } = filtersOf(stream);
  let bytes = stream.raw;
  for (const [i, name] of names.entries()) {
    if (IMAGE_FILTERS.has(name)) return { bytes, imageFilter: name };
    if (name === 'FlateDecode' || name === 'Fl') bytes = unpredict(inflate(bytes), parms[i]);
    else if (name === 'ASCIIHexDecode' || name === 'AHx') bytes = asciiHex(bytes);
    else if (name === 'ASCII85Decode' || name === 'A85') bytes = ascii85(bytes);
    else throw new PdfError(`a stream uses the ${name} filter, which read does not decode`);
  }
  return { bytes, imageFilter: undefined };
}

/** PDF text strings: UTF-16BE behind a byte order mark, otherwise PDFDocEncoding, which is Latin-1 for text. */
export function textString(bytes: Uint8Array): string {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder().decode(bytes.subarray(3));
  return latin1(bytes);
}

