import { describe, expect, it } from 'vitest';
import { insertMention, mentionAtCaret, mentionsIn, rankFiles } from '../src/chat/mentions.js';

describe('composer mentions', () => {
  it('finds the mention being typed at the caret, and only after a space or the start', () => {
    expect(mentionAtCaret('explain @src/ma', 15)).toEqual({ start: 8, query: 'src/ma' });
    expect(mentionAtCaret('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionAtCaret('mail me@host', 12)).toBeUndefined();
    expect(mentionAtCaret('explain @src done', 17)).toBeUndefined();
  });

  it('replaces the typed mention with the chosen one and a space, quoting a path with spaces', () => {
    expect(insertMention('explain @ma please', 0 + 8, 11, 'src/math.ts')).toEqual({ text: 'explain @src/math.ts please', caret: 21 });
    expect(insertMention('@no', 0, 3, 'docs/my notes.md')).toEqual({ text: '@"docs/my notes.md" ', caret: 20 });
  });

  it('lists the mentions in a message once each, without trailing punctuation or email addresses', () => {
    expect(mentionsIn('Compare @a.ts with @"my b.ts", and @selection. Mail x@y.z about @a.ts')).toEqual(['a.ts', 'my b.ts', 'selection']);
  });

  it('ranks file names that start with the query first, then names, paths and letters in order', () => {
    const files = ['src/format.ts', 'docs/math-notes.md', 'src/math.ts', 'lib/mathematics/x.ts', 'src/my-ath.ts', 'readme.md'];
    expect(rankFiles(files, 'math', 10)).toEqual(['src/math.ts', 'docs/math-notes.md', 'lib/mathematics/x.ts', 'src/my-ath.ts']);
    expect(rankFiles(files, '', 2)).toEqual(['readme.md', 'src/math.ts']);
  });
});
