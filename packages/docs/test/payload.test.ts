import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import Sees from '../src/components/Mock.js';
import { runFiles, type PayloadResult, type PayloadView } from '../src/scenario/payload.js';
import type { PayloadSpec } from '../src/scenario/schema.js';
import { loadSite } from '../src/scenario/site.js';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(DOCS, '../..');
/** The answer that edits four files at once: thinking, then four tool_use edit blocks. */
const FOUR_EDITS = 'docs/results/real-usecases/runs/A07-multi-step-todo/fix-s1-1/session.jsonl#seq=25';
const REQUEST = 'docs/results/real-usecases/runs/A06-read-not-cat/1/requests.jsonl#seq=9';

const runs = runFiles(REPO);
const resolve = (spec: Omit<PayloadSpec, 'direction'>): PayloadResult => runs.resolve({ direction: 'response', ...spec });
const viewOf = (spec: Omit<PayloadSpec, 'direction'>): PayloadView => {
  const result = resolve(spec);
  if (!result.ok) throw new Error(result.reason);
  return result.view;
};
const lastMessage = (): PayloadView => {
  const result = runs.resolve({ direction: 'request', source: REQUEST, select: 'messages[-1]' });
  if (!result.ok) throw new Error(result.reason);
  return result.view;
};
const labels = (view: PayloadView) => view.blocks?.map((chip) => [chip.name === undefined ? chip.type : `${chip.type} ${chip.name}`, chip.at]);

describe('a payload card never shows less than a whole content block', () => {
  test("a select inside a tool_use block shows the block, keeps its type, id and name, and highlights the part", () => {
    const result = resolve({ source: FOUR_EDITS, select: 'content[1].input', highlight: ['path'] });
    if (!result.ok) throw new Error(result.reason);
    expect(result.view.value).toMatchObject({ type: 'tool_use', name: 'edit', id: expect.stringMatching(/^toolu_/), input: { path: expect.any(String) } });
    expect(result.view.highlight).toEqual(['input.path']);
    expect(result.cut).toBe('select content[1].input shows part of a tool_use block, which hides its type, id and name: select content[1] and highlight [input.path], or give cut: <why only this part> to show the part alone');
  });

  test('with no highlight of its own, the widened card highlights the part the select named', () => {
    expect(viewOf({ source: FOUR_EDITS, select: 'content[-1].input' }).highlight).toEqual(['input']);
  });

  test('a cut reason keeps the part alone, and a cut on a select that cuts nothing fails', () => {
    const part = resolve({ source: FOUR_EDITS, select: 'content[1].input', cut: 'the page compares two inputs side by side' });
    expect(part).toMatchObject({ ok: true, view: { value: { path: expect.any(String) } } });
    expect(part.ok && part.cut).toBeUndefined();
    expect(part.ok && part.view.blocks).toBeUndefined();
    expect(resolve({ source: FOUR_EDITS, select: 'content[1]', cut: 'the page compares two inputs side by side' })).toEqual({ ok: false, reason: expect.stringContaining('does not reach inside a content block') });
  });

  test('docs:check fails a page whose select cuts below a block', () => {
    const docs = mkdtempSync(path.join(tmpdir(), 'gdocs-'));
    cpSync(path.join(DOCS, 'src/data'), path.join(docs, 'src/data'), { recursive: true });
    mkdirSync(path.join(docs, 'src/content/docs/foundations'), { recursive: true });
    writeFileSync(
      path.join(docs, 'src/content/docs/foundations/page.mdx'),
      `---\ntitle: Page\npayloads:\n  whole: { direction: response, source: "${FOUR_EDITS}", select: "content[1]" }\n  part: { direction: response, source: "${FOUR_EDITS}", select: "content[1].input" }\n  why: { direction: response, source: "${FOUR_EDITS}", select: "content[1].input", cut: "the page compares two inputs" }\n---\n`,
    );
    const errors = loadSite({ docsRoot: docs, repoRoot: REPO }).problems.filter((problem) => problem.file === 'src/content/docs/foundations/page.mdx');
    expect(errors).toEqual([expect.objectContaining({ path: 'payloads.part.select', message: expect.stringContaining('select content[1] and highlight [input]') })]);
  });
});

describe('the chip row lists the blocks of the message, in order', () => {
  test('the four-edit answer reads as thinking and four tool_use edit blocks, each one a chip that finds its block', () => {
    expect(labels(viewOf({ source: FOUR_EDITS, select: 'content' }))).toEqual([
      ['thinking', '0'],
      ['tool_use edit', '1'],
      ['tool_use edit', '2'],
      ['tool_use edit', '3'],
      ['tool_use edit', '4'],
    ]);
    expect(labels(viewOf({ source: FOUR_EDITS }))).toEqual([['thinking', 'content.0'], ...[1, 2, 3, 4].map((i) => ['tool_use edit', `content.${i}`])]);
  });

  test('a card of one block still names the whole message, and only its own block is clickable', () => {
    expect(labels(viewOf({ source: FOUR_EDITS, select: 'content[2]' }))).toEqual([['thinking', undefined], ['tool_use edit', undefined], ['tool_use edit', ''], ['tool_use edit', undefined], ['tool_use edit', undefined]]);
  });

  test('a request message gets chips, and a card that is not one message gets none', () => {
    expect(labels(lastMessage())).toEqual([
      ['tool_result', 'content.0'],
      ['tool_result', 'content.1'],
      ['tool_result', 'content.2'],
    ]);
    const all = runs.resolve({ direction: 'request', source: REQUEST, select: 'messages' });
    expect(all.ok && all.view.blocks).toBeUndefined();
  });

  test('the card renders the chips above the JSON, each pointing at a block the JSON marks', () => {
    const html = renderToStaticMarkup(createElement(Sees, { shown: [viewOf({ source: FOUR_EDITS, select: 'content' })] }));
    const chips = [...html.matchAll(/<button type="button" class="mk-chip[^"]*">([^<]+)<\/button>/g)].map((match) => match[1]);
    expect(chips).toEqual(['thinking', 'tool_use edit', 'tool_use edit', 'tool_use edit', 'tool_use edit']);
    expect(html.indexOf('mk-chips')).toBeLessThan(html.indexOf('mk-json'));
    for (const at of ['0', '1', '2', '3', '4']) expect(html).toContain(`data-path="${at}"`);
  });
});

describe('the tool_use legend', () => {
  const legend = 'คือ tool ที่ model เลือกเรียก';
  const render = (view: PayloadView, shown?: boolean) => renderToStaticMarkup(createElement(Sees, { shown: [view], ...(shown === undefined ? {} : { legend: shown }) }));

  test('a card that shows a tool_use block explains name, input and id', () => {
    const html = render(viewOf({ source: FOUR_EDITS, select: 'content[1]' }));
    expect(html).toContain(legend);
    expect(html).toContain('ใช้จับคู่กับ');
  });

  test('a card with no tool_use block, or one told it is not the first, has none', () => {
    expect(render(lastMessage())).not.toContain(legend);
    expect(render(viewOf({ source: FOUR_EDITS, select: 'content[1]' }), false)).not.toContain(legend);
  });
});
