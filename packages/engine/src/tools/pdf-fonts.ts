import { arrayOf, decodeStream, isDict, latin1, Name, nameOf, numberOf, Op, Parser, Stream, type Dict, type Value } from './pdf-syntax.js';

/** What the text extractor needs from a font: how to split a string into codes, and each code's text and width. */
export type Font = {
  /** Codes and their byte lengths, in order. */
  readonly codes: (bytes: Uint8Array) => readonly { readonly code: number; readonly length: number }[];
  /** The code's text, or undefined when the font gives no way to know it. */
  readonly text: (code: number) => string | undefined;
  /** Advance in thousandths of an em. */
  readonly width: (code: number) => number;
};

export type Resolve = (value: Value | undefined) => Value | undefined;

type Range = { readonly length: number; readonly low: number; readonly high: number };

const utf16 = new TextDecoder('utf-16be');
const bigEndian = (bytes: Uint8Array): number => bytes.reduce((n, b) => n * 256 + b, 0);

/** A CMap stream's code space and its maps from codes to text (ToUnicode) or to CIDs (an embedded encoding). */
function parseCMap(bytes: Uint8Array): { readonly ranges: readonly Range[]; readonly unicode: Map<number, string>; readonly cids: Map<number, number> } {
  const parser = new Parser(bytes);
  const ranges: Range[] = [];
  const unicode = new Map<number, string>();
  const cids = new Map<number, number>();
  const operands: Value[] = [];
  const target = (value: Value | undefined): string | undefined =>
    value instanceof Uint8Array ? utf16.decode(value) : value instanceof Name ? glyphText(value.value) : undefined;
  let budget = 200_000;
  while (!parser.atEnd() && budget-- > 0) {
    const token = parser.object();
    if (!(token instanceof Op)) {
      operands.push(token);
      continue;
    }
    if (token.value === 'endcodespacerange') {
      for (let i = 0; i + 1 < operands.length; i += 2) {
        const low = operands[i];
        const high = operands[i + 1];
        if (low instanceof Uint8Array && high instanceof Uint8Array) ranges.push({ length: low.length, low: bigEndian(low), high: bigEndian(high) });
      }
    } else if (token.value === 'endbfchar') {
      for (let i = 0; i + 1 < operands.length; i += 2) {
        const src = operands[i];
        const text = target(operands[i + 1]);
        if (src instanceof Uint8Array && text !== undefined) unicode.set(bigEndian(src), text);
      }
    } else if (token.value === 'endbfrange') {
      for (let i = 0; i + 2 < operands.length; i += 3) {
        const low = operands[i];
        const high = operands[i + 1];
        const dst = operands[i + 2];
        if (!(low instanceof Uint8Array && high instanceof Uint8Array)) continue;
        const from = bigEndian(low);
        const to = Math.min(bigEndian(high), from + 65_535);
        const list = arrayOf(dst);
        for (let code = from; code <= to; code++) {
          if (list !== undefined) {
            const text = target(list[code - from]);
            if (text !== undefined) unicode.set(code, text);
          } else if (dst instanceof Uint8Array && dst.length > 0) {
            const next = Uint8Array.from(dst);
            let carry = code - from;
            for (let j = next.length - 1; j >= 0 && carry > 0; j--) {
              const sum = next[j]! + carry;
              next[j] = sum & 0xff;
              carry = sum >> 8;
            }
            unicode.set(code, utf16.decode(next));
          }
        }
      }
    } else if (token.value === 'endcidrange') {
      for (let i = 0; i + 2 < operands.length; i += 3) {
        const low = operands[i];
        const high = operands[i + 1];
        const cid = numberOf(operands[i + 2]);
        if (!(low instanceof Uint8Array && high instanceof Uint8Array) || cid === undefined) continue;
        const from = bigEndian(low);
        for (let code = from; code <= Math.min(bigEndian(high), from + 65_535); code++) cids.set(code, cid + code - from);
      }
    } else if (token.value === 'endcidchar') {
      for (let i = 0; i + 1 < operands.length; i += 2) {
        const src = operands[i];
        const cid = numberOf(operands[i + 1]);
        if (src instanceof Uint8Array && cid !== undefined) cids.set(bigEndian(src), cid);
      }
    }
    operands.length = 0;
  }
  return { ranges, unicode, cids };
}

function splitter(ranges: readonly Range[], fallback: number): Font['codes'] {
  return (bytes) => {
    const out: { code: number; length: number }[] = [];
    let at = 0;
    while (at < bytes.length) {
      let taken: { code: number; length: number } | undefined;
      for (const range of ranges) {
        if (at + range.length > bytes.length) continue;
        const code = bigEndian(bytes.subarray(at, at + range.length));
        if (code >= range.low && code <= range.high) {
          taken = { code, length: range.length };
          break;
        }
      }
      const length = taken?.length ?? Math.min(fallback, bytes.length - at);
      out.push(taken ?? { code: bigEndian(bytes.subarray(at, at + length)), length });
      at += length;
    }
    return out;
  };
}

const ACCENTS: Record<string, string> = {
  acute: '́',
  grave: '̀',
  circumflex: '̂',
  dieresis: '̈',
  tilde: '̃',
  ring: '̊',
  cedilla: '̧',
  caron: '̌',
  macron: '̄',
  breve: '̆',
  ogonek: '̨',
  dotaccent: '̇',
  hungarumlaut: '̋',
};

const GLYPHS: Record<string, string> = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'",
  parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[',
  backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|',
  braceright: '}', asciitilde: '~', quoteleft: '‘', quoteright: '’', quotedblleft: '“',
  quotedblright: '”', quotesinglbase: '‚', quotedblbase: '„', endash: '–', emdash: '—',
  bullet: '•', ellipsis: '…', dagger: '†', daggerdbl: '‡', trademark: '™', fi: 'fi',
  fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', germandbls: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ',
  OE: 'Œ', oslash: 'ø', Oslash: 'Ø', thorn: 'þ', Thorn: 'Þ', eth: 'ð', Eth: 'Ð',
  dotlessi: 'ı', lslash: 'ł', Lslash: 'Ł', sterling: '£', yen: '¥', Euro: '€',
  cent: '¢', section: '§', paragraph: '¶', copyright: '©', registered: '®',
  degree: '°', plusminus: '±', multiply: '×', divide: '÷', mu: 'µ', minus: '−',
  ordfeminine: 'ª', ordmasculine: 'º', guillemotleft: '«', guillemotright: '»',
  guilsinglleft: '‹', guilsinglright: '›', exclamdown: '¡', questiondown: '¿',
  periodcentered: '·', onehalf: '½', onequarter: '¼', threequarters: '¾', perthousand: '‰',
  florin: 'ƒ', nbspace: ' ', sfthyphen: '­', logicalnot: '¬', brokenbar: '¦',
};

/** A glyph name's text, by the Adobe Glyph List conventions for the names real fonts use. */
export function glyphText(name: string): string | undefined {
  const base = name.split('.')[0]!.split('_');
  const parts = base.map((part) => {
    if (GLYPHS[part] !== undefined) return GLYPHS[part];
    if (/^[A-Za-z]$/.test(part)) return part;
    const uni = /^uni((?:[0-9A-F]{4})+)$/.exec(part);
    if (uni) return uni[1]!.match(/.{4}/g)!.map((hex) => String.fromCharCode(parseInt(hex, 16))).join('');
    const u = /^u([0-9A-F]{4,6})$/.exec(part);
    if (u) return String.fromCodePoint(parseInt(u[1]!, 16));
    const accented = /^([A-Za-z])(acute|grave|circumflex|dieresis|tilde|ring|cedilla|caron|macron|breve|ogonek|dotaccent|hungarumlaut)$/.exec(part);
    if (accented) return (accented[1]! + ACCENTS[accented[2]!]!).normalize('NFC');
    return undefined;
  });
  return parts.every((p) => p !== undefined) ? parts.join('') : undefined;
}

const WIN_ANSI_HIGH = '€�‚ƒ„…†‡ˆ‰Š‹Œ�Ž��‘’“”•–—˜™š›œ�žŸ';
const MAC_ROMAN_HIGH = new TextDecoder('macintosh').decode(Uint8Array.from({ length: 128 }, (_, i) => 0x80 + i));

function baseEncoding(name: string | undefined, code: number): string | undefined {
  if (code < 0x20) return undefined;
  if (code < 0x7f) {
    if (name === 'StandardEncoding' || name === undefined) {
      if (code === 0x27) return '’';
      if (code === 0x60) return '‘';
    }
    return String.fromCharCode(code);
  }
  if (name === 'MacRomanEncoding') return code >= 0x80 ? MAC_ROMAN_HIGH[code - 0x80] : undefined;
  if (code >= 0x80 && code < 0xa0) return WIN_ANSI_HIGH[code - 0x80];
  // A soft hyphen that a PDF draws is a hyphen the reader sees.
  return code === 0xad ? '-' : String.fromCharCode(code);
}

function simpleWidths(dict: Dict, resolve: Resolve): (code: number) => number {
  const first = numberOf(resolve(dict.get('FirstChar'))) ?? 0;
  const widths = arrayOf(resolve(dict.get('Widths'))) ?? [];
  const matrix = arrayOf(resolve(dict.get('FontMatrix')));
  const scale = nameOf(dict.get('Subtype')) === 'Type3' && matrix !== undefined ? (numberOf(matrix[0]) ?? 0.001) * 1000 : 1;
  const descriptor = resolve(dict.get('FontDescriptor'));
  const missing = numberOf(isDict(descriptor) ? resolve(descriptor.get('MissingWidth')) : undefined);
  return (code) => {
    const w = numberOf(resolve(widths[code - first]));
    return w === undefined ? (missing ?? 500) : w * scale;
  };
}

function cidWidths(dict: Dict, resolve: Resolve): (cid: number) => number {
  const fallback = numberOf(resolve(dict.get('DW'))) ?? 1000;
  const table = new Map<number, number>();
  const list = arrayOf(resolve(dict.get('W'))) ?? [];
  for (let i = 0; i < list.length; ) {
    const first = numberOf(resolve(list[i]));
    const next = resolve(list[i + 1]);
    if (first === undefined) break;
    const each = arrayOf(next);
    if (each !== undefined) {
      each.forEach((w, j) => table.set(first + j, numberOf(resolve(w)) ?? fallback));
      i += 2;
    } else {
      const last = numberOf(next) ?? first;
      const w = numberOf(resolve(list[i + 2])) ?? fallback;
      for (let cid = first; cid <= Math.min(last, first + 65_535); cid++) table.set(cid, w);
      i += 3;
    }
  }
  return (cid) => table.get(cid) ?? fallback;
}

function toUnicode(dict: Dict, resolve: Resolve): ReturnType<typeof parseCMap> | undefined {
  const stream = resolve(dict.get('ToUnicode'));
  if (!(stream instanceof Stream)) return undefined;
  try {
    return parseCMap(decodeStream(stream).bytes);
  } catch {
    return undefined;
  }
}

/** The encoding an embedded Type 1 font carries in its clear-text part, which applies when the PDF names none. */
function type1Encoding(dict: Dict, resolve: Resolve): Map<number, string> | undefined {
  const descriptor = resolve(dict.get('FontDescriptor'));
  const file = isDict(descriptor) ? resolve(descriptor.get('FontFile')) : undefined;
  if (!(file instanceof Stream)) return undefined;
  const bytes = decodeStream(file).bytes;
  const clear = latin1(bytes.subarray(0, numberOf(resolve(file.dict.get('Length1'))) ?? bytes.length));
  const map = new Map<number, string>();
  for (const match of clear.matchAll(/dup\s+(\d+)\s*\/([^\s/]+)\s+put/g)) map.set(Number(match[1]), match[2]!);
  return map.size > 0 ? map : undefined;
}

export function loadFont(dict: Dict, resolve: Resolve): Font {
  const unicode = toUnicode(dict, resolve);
  if (nameOf(dict.get('Subtype')) === 'Type0') {
    const descendants = arrayOf(resolve(dict.get('DescendantFonts')));
    const descendant = resolve(descendants?.[0]);
    const width = isDict(descendant) ? cidWidths(descendant, resolve) : () => 1000;
    const encoding = resolve(dict.get('Encoding'));
    const embedded = encoding instanceof Stream ? parseCMap(decodeStream(encoding).bytes) : undefined;
    const ranges = embedded?.ranges.length ? embedded.ranges : unicode?.ranges.length ? unicode.ranges : [{ length: 2, low: 0, high: 0xffff }];
    const cid = (code: number): number => embedded?.cids.get(code) ?? code;
    return { codes: splitter(ranges, 2), text: (code) => unicode?.unicode.get(code), width: (code) => width(cid(code)) };
  }
  const encoding = resolve(dict.get('Encoding'));
  const differences = new Map<number, string>();
  let base = nameOf(encoding);
  if (isDict(encoding)) {
    base = nameOf(encoding.get('BaseEncoding'));
    let code = 0;
    for (const item of arrayOf(resolve(encoding.get('Differences'))) ?? []) {
      if (typeof item === 'number') code = item;
      else if (item instanceof Name) differences.set(code++, item.value);
    }
  }
  const width = simpleWidths(dict, resolve);
  const builtIn = base === undefined ? type1Encoding(dict, resolve) : undefined;
  const text = (code: number): string | undefined => {
    const mapped = unicode?.unicode.get(code);
    if (mapped !== undefined) return mapped;
    const glyph = differences.get(code) ?? builtIn?.get(code);
    if (glyph !== undefined) return glyphText(glyph);
    return baseEncoding(base, code);
  };
  return { codes: (bytes) => Array.from(bytes, (code) => ({ code, length: 1 })), text, width };
}
