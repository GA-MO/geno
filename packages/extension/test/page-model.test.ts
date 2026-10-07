import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Block, ToolBlock, Transcript, Turn } from '../src/chat/messages.js';
import { chooseName, imageFile, PAGES_FOLDER, pagesFolderOf, type Overwrite } from '../src/chat/page-files.js';
import { offersPage, pageDraft } from '../src/chat/page-model.js';

const tool = (id: string, extra: Partial<ToolBlock> = {}): ToolBlock => ({
  kind: 'tool',
  id,
  name: 'read',
  target: 'a.ts',
  toolKind: 'read',
  status: 'completed',
  startedAt: 0,
  endedAt: 1,
  output: 'file text',
  diff: undefined,
  ...extra,
});
const text = (id: string, value: string): Block => ({ kind: 'text', id, text: value });
const widget = (id: string, title: string, html: string): ToolBlock => tool(id, { name: 'show_widget', widget: { state: 'ready', title, sha256: 'ab', html } });

const turn = (blocks: readonly Block[], extra: Partial<Turn> = {}): Turn => ({ id: 't1', prompt: 'Why is the build slow?', blocks, status: 'done', startedAt: 0, endedAt: 1, usage: undefined, ...extra });
const of = (...turns: Turn[]): Transcript => ({ model: 'm', turns });

describe('the page of an answer', () => {
  it('is named for what the user asked, then shows the turn’s text and widgets in order, without its tool steps', () => {
    const answer = turn([text('a', 'Looking.'), tool('r1'), widget('w1', 'Bars', '<p>bars</p>'), text('b', '   '), text('c', '## Build time\n\nMostly types.')]);
    expect(pageDraft({ kind: 'answer', turnId: 't1', diagrams: [] }, of(answer))).toEqual({
      title: 'Why is the build slow?',
      parts: [
        { kind: 'markdown', text: 'Looking.' },
        { kind: 'widget', title: 'Bars', html: '<p>bars</p>' },
        { kind: 'markdown', text: '## Build time\n\nMostly types.' },
      ],
    });
  });

  it('shows a request longer than its first line under the title, and none for a turn Geno started by itself', () => {
    const long = turn([text('a', 'Types.')], { prompt: 'Why is the build slow?\nIt was fast last week.' });
    expect(pageDraft({ kind: 'answer', turnId: 't1', diagrams: [] }, of(long))?.parts[0]).toEqual({ kind: 'request', text: 'Why is the build slow?\nIt was fast last week.' });
    const woke = turn([text('a', '# Both passed\n\nGood.')], { prompt: '', wake: 'woke: 2 tasks finished' });
    expect(pageDraft({ kind: 'answer', turnId: 't1', diagrams: [] }, of(woke))).toEqual({ title: 'Both passed', parts: [{ kind: 'markdown', text: '# Both passed\n\nGood.' }] });
  });

  it('is nothing for an answer of only tool steps, or a turn the transcript no longer holds', () => {
    expect(pageDraft({ kind: 'answer', turnId: 't1', diagrams: [] }, of(turn([tool('r1')])))).toBeUndefined();
    expect(pageDraft({ kind: 'answer', turnId: 'gone', diagrams: [] }, of(turn([text('a', 'x')])))).toBeUndefined();
  });

  it('is offered once the turn ends with something to show', () => {
    expect(offersPage(turn([text('a', 'x')]))).toBe(true);
    expect(offersPage(turn([text('a', 'x')], { status: 'streaming' }))).toBe(false);
    expect(offersPage(turn([tool('r1')]))).toBe(false);
    expect(offersPage(turn([widget('w1', 'Bars', '')], { status: 'stopped' }))).toBe(true);
  });
});

describe('the page of a widget', () => {
  it('is the drawn widget alone, named for it', () => {
    const t = turn([widget('w1', 'Bars', '<p>bars</p>'), tool('w2', { widget: { state: 'drafting', title: 'Later', loading: [] } })]);
    expect(pageDraft({ kind: 'widget', toolId: 'w1' }, of(t))).toEqual({ title: 'Bars', parts: [{ kind: 'widget', title: 'Bars', html: '<p>bars</p>' }] });
    expect(pageDraft({ kind: 'widget', toolId: 'w2' }, of(t))).toBeUndefined();
  });
});

describe('where pages go', () => {
  it('is the setting’s folder inside the workspace, or geno-pages', () => {
    expect(pagesFolderOf(undefined)).toEqual([PAGES_FOLDER]);
    expect(pagesFolderOf('docs/pages/')).toEqual(['docs', 'pages']);
    expect(pagesFolderOf('./share')).toEqual(['share']);
    for (const outside of ['../elsewhere', 'a/../../b', '/tmp/pages', 'C:\\pages', '']) expect(pagesFolderOf(outside), outside).toEqual([PAGES_FOLDER]);
  });
});

describe('the name a page is saved under', () => {
  const folder = (...names: string[]) => (name: string) => Promise.resolve(names.includes(name));

  it('is the title’s name while it is free, and asks nothing', async () => {
    const asked: string[] = [];
    expect(await chooseName('a.html', folder('b.html'), async (name) => (asked.push(name), 'replace'))).toBe('a.html');
    expect(asked).toEqual([]);
  });

  it('replaces a taken name only when the user says so, and keeps both under the first free number', async () => {
    const taken = folder('a.html', 'a-2.html');
    const asked: [string, string][] = [];
    const answer = (choice: Overwrite) => async (name: string, beside: string) => (asked.push([name, beside]), choice);
    expect(await chooseName('a.html', taken, answer('replace'))).toBe('a.html');
    expect(await chooseName('a.html', taken, answer('keep-both'))).toBe('a-3.html');
    expect(await chooseName('a.html', taken, answer(undefined))).toBeUndefined();
    expect(asked).toEqual([['a.html', 'a-3.html'], ['a.html', 'a-3.html'], ['a.html', 'a-3.html']]);
  });
});

describe('the images a page inlines', () => {
  const root = path.resolve('/work/app');
  const other = path.resolve('/work/lib');

  it('are image files inside a workspace folder, by relative path, absolute path or file address', () => {
    expect(imageFile('shots/a%20b.png?x=1', [root, other])).toEqual({ file: path.join(root, 'shots/a b.png'), type: 'image/png' });
    expect(imageFile(path.join(other, 'logo.SVG'), [root, other])).toEqual({ file: path.join(other, 'logo.SVG'), type: 'image/svg+xml' });
    expect(imageFile(`file://${path.join(root, 'b.jpg')}`, [root])).toEqual({ file: path.join(root, 'b.jpg'), type: 'image/jpeg' });
  });

  it('are never a web image, a file outside the workspace, or a file that is not an image', () => {
    for (const href of ['https://example.com/a.png', '//cdn.example/a.png', 'data:image/png;base64,AA', '../secret.png', '/etc/a.png', 'notes.txt', 'file:///etc/a.png', '%E0%A4%A']) {
      expect(imageFile(href, [root]), href).toBeUndefined();
    }
    expect(imageFile('a.png', [])).toBeUndefined();
  });
});
