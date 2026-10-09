import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { Parsed } from './ask-user.js';
import { formatBytes } from './attachments.js';

/**
 * show_files: the agent shows the user files in the chat, with a caption, as Claude Code's send-file tool does. The
 * logged result carries what was shown, so a reload or a session load draws the same card. The model gets a line per
 * file, never the bytes. The webview bundles this file, so it imports only types and the attachments helpers.
 */
export const SHOW_FILES_TOOL = 'show_files';

export const SHOW_LAYOUTS = ['grid', 'single'] as const;
export type ShowLayout = (typeof SHOW_LAYOUTS)[number];

export const SHOW_FILES_LIMITS = { files: 12, caption: 500, fileBytes: 15 * 1024 * 1024, callBytes: 60 * 1024 * 1024 } as const;

export type ShowFilesInput = { readonly files: readonly string[]; readonly caption?: string | undefined; readonly layout: ShowLayout };

/** How the panel draws a shown file: an image inline, or a card that opens it in the editor. */
export type ShownKind = 'image' | 'file';

export type ShownFile = { readonly kind: 'shown'; readonly given: string; readonly path: string; readonly name: string; readonly bytes: number; readonly show: ShownKind };
export type RefusedFile = { readonly kind: 'refused'; readonly given: string; readonly reason: string };
export type ShowEntry = ShownFile | RefusedFile;

/** One call's card: its caption and layout, and each file it named, shown or refused, in the order given. */
export type ShownFiles = { readonly caption?: string | undefined; readonly layout: ShowLayout; readonly files: readonly ShowEntry[] };

/** Key in a show_files call's tool_call_update `_meta`: a ShownFiles. */
export const SHOW_FILES_META = 'gcode/show-files';

// SVG and HTML can run script, so they open in the editor and are never drawn in the panel.
const INLINE_IMAGES: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

const extensionOf = (file: string): string => {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
};

export const shownKindOf = (file: string): ShownKind => (INLINE_IMAGES.has(extensionOf(file)) ? 'image' : 'file');

export const SHOW_FILES_SPEC: Tool = {
  name: SHOW_FILES_TOOL,
  description: `Show the user screenshots, charts, reports or other files in the chat, with a caption. Use it when seeing a file helps the user more than your words do: a screenshot of a page you changed, a before and after pair, a chart you made, a report. PNG, JPEG, GIF and WebP files show as images, side by side in a grid or one large with layout "single"; any other file, such as a PDF, Markdown, HTML, SVG or CSV file, shows as a card the user opens in the editor. You get back which files were shown, not their contents. Paths are relative to the workspace or absolute. Files in the workspace, the session's scratchpad and spill folder, and its subagents' lanes show without asking; another path asks the user, as read does. Credentials files are never shown. At most ${SHOW_FILES_LIMITS.files} files, each up to ${formatBytes(SHOW_FILES_LIMITS.fileBytes)}.`,
  input_schema: {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: SHOW_FILES_LIMITS.files, description: 'The files to show, in order, such as ["before.png", "after.png"].' },
      caption: { type: 'string', maxLength: SHOW_FILES_LIMITS.caption, description: 'One or two sentences the user reads above the files, such as "The login page before and after the fix."' },
      layout: { type: 'string', enum: [...SHOW_LAYOUTS], description: 'grid shows images side by side; single shows each one large. Defaults to grid.' },
    },
    required: ['files'],
    additionalProperties: false,
  },
};

/** The call's one line, as its step names it, live and replayed. */
export const showFilesTitle = ({ files }: Pick<ShowFilesInput, 'files'>): string => `${SHOW_FILES_TOOL} ${files.join(' ')}`;

const fail = (problem: string): Parsed<never> => ({ ok: false, problem });
const isRecord = (raw: unknown): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null && !Array.isArray(raw);
const isLayout = (raw: unknown): raw is ShowLayout => (SHOW_LAYOUTS as readonly unknown[]).includes(raw);

const INPUT_FIELDS = ['files', 'caption', 'layout'];

/** The model's input, or what is wrong with it in words it can act on. A path named twice is shown once. */
export function parseShowFilesInput(raw: unknown): Parsed<ShowFilesInput> {
  if (!isRecord(raw)) return fail(`${SHOW_FILES_TOOL} takes an object with files`);
  const extra = Object.keys(raw).find((key) => !INPUT_FIELDS.includes(key));
  if (extra !== undefined) return fail(`${SHOW_FILES_TOOL} has an unknown field "${extra}"`);
  const { files, caption, layout } = raw;
  if (!Array.isArray(files) || files.length === 0) return fail(`${SHOW_FILES_TOOL} needs files, a list of 1 to ${SHOW_FILES_LIMITS.files} paths`);
  if (files.some((file) => typeof file !== 'string' || file.trim() === '')) return fail('each entry of files must be a path');
  const unique = [...new Set((files as string[]).map((file) => file.trim()))];
  if (unique.length > SHOW_FILES_LIMITS.files) return fail(`files names ${unique.length} paths; show at most ${SHOW_FILES_LIMITS.files} at once`);
  if (caption !== undefined && caption !== null && typeof caption !== 'string') return fail('caption must be text');
  const line = typeof caption === 'string' ? caption.trim() : '';
  if (line.length > SHOW_FILES_LIMITS.caption) return fail(`caption is ${line.length} characters; keep it to ${SHOW_FILES_LIMITS.caption}`);
  if (layout !== undefined && layout !== null && !isLayout(layout)) return fail('layout is "grid" or "single"');
  return { ok: true, value: { files: unique, ...(line === '' ? {} : { caption: line }), layout: isLayout(layout) ? layout : 'grid' } };
}

function entryOf(raw: unknown): ShowEntry | undefined {
  if (!isRecord(raw) || typeof raw['given'] !== 'string') return undefined;
  if (raw['kind'] === 'refused') return typeof raw['reason'] === 'string' ? { kind: 'refused', given: raw['given'], reason: raw['reason'] } : undefined;
  const { path, name, bytes, show } = raw;
  if (raw['kind'] !== 'shown' || typeof path !== 'string' || !path.startsWith('/') || typeof name !== 'string' || typeof bytes !== 'number' || (show !== 'image' && show !== 'file')) return undefined;
  return { kind: 'shown', given: raw['given'], path, name, bytes, show };
}

/** A card as it crossed the process boundary, checked; undefined when it is not one. */
export function parseShownFiles(raw: unknown): ShownFiles | undefined {
  if (!isRecord(raw) || !isLayout(raw['layout']) || !Array.isArray(raw['files'])) return undefined;
  const files = raw['files'].map(entryOf);
  if (files.some((entry) => entry === undefined)) return undefined;
  const caption = typeof raw['caption'] === 'string' && raw['caption'] !== '' ? raw['caption'] : undefined;
  return { ...(caption === undefined ? {} : { caption }), layout: raw['layout'], files: files as ShowEntry[] };
}

export const shownOnly = (shown: ShownFiles): readonly ShownFile[] => shown.files.filter((entry): entry is ShownFile => entry.kind === 'shown');

const shownLine = (file: ShownFile): string => `- ${file.given} (${file.show === 'image' ? 'image' : 'file the user opens in the editor'}, ${formatBytes(file.bytes)})`;

/** What the model reads back: which files the user now sees, and which were refused and why. */
export function shownText(shown: ShownFiles): string {
  const files = shownOnly(shown);
  const refused = shown.files.filter((entry): entry is RefusedFile => entry.kind === 'refused');
  const head =
    files.length === 0
      ? 'Nothing was shown to the user.'
      : `Shown to the user in the chat${files.some((file) => file.show === 'image') ? `, ${shown.layout === 'single' ? 'one large image at a time' : 'images in a grid'}` : ''}${shown.caption === undefined ? '' : `, under the caption "${shown.caption}"`}:\n${files.map(shownLine).join('\n')}`;
  const tail = refused.length === 0 ? '' : `\nNot shown:\n${refused.map((entry) => `- ${entry.given}: ${entry.reason}`).join('\n')}`;
  return `${head}${tail}`;
}
