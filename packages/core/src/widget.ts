import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ApprovalMode } from './approval.js';
import type { Parsed } from './ask-user.js';
import type { Sha256 } from './attachments.js';

/**
 * `show_widget`: an HTML, CSS and JS fragment the model writes, drawn inline in the chat in a sandboxed frame. It
 * changes nothing on disk, so every interactive mode offers it; a run with nobody watching never sees it.
 */
export const WIDGET_TOOL = 'show_widget';

/** The tool's input, parsed. */
export type ShowWidgetInput = { readonly title: string; readonly html: string; readonly loadingMessages: readonly string[] };

/**
 * What the session log keeps of a widget: the fragment is stored once by its hash in the session's attachments
 * folder, and the tool result names it, so a loaded session draws it again.
 */
export type WidgetRef = { readonly sha256: Sha256; readonly title: string; readonly bytes: number };

/** A widget the model is still writing: what of its input has streamed in, before the html. */
export type WidgetDraft = { readonly title?: string; readonly loadingMessages: readonly string[] };

/** Key in a tool_call_update's `_meta`: the WidgetRef of the widget its content carries. */
export const WIDGET_META = 'gcode/widget';
/** Key in a tool_call's `_meta` while the model writes the widget: its WidgetDraft. */
export const WIDGET_DRAFT_META = 'gcode/widget-draft';
/** Key in the client's capabilities `_meta`: true when it draws widgets. */
export const WIDGET_CAPABILITY = 'gcode/widgets';

export const WIDGET_LIMITS = { title: 80, html: 200_000, loadingMessages: 4, loadingMessage: 60 } as const;

export const widgetFileName = (sha256: Sha256): string => `${sha256}.html`;

/**
 * The series colors, in the order a chart assigns them. Each stands out at least 3:1 on both dark glass (#1e1e20)
 * and light glass (#f5f5f5), and adjacent pairs stay apart under color blindness, so one palette reads in both.
 */
export const WIDGET_PALETTE = ['#3987e5', '#d95926', '#199e70', '#b97a00', '#d55181', '#8a7ee0'] as const;

/** The CSS variables a widget gets from the panel's theme, with what each is for. */
export const WIDGET_VARIABLES = {
  '--bg': 'the chat background',
  '--surface': 'a raised panel or card',
  '--fg': 'text',
  '--muted': 'secondary text, axes and grid lines',
  '--border': 'borders and dividers',
  '--accent': 'the one highlight: a selected item, a primary button',
  '--warn': 'a warning',
  '--danger': 'an error',
  '--font': 'the font family',
  '--mono': 'the monospace font family, for code',
} as const;
export type WidgetVariable = keyof typeof WIDGET_VARIABLES | `--chart-${1 | 2 | 3 | 4 | 5 | 6}`;

const PROMPT = [
  'Draw a widget inline in the chat: an HTML fragment with CSS and JavaScript that the user sees and can use at once, such as a chart, a diagram, a UI mockup or an interactive explainer. Use it when a picture or a live demo says more than prose. It changes nothing on disk.',
  'Rules for html:',
  '- A fragment only, with no <html>, <head> or <body>. Write it in this order: one <style>, then the markup, then one <script> last.',
  '- The widget fills the width of the chat, which the user can resize. Size containers with width: 100% (or max-width: 100%) and flexible layouts; never a fixed pixel width on a container. The widget sets its own height.',
  `- Colors come only from these CSS variables, which follow the user's light or dark theme: ${Object.entries(WIDGET_VARIABLES)
    .slice(0, 8)
    .map(([name, use]) => `${name} (${use})`)
    .join(', ')}. For data series use ${WIDGET_PALETTE.map((_, i) => `--chart-${i + 1}`).join(', ')}, in that order; text and labels use --fg or --muted, never a series color. Never write a color literal. In a canvas, read a variable with getComputedStyle(document.documentElement).getPropertyValue('--chart-1').`,
  '- Fonts: font-family: var(--font), and var(--mono) for code. Font size at least 11px; weights 400 and 500 only.',
  '- Flat and clean: no gradients, no shadows, rounded corners 8 to 12px. No position: fixed.',
  '- Nothing loads from the network: no CDN, no images or fonts by URL, no fetch. Draw with HTML, CSS, SVG or canvas. Storage, popups, forms and the page around the widget are blocked.',
  '- Attach event handlers in the script with addEventListener. A link opens only after the user approves it.',
  'loading_messages: up to 4 short lines the chat shows while you write the widget, such as "Laying out the axes".',
].join('\n');

export const SHOW_WIDGET_SPEC: Tool = {
  name: WIDGET_TOOL,
  description: PROMPT,
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: WIDGET_LIMITS.title, description: 'What the widget shows, in a few words, such as "Where a run spends its time".' },
      loading_messages: {
        type: 'array',
        maxItems: WIDGET_LIMITS.loadingMessages,
        items: { type: 'string', maxLength: WIDGET_LIMITS.loadingMessage },
        description: 'Short lines shown while you write the widget.',
      },
      html: { type: 'string', maxLength: WIDGET_LIMITS.html, description: 'The fragment: one <style>, then the markup, then one <script>.' },
    },
    required: ['title', 'html'],
    additionalProperties: false,
  },
};

/** The modes that offer the tool: all of them with a person at the editor to see it. */
export const WIDGET_TOOL_MODES: Readonly<Record<ApprovalMode, boolean>> = { plan: true, ask: true, auto: true, 'non-interactive': false };

/** The widget tool when the mode offers it and the client draws widgets. */
export const widgetToolDefinitions = (mode: ApprovalMode, drawn: boolean): readonly Tool[] => (drawn && WIDGET_TOOL_MODES[mode] ? [SHOW_WIDGET_SPEC] : []);

const fail = (problem: string): Parsed<never> => ({ ok: false, problem });
const isRecord = (raw: unknown): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null && !Array.isArray(raw);

/** The model's input as a widget, or what is wrong with it, in words the model can act on. */
export function parseShowWidget(raw: unknown): Parsed<ShowWidgetInput> {
  if (!isRecord(raw)) return fail('show_widget takes an object with a title and html');
  const extra = Object.keys(raw).find((key) => !['title', 'html', 'loading_messages'].includes(key));
  if (extra !== undefined) return fail(`show_widget has an unknown field "${extra}"`);
  const { title, html, loading_messages: messages } = raw;
  if (typeof title !== 'string' || title.trim() === '') return fail('show_widget needs a title');
  if (title.trim().length > WIDGET_LIMITS.title) return fail(`the title is longer than ${WIDGET_LIMITS.title} characters`);
  if (typeof html !== 'string' || html.trim() === '') return fail('show_widget needs the html of the widget');
  if (html.length > WIDGET_LIMITS.html) return fail(`the html is longer than ${WIDGET_LIMITS.html} characters; draw a smaller widget`);
  const lines = messages ?? [];
  if (!Array.isArray(lines)) return fail('loading_messages must be short lines of text');
  if (lines.length > WIDGET_LIMITS.loadingMessages) return fail(`loading_messages holds at most ${WIDGET_LIMITS.loadingMessages} short lines`);
  if (!lines.every((line): line is string => typeof line === 'string')) return fail('loading_messages must be short lines of text');
  if (lines.some((line) => line.trim().length > WIDGET_LIMITS.loadingMessage)) return fail(`each loading message is at most ${WIDGET_LIMITS.loadingMessage} characters`);
  return { ok: true, value: { title: title.trim(), html, loadingMessages: lines.map((line) => line.trim()).filter((line) => line !== '') } };
}

const WHITESPACE = /\s/;
const skip = (json: string, i: number): number => {
  while (i < json.length && WHITESPACE.test(json[i]!)) i++;
  return i;
};

/** The JSON string starting at `i`, or undefined while its closing quote has not streamed in. */
function stringAt(json: string, i: number): { readonly value: string; readonly end: number } | undefined {
  if (json[i] !== '"') return undefined;
  for (let j = i + 1; j < json.length; j++) {
    if (json[j] === '\\') j++;
    else if (json[j] === '"') return { value: JSON.parse(json.slice(i, j + 1)) as string, end: j + 1 };
  }
  return undefined;
}

/**
 * What a partial show_widget input says so far: its title and the loading messages that have closed. Only the fields
 * before `html` are read, so the fragment itself can never pose as one; a field after it is not seen until the call runs.
 */
export function widgetDraftOf(json: string): WidgetDraft {
  let title: string | undefined;
  const loadingMessages: string[] = [];
  const draft = (): WidgetDraft => ({ ...(title === undefined ? {} : { title: title.slice(0, WIDGET_LIMITS.title) }), loadingMessages: loadingMessages.slice(0, WIDGET_LIMITS.loadingMessages) });
  let i = skip(json, 0);
  if (json[i] !== '{') return draft();
  i++;
  for (;;) {
    i = skip(json, i);
    if (json[i] === ',') i = skip(json, i + 1);
    const key = stringAt(json, i);
    if (key === undefined) return draft();
    i = skip(json, key.end);
    if (json[i] !== ':') return draft();
    i = skip(json, i + 1);
    if (key.value === 'title') {
      const value = stringAt(json, i);
      if (value === undefined) return draft();
      title = value.value.trim();
      i = value.end;
    } else if (key.value === 'loading_messages' && json[i] === '[') {
      i++;
      for (;;) {
        i = skip(json, i);
        if (json[i] === ',') i = skip(json, i + 1);
        if (json[i] === ']') break;
        const value = stringAt(json, i);
        if (value === undefined) return draft();
        if (value.value.trim() !== '') loadingMessages.push(value.value.trim().slice(0, WIDGET_LIMITS.loadingMessage));
        i = value.end;
      }
      i++;
    } else return draft();
  }
}
