import { describe, expect, it } from 'vitest';
import { baseOf, hunksBetween, proposeChange, strReplace, type EditFormat } from '../src/index.js';

const file = ['function add(a, b) {', '  return a - b;', '}', '', 'function sub(a, b) {', '  return a - b;', '}', ''].join('\n');

describe('strReplace', () => {
  it('P-05 says how to match a hidden character when the closest text holds one', () => {
    const hidden = 'export const config = {\n\tretries:​ 3,\n};\n';
    const outcome = strReplace('config.ts', hidden, '\tretries: 3,', '\tretries: 7,');
    expect(outcome.kind === 'failed' && outcome.detail).toContain('A [U+XXXX] there is a hidden character');
    const plain = strReplace('config.ts', hidden.replace('​', ''), '\tretries: 9,', 'x');
    expect(plain.kind === 'failed' && plain.detail).not.toContain('hidden character');
  });

  it('replaces an exact unique match', () => {
    expect(strReplace('m.js', file, 'add(a, b) {\n  return a - b;', 'add(a, b) {\n  return a + b;')).toEqual({
      kind: 'applied',
      after: file.replace('return a - b;', 'return a + b;'),
    });
  });

  it('falls back to a whitespace-normalized match and keeps the file indentation and line endings', () => {
    const crlf = 'if (x) {\r\n    run();\r\n    stop();\r\n}\r\n';
    const outcome = strReplace('m.js', crlf, '  run();  \n  stop();', '  run();\n  pause();\n  stop();');
    expect(outcome).toEqual({ kind: 'applied', after: 'if (x) {\r\n    run();\r\n    pause();\r\n    stop();\r\n}\r\n' });
  });

  it('names the closest region with line numbers when nothing matches', () => {
    const outcome = strReplace('m.js', file, 'function sub(a, b) {\n  return a + c;', 'x');
    expect(outcome).toEqual({
      kind: 'failed',
      reason: 'zero-matches',
      detail: [
        'old_str does not appear in m.js, even ignoring indentation and trailing whitespace. The closest text is lines 5-6:',
        '5\tfunction sub(a, b) {',
        '6\t  return a - b;',
        'Copy old_str exactly from the file, without the line numbers and the tab after them.',
      ].join('\n'),
    });
  });

  it('treats a resent edit whose result is already there as applied without changing the file', () => {
    const edited = file.replace('add(a, b) {\n  return a - b;', 'add(a, b) {\n  return a + b;');
    expect(strReplace('m.js', edited, 'add(a, b) {\n  return a - b;', 'add(a, b) {\n  return a + b;')).toEqual({
      kind: 'applied',
      after: edited,
    });
  });

  it('does not count a wrong edit as applied when its one-line result happens to be in the file', () => {
    const withReturn = file.replace('function sub(a, b) {\n  return a - b;', 'function sub(a, b) {\n  return 0;');
    const outcome = strReplace('m.js', withReturn, '  return a * b;', '  return 0;');
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'zero-matches' });
  });

  it('gives the count and start lines of several matches, and offers replace_all', () => {
    expect(strReplace('m.js', file, '  return a - b;', '  return 0;')).toEqual({
      kind: 'failed',
      reason: 'multiple-matches',
      detail:
        'old_str appears 2 times in m.js, starting at lines 2 and 6. Include more of the surrounding lines in old_str so it matches exactly one place, or pass replace_all: true to change every one.',
    });
  });

  it('counts several whitespace-normalized matches too, and says replace_all needs the exact text', () => {
    const outcome = strReplace('m.js', file, 'return a - b;  ', '');
    expect(outcome).toEqual({
      kind: 'failed',
      reason: 'multiple-matches',
      detail:
        'old_str appears 2 times in m.js when indentation and trailing whitespace are ignored, starting at lines 2 and 6. Include more of the surrounding lines in old_str so it matches exactly one place, or copy it exactly from the file and pass replace_all: true to change every one.',
    });
  });

  it('replaces every exact match with replace_all', () => {
    expect(strReplace('m.js', file, 'a - b', 'a * b', true)).toEqual({ kind: 'applied', after: file.replaceAll('a - b', 'a * b') });
    expect(strReplace('m.js', 'a = 1; a = 2;', 'a', '$&$1', true), 'new_str is literal text').toEqual({ kind: 'applied', after: '$&$1 = 1; $&$1 = 2;' });
  });

  it('replaces a single match with replace_all, and still forgives its indentation', () => {
    expect(strReplace('m.js', file, 'function add(a, b) {', 'function plus(a, b) {', true)).toEqual({ kind: 'applied', after: file.replace('add(', 'plus(') });
    expect(strReplace('m.js', file, ' function sub(a, b) {', 'function minus(a, b) {', true)).toEqual({ kind: 'applied', after: file.replace('sub(', 'minus(') });
  });
});

describe('proposeChange', () => {
  const propose = (format: EditFormat, raw: unknown, current: string | null, base = current) =>
    proposeChange({ format, raw, path: 'm.js', base: baseOf(base, null), current, turn: null });

  it('creates a new file with str_replace create', () => {
    const { change, after } = propose('str_replace', { path: 'm.js', new_str: 'hello\n', create: true }, null);
    expect(after).toBe('hello\n');
    expect(change.result).toEqual({ kind: 'applied' });
    expect(change.hunks).toEqual([{ startLine: 1, lineCount: 0, oldText: '', newText: 'hello\n', status: 'pending' }]);
  });

  it('overwrites a file whose base still matches with str_replace create', () => {
    const { change, after } = propose('str_replace', { path: 'm.js', new_str: 'x\n', create: true }, file);
    expect(after).toBe('x\n');
    expect(change.result).toEqual({ kind: 'applied' });
  });

  it('refuses create over a file that changed since it was read', () => {
    const { change, after } = propose('str_replace', { path: 'm.js', new_str: 'x\n', create: true }, `${file}// edited elsewhere\n`, file);
    expect(after).toBeNull();
    expect(change.result).toMatchObject({ kind: 'failed', reason: 'stale-base' });
  });

  it('passes replace_all through str_replace', () => {
    const { after } = propose('str_replace', { path: 'm.js', old_str: 'a - b', new_str: 'a * b', replace_all: true }, file);
    expect(after).toBe(file.replaceAll('a - b', 'a * b'));
  });

  it('reports a stale base and applies nothing when the file changed since it was read', () => {
    const raw = { path: 'm.js', old_str: 'a - b;\n}\n\nfunction sub', new_str: 'a + b;\n}\n\nfunction sub' };
    const { change, after } = propose('str_replace', raw, `${file}// edited elsewhere\n`, file);
    expect(after).toBeNull();
    expect(change.result).toEqual({
      kind: 'failed',
      reason: 'stale-base',
      detail: 'm.js changed since it was last read; read it again before editing',
    });
    expect(change.hunks).toEqual([]);
  });

  it('rejects an edit to another path', () => {
    const { change } = propose('whole_file', { path: 'other.js', content: '' }, file);
    expect(change.result).toEqual({ kind: 'failed', reason: 'wrong-file', detail: 'write_file can only change m.js, not other.js' });
  });
});

describe('hunksBetween', () => {
  it('gives one hunk per separate change, with ranges in the base', () => {
    const after = ['function add(a, b) {', '  return a + b;', '}', '', '// subtract', 'function sub(a, b) {', '  return a - b;', '}', ''].join('\n');
    expect(hunksBetween(file, after)).toEqual([
      { startLine: 2, lineCount: 1, oldText: '  return a - b;\n', newText: '  return a + b;\n', status: 'pending' },
      { startLine: 5, lineCount: 0, oldText: '', newText: '// subtract\n', status: 'pending' },
    ]);
  });
});
