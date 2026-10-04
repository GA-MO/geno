import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyEdit,
  buildNextEditPrompt,
  formatNextEditPrompt,
  markerOffsets,
  parseNextEdit,
  regionsAround,
  type CursorExcerpt,
  type EditableRegion,
  type EditHistoryEntry,
  type Snippet,
} from '../src/tab/index.js';

const fixture = (name: string) => readFileSync(new URL(`fixtures/zeta-2.1/${name}`, import.meta.url), 'utf8');
const samplePrompt = fixture('sample.prompt');
const sampleOutput = fixture('sample.output');

/** Takes the card's sample prompt apart into the inputs that produced it. */
function sampleInputs() {
  const afterPrefix = samplePrompt.slice(samplePrompt.indexOf('<[fim-prefix]>') + '<[fim-prefix]>'.length);
  const [relatedPart, rest] = afterPrefix.split('\n<filename>edit_history\n') as [string, string];
  const related: Snippet[] = relatedPart
    .split('<filename>')
    .slice(1)
    .map((block) => ({ path: block.slice(0, block.indexOf('\n')), text: block.slice(block.indexOf('\n') + 1) }));

  const historyEnd = rest.indexOf('\n<filename>');
  const diff = rest.slice(0, historyEnd).split('\n');
  const [, path] = /^--- a\/(.*)$/.exec(diff[0]!)!;
  const [, oldStart] = /^@@ -(\d+),/.exec(diff[2]!)!;
  const body = diff.slice(3).filter((l) => l !== '');
  const side = (keep: string) => body.filter((l) => l[0] === ' ' || l[0] === keep).map((l) => `${l.slice(1)}\n`).join('');
  const entry: EditHistoryEntry = { path: path!, at: '2026-01-01T00:00:00.000Z', line: Number(oldStart) - 1, oldText: side('-'), newText: side('+') };

  const cursorPart = rest.slice(historyEnd + '\n<filename>'.length, rest.indexOf('\n<[fim-middle]>'));
  const cursorPath = cursorPart.slice(0, cursorPart.indexOf('\n'));
  const marked = cursorPart.slice(cursorPath.length + 1);
  const plain = (s: string) => s.replaceAll(/<\|marker_\d+\|>|<\|user_cursor\|>/g, '');
  const excerpt: CursorExcerpt = {
    path: cursorPath,
    context: plain(marked),
    editable: { start: plain(marked.slice(0, marked.indexOf('<|marker_1|>'))).length, end: plain(marked).length },
    cursor: plain(marked.slice(0, marked.indexOf('<|user_cursor|>'))).length,
  };
  return { related, entry, excerpt };
}

describe('formatNextEditPrompt', () => {
  it("reproduces the model card's sample prompt byte for byte", () => {
    const { related, entry, excerpt } = sampleInputs();
    const { prompt } = formatNextEditPrompt(excerpt, [entry], related, 8192);
    expect(prompt).toBe(samplePrompt);
  });

  it('drops related files before history when the budget is tight', () => {
    const { related, entry, excerpt } = sampleInputs();
    const tight = formatNextEditPrompt(excerpt, [entry], related, 1500);
    expect(tight.history).toHaveLength(1);
    expect(tight.related.length).toBeLessThan(related.length);
    expect(tight.prompt).toContain('<filename>edit_history\n--- a/zed/crates/edit_prediction/src/edit_prediction.rs');
  });
});

describe('markerOffsets', () => {
  it('starts at 0, ends at the length, and splits after a blank line once a block has 6 lines', () => {
    const block = (name: string) => Array.from({ length: 7 }, (_, i) => `${name} ${i};`).join('\n');
    const text = `${block('a')}\n\n${block('b')}`;
    expect(markerOffsets(text)).toEqual([0, text.indexOf('b 0'), text.length]);
  });

  it('caps a block at 16 lines without a blank line, nudging past a closing brace', () => {
    const lines = Array.from({ length: 40 }, (_, i) => (i === 16 ? '}' : `x${i};`));
    const text = lines.join('\n');
    expect(markerOffsets(text).slice(0, 2)).toEqual([0, text.indexOf('x17;')]);
  });
});

describe('regionsAround', () => {
  it('keeps the whole of a small file editable', () => {
    const text = 'a\nb\nc\n';
    expect(regionsAround(text, 2, { editableTokens: 350, contextTokens: 150, maxTokens: 4096 })).toEqual({
      editable: { start: 0, end: text.length },
      context: { start: 0, end: text.length },
    });
  });

  it('centres the editable region on the cursor and puts context lines around it', () => {
    const text = Array.from({ length: 200 }, (_, i) => `line number ${String(i).padStart(3, '0')}`).join('\n');
    const cursor = text.indexOf('line number 100');
    const { editable, context } = regionsAround(text, cursor, { editableTokens: 70, contextTokens: 14, maxTokens: 4096 });
    const rows = (r: { start: number; end: number }) => text.slice(r.start, r.end).split('\n');
    expect(rows(editable)).toHaveLength(14);
    expect(rows(editable)).toContain('line number 100');
    expect(rows(context)).toHaveLength(16);
    expect(context.start).toBeLessThan(editable.start);
    expect(context.end).toBeGreaterThan(editable.end);
  });
});

describe('parseNextEdit', () => {
  const regionOf = (): EditableRegion => {
    const { excerpt } = sampleInputs();
    const start = 1000 + excerpt.editable.start;
    return { start, end: 1000 + excerpt.editable.end, text: excerpt.context.slice(excerpt.editable.start) };
  };

  it("reads the card's sample output as the smallest edit, in document offsets", () => {
    const region = regionOf();
    const edit = parseNextEdit(sampleOutput, region);
    expect(edit).toEqual({
      kind: 'edit',
      start: region.start + region.text.indexOf('Disk {') + 'Disk'.length,
      end: region.start + region.text.indexOf('Disk {') + 'Disk'.length,
      text: 'BasedDiagnosticsFinished',
    });
  });

  it('treats a repeated marker as no edit, and a reply without two markers as malformed', () => {
    const region = regionOf();
    expect(parseNextEdit('<|marker_2|><|marker_2|>', region)).toEqual({ kind: 'none', reason: 'unchanged' });
    expect(parseNextEdit('<|marker_1|>just text', region)).toEqual({ kind: 'none', reason: 'malformed' });
    expect(parseNextEdit('<|marker_1|>x<|marker_9|>', region)).toEqual({ kind: 'none', reason: 'malformed' });
  });

  it('reads a rewrite that spans several blocks, dropping the intermediate markers', () => {
    const text = `${Array.from({ length: 7 }, (_, i) => `a${i}`).join('\n')}\n\n${Array.from({ length: 7 }, (_, i) => `b${i}`).join('\n')}`;
    const region: EditableRegion = { start: 0, end: text.length, text };
    const [, second] = markerOffsets(text);
    const output = `<|marker_1|>${text.slice(0, second).replace('a6', 'A6')}<|marker_2|>${text.slice(second).replace('b0', 'B0')}<|marker_3|>`;
    const edit = parseNextEdit(output, region);
    expect(edit.kind === 'edit' && applyEdit(text, edit)).toBe(text.replace('a6', 'A6').replace('b0', 'B0'));
  });
});

describe('buildNextEditPrompt', () => {
  it('marks the cursor inside the editable region and records what the model saw', () => {
    const text = 'function add(a, b) {\n  return a + b;\n}\n';
    const cursor = text.indexOf('a + b');
    const history: EditHistoryEntry[] = [
      { path: 'src/math.js', at: '2026-01-01T00:00:00.000Z', line: 0, oldText: 'function add(a) {\n', newText: 'function add(a, b) {\n' },
    ];
    const built = buildNextEditPrompt(history, { path: 'src/math.js', text }, cursor, []);
    expect(built.prompt).toBe(
      '<[fim-suffix]>\n<[fim-prefix]>' +
        '<filename>edit_history\n--- a/src/math.js\n+++ b/src/math.js\n@@ -1,1 +1,1 @@\n-function add(a) {\n+function add(a, b) {\n\n' +
        '<filename>src/math.js\n<|marker_1|>function add(a, b) {\n  return <|user_cursor|>a + b;\n}\n<|marker_2|>\n<[fim-middle]>',
    );
    expect(built.inputs.region).toEqual({ start: 0, end: text.length, text });
    expect(built.inputs.history).toEqual(history);
  });
});
