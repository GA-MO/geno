import { describe, expect, it } from 'vitest';
import {
  APPROVAL_MODES,
  parseShowWidget,
  SHOW_WIDGET_SPEC,
  WIDGET_LIMITS,
  WIDGET_PALETTE,
  WIDGET_TOOL,
  widgetDraftOf,
  widgetFileName,
  widgetToolDefinitions,
  asSha256,
} from '../src/index.js';

const problem = (raw: unknown): string => {
  const parsed = parseShowWidget(raw);
  if (parsed.ok) throw new Error(`expected a problem, parsed ${JSON.stringify(parsed.value)}`);
  return parsed.problem;
};

describe('the show_widget input', () => {
  it('takes a title, the html and up to four loading messages', () => {
    expect(parseShowWidget({ title: ' Speed ', html: '<p>hi</p>', loading_messages: [' Drawing bars ', 'Adding labels'] })).toEqual({
      ok: true,
      value: { title: 'Speed', html: '<p>hi</p>', loadingMessages: ['Drawing bars', 'Adding labels'] },
    });
    expect(parseShowWidget({ title: 'Speed', html: '<p>hi</p>' })).toEqual({ ok: true, value: { title: 'Speed', html: '<p>hi</p>', loadingMessages: [] } });
    expect(parseShowWidget({ title: 'Speed', html: '<p>hi</p>', loading_messages: null }), 'a model may send null for a field it leaves out').toEqual({
      ok: true,
      value: { title: 'Speed', html: '<p>hi</p>', loadingMessages: [] },
    });
  });

  it('says what is wrong in words the model can act on', () => {
    expect(problem('<p>')).toBe('show_widget takes an object with a title and html');
    expect(problem({ html: '<p>hi</p>' })).toBe('show_widget needs a title');
    expect(problem({ title: 'x'.repeat(WIDGET_LIMITS.title + 1), html: '<p>' })).toBe(`the title is longer than ${WIDGET_LIMITS.title} characters`);
    expect(problem({ title: 'Speed', html: '  ' })).toBe('show_widget needs the html of the widget');
    expect(problem({ title: 'Speed', html: 'x'.repeat(WIDGET_LIMITS.html + 1) })).toBe(`the html is longer than ${WIDGET_LIMITS.html} characters; draw a smaller widget`);
    expect(problem({ title: 'Speed', html: '<p>', loading_messages: ['a', 'b', 'c', 'd', 'e'] })).toBe(`loading_messages holds at most ${WIDGET_LIMITS.loadingMessages} short lines`);
    expect(problem({ title: 'Speed', html: '<p>', loading_messages: ['ok', 3] })).toBe('loading_messages must be short lines of text');
    expect(problem({ title: 'Speed', html: '<p>', loading_messages: ['x'.repeat(WIDGET_LIMITS.loadingMessage + 1)] })).toBe(
      `each loading message is at most ${WIDGET_LIMITS.loadingMessage} characters`,
    );
    expect(problem({ title: 'Speed', html: '<p>', width: 680 })).toBe('show_widget has an unknown field "width"');
  });

  it('declares the same limits in the schema the model reads', () => {
    const schema = SHOW_WIDGET_SPEC.input_schema as unknown as {
      properties: Record<string, { maxLength?: number; maxItems?: number; items?: { maxLength?: number } }>;
      required: string[];
      additionalProperties: boolean;
    };
    expect(SHOW_WIDGET_SPEC.name).toBe(WIDGET_TOOL);
    expect(Object.keys(schema.properties), 'title and loading messages come before the html, so they stream first').toEqual(['title', 'loading_messages', 'html']);
    expect(schema.required).toEqual(['title', 'html']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties['title']!.maxLength).toBe(WIDGET_LIMITS.title);
    expect(schema.properties['html']!.maxLength).toBe(WIDGET_LIMITS.html);
    expect(schema.properties['loading_messages']!.maxItems).toBe(WIDGET_LIMITS.loadingMessages);
    expect(schema.properties['loading_messages']!.items!.maxLength).toBe(WIDGET_LIMITS.loadingMessage);
  });

  it('tells the model to fill the width and use the theme variables and palette', () => {
    const prompt = SHOW_WIDGET_SPEC.description!;
    expect(prompt).toContain('width: 100%');
    expect(prompt).toMatch(/never a fixed pixel width/);
    for (const name of ['--bg', '--surface', '--fg', '--muted', '--border', '--accent', '--warn', '--danger', '--font', '--mono']) expect(prompt).toContain(name);
    for (let i = 1; i <= WIDGET_PALETTE.length; i++) expect(prompt).toContain(`--chart-${i}`);
    expect(prompt.indexOf('<style>')).toBeLessThan(prompt.indexOf('markup'));
    expect(prompt.indexOf('markup')).toBeLessThan(prompt.indexOf('<script>'));
  });
});

describe('when show_widget is offered', () => {
  it('in every interactive mode, Plan included, and never in a non-interactive run', () => {
    const offered = Object.fromEntries(APPROVAL_MODES.map((mode) => [mode, widgetToolDefinitions(mode, true).map((tool) => tool.name)]));
    expect(offered).toEqual({ plan: ['show_widget'], ask: ['show_widget'], auto: ['show_widget'], 'non-interactive': [] });
  });

  it('only to a client that draws widgets', () => {
    for (const mode of APPROVAL_MODES) expect(widgetToolDefinitions(mode, false)).toEqual([]);
  });
});

describe('a widget being written', () => {
  it('shows its title and loading messages as soon as they have streamed', () => {
    expect(widgetDraftOf('')).toEqual({ loadingMessages: [] });
    expect(widgetDraftOf('{"title": "Spe')).toEqual({ loadingMessages: [] });
    expect(widgetDraftOf('{"title": "Speed \\"chart\\"", "loading_messages": ["Drawing')).toEqual({ title: 'Speed "chart"', loadingMessages: [] });
    expect(widgetDraftOf('{"title": "Speed", "loading_messages": ["Drawing bars", "Adding')).toEqual({ title: 'Speed', loadingMessages: ['Drawing bars'] });
    expect(widgetDraftOf('{"title":"Speed","loading_messages":["Drawing bars","Adding labels"],"html":"<div>')).toEqual({
      title: 'Speed',
      loadingMessages: ['Drawing bars', 'Adding labels'],
    });
  });

  it('reads the fields only before the html starts, whatever the html says', () => {
    expect(widgetDraftOf('{"html":"<p>\\"title\\": \\"fake\\"</p>","title":"Real')).toEqual({ loadingMessages: [] });
  });
});

describe('the widget palette', () => {
  const luminance = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };

  it('has six colors that each stand out 3:1 on both dark and light glass', () => {
    expect(WIDGET_PALETTE).toHaveLength(6);
    for (const color of WIDGET_PALETTE) {
      expect(contrast(color, '#1e1e20'), `${color} on dark glass`).toBeGreaterThanOrEqual(3);
      expect(contrast(color, '#f5f5f5'), `${color} on light glass`).toBeGreaterThanOrEqual(3);
    }
  });
});

it('stores a widget by its hash, as an html file', () => {
  expect(widgetFileName(asSha256('a'.repeat(64)))).toBe(`${'a'.repeat(64)}.html`);
});
