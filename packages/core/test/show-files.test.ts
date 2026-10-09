import { describe, expect, it } from 'vitest';
import { hintOf, parseShowFilesInput, parseShownFiles, SHOW_FILES_SPEC, shownKindOf, shownText, type ShownFiles } from '../src/index.js';

describe('show_files input', () => {
  it('takes 1 to 12 paths, a trimmed caption and a layout that defaults to grid, and shows a path named twice once', () => {
    expect(parseShowFilesInput({ files: ['a.png', ' b.png ', 'a.png'], caption: '  Before and after  ' })).toEqual({ ok: true, value: { files: ['a.png', 'b.png'], caption: 'Before and after', layout: 'grid' } });
    expect(parseShowFilesInput({ files: ['a.png'], layout: 'single', caption: null })).toEqual({ ok: true, value: { files: ['a.png'], layout: 'single' } });
  });

  it.each([
    [{}, 'show_files needs files, a list of 1 to 12 paths'],
    [{ files: [] }, 'show_files needs files, a list of 1 to 12 paths'],
    [{ files: [''] }, 'each entry of files must be a path'],
    [{ files: Array.from({ length: 13 }, (_, i) => `${i}.png`) }, 'files names 13 paths; show at most 12 at once'],
    [{ files: ['a.png'], layout: 'carousel' }, 'layout is "grid" or "single"'],
    [{ files: ['a.png'], caption: 'x'.repeat(501) }, 'caption is 501 characters; keep it to 500'],
    [{ files: ['a.png'], path: 'a.png' }, 'show_files has an unknown field "path"'],
  ])('refuses %j with words the model can act on', (raw, problem) => {
    expect(parseShowFilesInput(raw)).toEqual({ ok: false, problem });
  });
});

describe('what show_files draws', () => {
  it('draws PNG, JPEG, GIF and WebP inline, and opens SVG, HTML, PDF and anything else in the editor', () => {
    expect(['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.webp'].map(shownKindOf)).toEqual(['image', 'image', 'image', 'image', 'image']);
    expect(['chart.svg', 'report.html', 'report.pdf', 'notes.md', 'data.csv', 'Makefile', '.png'].map(shownKindOf)).toEqual(['file', 'file', 'file', 'file', 'file', 'file', 'file']);
  });

  it('lists the deferred tool by a hint that fits the roster line', () => {
    expect(hintOf(SHOW_FILES_SPEC.description)).toBe('Show the user screenshots, charts, reports or other files in the chat, with a caption.');
  });
});

const CARD: ShownFiles = {
  caption: 'The page before and after',
  layout: 'grid',
  files: [
    { kind: 'shown', given: 'before.png', path: '/w/before.png', name: 'before.png', bytes: 2048, show: 'image' },
    { kind: 'shown', given: 'report.pdf', path: '/w/report.pdf', name: 'report.pdf', bytes: 3 * 1024 * 1024, show: 'file' },
    { kind: 'refused', given: '.env', reason: '.env is off limits to show_files' },
  ],
};

describe('the result the model reads', () => {
  it('names each file shown, how, and each one refused with why, and never their contents', () => {
    expect(shownText(CARD)).toBe(
      [
        'Shown to the user in the chat, images in a grid, under the caption "The page before and after":',
        '- before.png (image, 2 KB)',
        '- report.pdf (file the user opens in the editor, 3.0 MB)',
        'Not shown:',
        '- .env: .env is off limits to show_files',
      ].join('\n'),
    );
    expect(shownText({ layout: 'single', files: [CARD.files[2]!] })).toBe('Nothing was shown to the user.\nNot shown:\n- .env: .env is off limits to show_files');
  });
});

describe('a card across the process boundary', () => {
  it('reads back what it was sent, and nothing that is not a card', () => {
    expect(parseShownFiles(JSON.parse(JSON.stringify(CARD)))).toEqual(CARD);
    expect(parseShownFiles({ layout: 'grid', files: [{ kind: 'shown', given: 'a.png', path: 'a.png', name: 'a.png', bytes: 1, show: 'image' }] })).toBeUndefined();
    expect(parseShownFiles({ layout: 'wall', files: [] })).toBeUndefined();
    expect(parseShownFiles(undefined)).toBeUndefined();
  });
});
