import { deflateSync } from 'node:zlib';

export type PageSpec = { readonly text?: readonly string[]; readonly jpeg?: Uint8Array };

/**
 * A small valid PDF: Helvetica text lines per page, or a full-page JPEG. `objectStream` packs the page dictionaries
 * into a compressed object stream as PDF 1.5 writers do, and `catalog` adds raw entries such as an OpenAction.
 */
export function buildPdf(pages: readonly PageSpec[], options: { readonly objectStream?: boolean; readonly catalog?: string; readonly extra?: readonly string[] } = {}): Buffer {
  const objects: (string | { dict: string; data: Buffer })[] = [];
  const add = (body: string | { dict: string; data: Buffer }): number => objects.push(body);
  const catalog = add('');
  const tree = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  const packed: number[] = [];
  for (const page of pages) {
    const escape = (line: string): string => line.replace(/[\\()]/g, (c) => `\\${c}`);
    const ops = page.jpeg
      ? 'q 400 0 0 200 0 0 cm /Im1 Do Q'
      : `BT /F1 12 Tf 14 TL 72 720 Td ${(page.text ?? []).map((line) => `(${escape(line)}) Tj T*`).join(' ')} ET`;
    const content = add({ dict: '/Filter /FlateDecode', data: deflateSync(Buffer.from(ops, 'latin1')) });
    const image = page.jpeg ? add({ dict: '/Type /XObject /Subtype /Image /Width 400 /Height 200 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', data: Buffer.from(page.jpeg) }) : undefined;
    const resources = `<< /Font << /F1 ${font} 0 R >>${image ? ` /XObject << /Im1 ${image} 0 R >>` : ''} >>`;
    const pageObject = add(`<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] /Resources ${resources} /Contents ${content} 0 R >>`);
    kids.push(pageObject);
    if (options.objectStream) packed.push(pageObject);
  }
  for (const raw of options.extra ?? []) add(raw);
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R ${options.catalog ?? ''} >>`;
  objects[tree - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  if (packed.length > 0) {
    const bodies = packed.map((num) => objects[num - 1] as string);
    let offset = 0;
    const header = packed.map((num, i) => {
      const entry = `${num} ${offset}`;
      offset += bodies[i]!.length + 1;
      return entry;
    });
    const head = `${header.join(' ')}\n`;
    add({ dict: `/Type /ObjStm /N ${packed.length} /First ${head.length} /Filter /FlateDecode`, data: deflateSync(Buffer.from(head + bodies.join('\n'), 'latin1')) });
  }
  const chunks: Buffer[] = [Buffer.from('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let length = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    if (packed.includes(i + 1)) return;
    offsets[i] = length;
    const piece =
      typeof body === 'string'
        ? Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1')
        : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< ${body.dict} /Length ${body.data.length} >>\nstream\n`, 'latin1'), body.data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    chunks.push(piece);
    length += piece.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...objects.map((_, i) => (offsets[i] === undefined ? '0000000000 00000 f \n' : `${String(offsets[i]).padStart(10, '0')} 00000 n \n`))].join('');
  chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${length}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}
