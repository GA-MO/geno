import type * as acp from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { WIDGET_DRAFT_META, WIDGET_META } from '@g-code/core';
import { shownSteps } from '../src/chat/fold.js';
import type { ToolBlock, ToolStatus, ToolWidget, Turn } from '../src/chat/messages.js';
import { railOf } from '../src/chat/rail.js';
import { emptyTranscript, reduce } from '../src/chat/transcript.js';
import { widgetOf } from '../src/chat/widget-model.js';
import { widgetTheme } from '@g-code/core/widget-frame';
import { workOf } from '../src/chat/working.js';

const REF = { sha256: 'a'.repeat(64), title: 'Speed', bytes: 12 };
const HTML = '<p>speed</p>';

const draft = (meta: unknown): acp.SessionUpdate => ({ sessionUpdate: 'tool_call', toolCallId: 'w', title: 'show_widget Speed', kind: 'other', status: 'pending', _meta: { [WIDGET_DRAFT_META]: meta } });
const result = (content: acp.ToolCallContent[]): acp.SessionUpdate => ({ sessionUpdate: 'tool_call_update', toolCallId: 'w', status: 'completed', content, _meta: { [WIDGET_META]: REF } });
const resource = (text: string, mimeType = 'text/html'): acp.ToolCallContent => ({ type: 'content', content: { type: 'resource', resource: { uri: 'file:///x.html', mimeType, text } } });

describe('a widget from its updates', () => {
  it('drafts with the loading lines that have streamed', () => {
    expect(widgetOf(draft({ title: 'Speed', loadingMessages: ['Laying out bars'] }))).toEqual({ state: 'drafting', title: 'Speed', loading: ['Laying out bars'] });
    expect(widgetOf(draft({ loadingMessages: [] }))).toEqual({ state: 'drafting', title: undefined, loading: [] });
  });

  it('is ready with the html the result carries, and missing without it', () => {
    expect(widgetOf(result([{ type: 'content', content: { type: 'text', text: 'Shown' } }, resource(HTML)]))).toEqual({ state: 'ready', title: 'Speed', sha256: REF.sha256, html: HTML });
    expect(widgetOf(result([{ type: 'content', content: { type: 'text', text: 'Shown' } }]))).toEqual({ state: 'missing', title: 'Speed' });
    expect(widgetOf(result([resource(HTML, 'text/plain')]))).toEqual({ state: 'missing', title: 'Speed' });
  });

  it('ignores updates that are not about a widget, and malformed meta', () => {
    expect(widgetOf({ sessionUpdate: 'tool_call', toolCallId: 'r', title: 'read a.ts', kind: 'read', status: 'in_progress' })).toBeUndefined();
    expect(widgetOf(draft({ loadingMessages: 'no' }))).toBeUndefined();
    expect(widgetOf({ ...result([resource(HTML)]), _meta: { [WIDGET_META]: { title: 3 } } })).toBeUndefined();
  });
});

const turnWith = (tool: { readonly widget: ToolWidget; readonly status?: ToolStatus }, status: Turn['status'] = 'done', mode = 'ask'): Turn => {
  let t = reduce(emptyTranscript('m'), { type: 'turn-start', id: 't1', at: 0, prompt: 'show me', mode });
  t = reduce(t, { type: 'text', text: 'Here it is.' });
  t = reduce(t, { type: 'tool', id: 'w', at: 1, name: 'show_widget', target: 'Speed', toolKind: 'other', status: 'running', ...tool });
  t = reduce(t, { type: 'text', text: 'The thinking phase is largest.' });
  if (status !== 'streaming') t = reduce(t, { type: 'turn-end', at: 9, status, usage: undefined });
  return t.turns[0]!;
};

describe('a widget on the rail', () => {
  const ready = { state: 'ready', title: 'Speed', sha256: REF.sha256, html: HTML } as const;

  it('is a step of its own', () => {
    const steps = railOf(turnWith({ widget: ready, status: 'completed' }));
    expect(steps.map((s) => s.kind)).toEqual(['text', 'widget', 'text']);
  });

  it('stays in view when a compact turn folds its work', () => {
    const steps = shownSteps(turnWith({ widget: ready, status: 'completed' }), 'compact', false);
    expect(steps.map((s) => s.kind)).toEqual(['fold', 'widget', 'text']);
  });

  it('keeps its widget when a later update of the call carries none', () => {
    let t = reduce(emptyTranscript('m'), { type: 'turn-start', id: 't1', at: 0, prompt: 'p' });
    t = reduce(t, { type: 'tool', id: 'w', at: 1, name: 'show_widget', status: 'running', widget: ready });
    const before = t.turns[0]!.blocks[0] as ToolBlock;
    t = reduce(t, { type: 'tool', id: 'w', at: 2, status: 'completed' });
    expect((t.turns[0]!.blocks[0] as ToolBlock).widget).toBe(before.widget);
  });

  it('puts the working dino in its writing pose while the model writes it', () => {
    expect(workOf(turnWith({ widget: { state: 'drafting', title: 'Speed', loading: [] } }, 'streaming')).kind).toBe('write');
  });
});

describe('the widget theme', () => {
  it('reads each widget variable from the panel, and the series colors from the palette when the panel names none', () => {
    const panel: Record<string, string> = { '--widget-fg': 'rgb(220, 220, 220)', '--widget-bg': 'rgb(30, 30, 32)', '--widget-font': '"Segoe UI", sans-serif' };
    const theme = widgetTheme((name) => panel[name], 'dark');
    expect(theme.scheme).toBe('dark');
    expect(theme.vars['--fg']).toBe('rgb(220, 220, 220)');
    expect(theme.vars['--font']).toBe('"Segoe UI", sans-serif');
    expect(theme.vars['--chart-1']).toBe('#3987e5');
    expect(theme.vars['--chart-6']).toBe('#8a7ee0');
    expect(theme.vars['--muted']).toBeUndefined();
  });
});
