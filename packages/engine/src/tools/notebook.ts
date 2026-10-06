import { z } from 'zod';
import type { Section, SectionPart } from './sections.js';

/** The most characters of one cell output that read shows; the rest is cut with a note. */
export const OUTPUT_MAX_CHARS = 4_000;

const multiline = z.union([z.string(), z.array(z.string())]).transform((value) => (typeof value === 'string' ? value : value.join('')));
const mimeBundle = z.record(z.string(), z.unknown());

const output = z.discriminatedUnion('output_type', [
  z.looseObject({ output_type: z.literal('stream'), name: z.string().optional(), text: multiline }),
  z.looseObject({ output_type: z.literal('execute_result'), data: mimeBundle }),
  z.looseObject({ output_type: z.literal('display_data'), data: mimeBundle }),
  z.looseObject({ output_type: z.literal('error'), ename: z.string(), evalue: z.string(), traceback: z.array(z.string()).optional() }),
]);
type Output = z.infer<typeof output>;

const notebookSchema = z.looseObject({
  metadata: z.looseObject({ language_info: z.looseObject({ name: z.string() }).optional(), kernelspec: z.looseObject({ language: z.string().optional() }).optional() }).optional(),
  cells: z.array(
    z.looseObject({
      cell_type: z.string(),
      source: multiline,
      execution_count: z.number().nullable().optional(),
      outputs: z.array(z.unknown()).optional(),
    }),
  ),
});

export type Notebook = { readonly language: string | undefined; readonly cells: readonly Section[] };

const WIDGET_VIEW = 'application/vnd.jupyter.widget-view+json';
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
const TEXT_TYPES = ['text/plain', 'text/markdown', 'text/latex', 'application/json', 'text/html', 'image/svg+xml'] as const;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

const capped = (text: string): string =>
  text.length <= OUTPUT_MAX_CHARS ? text : `${text.slice(0, OUTPUT_MAX_CHARS)}\n[output cut: it is ${text.length.toLocaleString('en-US')} characters; this shows the first ${OUTPUT_MAX_CHARS.toLocaleString('en-US')}]`;

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : Array.isArray(value) && value.every((v) => typeof v === 'string') ? value.join('') : value === undefined ? undefined : JSON.stringify(value, null, 1);

function outputParts(raw: unknown, number: number): SectionPart[] {
  const parsed = output.safeParse(raw);
  if (!parsed.success) return [{ kind: 'text', text: `[output ${number}: not a Jupyter output read understands]` }];
  const out: Output = parsed.data;
  if (out.output_type === 'stream') return [{ kind: 'text', text: `[output ${number}: ${out.name ?? 'stream'}]\n${capped(out.text.replace(ANSI, ''))}` }];
  if (out.output_type === 'error') {
    const trace = (out.traceback ?? []).join('\n').replace(ANSI, '');
    return [{ kind: 'text', text: `[output ${number}: error]\n${capped(trace === '' ? `${out.ename}: ${out.evalue}` : trace)}` }];
  }
  if (WIDGET_VIEW in out.data) return [];
  const image = IMAGE_TYPES.find((type) => typeof out.data[type] === 'string' || Array.isArray(out.data[type]));
  if (image !== undefined) {
    const base64 = asText(out.data[image])!.replace(/\s/g, '');
    return [{ kind: 'image', bytes: Uint8Array.from(Buffer.from(base64, 'base64')), label: `output ${number}: ${image}` }];
  }
  const type = TEXT_TYPES.find((t) => t in out.data);
  if (type === undefined) return [{ kind: 'text', text: `[output ${number}: ${Object.keys(out.data).join(', ') || 'empty'}, which read does not show]` }];
  return [{ kind: 'text', text: `[output ${number}: ${type}]\n${capped(asText(out.data[type]) ?? '')}` }];
}

/** A notebook's cells as read shows them. Cell and notebook metadata, widget state among it, is left out. */
export function parseNotebook(json: string): Notebook {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new NotebookError('is not valid JSON, so read cannot show it as a notebook; pass start_line to read it as text');
  }
  const parsed = notebookSchema.safeParse(data);
  if (!parsed.success) throw new NotebookError('is not a Jupyter notebook in nbformat 4; pass start_line to read it as text');
  const { metadata, cells } = parsed.data;
  return {
    language: metadata?.language_info?.name ?? metadata?.kernelspec?.language,
    cells: cells.map((cell, index) => {
      const count = cell.cell_type === 'code' && typeof cell.execution_count === 'number' ? ` [${cell.execution_count}]` : '';
      const parts: SectionPart[] = [{ kind: 'text', text: cell.source }];
      (cell.outputs ?? []).forEach((raw, i) => parts.push(...outputParts(raw, i + 1)));
      return { heading: `cell ${index + 1} of ${cells.length}: ${cell.cell_type}${count}`, parts };
    }),
  };
}

export class NotebookError extends Error {}
