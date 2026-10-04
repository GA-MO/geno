import { describe, expect, it } from 'vitest';
import { baseOf, hunksBetween, proposeChange, strReplace, type EditFormat } from '../src/index.js';

const file = ['function add(a, b) {', '  return a - b;', '}', '', 'function sub(a, b) {', '  return a - b;', '}', ''].join('\n');

describe('strReplace', () => {
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

  it('gives the count and start lines of several matches', () => {
    expect(strReplace('m.js', file, '  return a - b;', '  return 0;')).toEqual({
      kind: 'failed',
      reason: 'multiple-matches',
      detail:
        'old_str appears 2 times in m.js, starting at lines 2 and 6. Include more of the surrounding lines in old_str so it matches exactly one place.',
    });
  });

  it('counts several whitespace-normalized matches too', () => {
    const outcome = strReplace('m.js', file, 'return a - b;  ', '');
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'multiple-matches', detail: expect.stringContaining('lines 2 and 6') });
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

  it('refuses create over an existing file', () => {
    const { change, after } = propose('str_replace', { path: 'm.js', new_str: 'x', create: true }, file);
    expect(after).toBeNull();
    expect(change.result).toMatchObject({ kind: 'failed', reason: 'wrong-file' });
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
