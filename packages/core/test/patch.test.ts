import { describe, expect, it } from 'vitest';
import { applyUpdate, baseOf, parsePatch, proposeChange, type PatchOp } from '../src/index.js';

const lines = (...rows: string[]) => rows.map((row) => `${row}\n`).join('');

const file = lines(
  'class Cart {',
  '  add(item) {',
  '    this.items.push(item);',
  '  }',
  '',
  '  total() {',
  '    return 0;',
  '  }',
  '}',
);

const ops = (patch: string): readonly PatchOp[] => {
  const parsed = parsePatch(patch);
  if (!parsed.ok) throw new Error(`line ${parsed.line}: ${parsed.message}`);
  return parsed.ops;
};

describe('parsePatch and applyUpdate', () => {
  it('applies an update whose chunks are placed by @@ anchors', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: cart.js',
      '@@ add(item) {',
      '-    this.items.push(item);',
      '+    this.items = [...this.items, item];',
      '@@ total() {',
      '-    return 0;',
      '+    return this.items.length;',
      '   }',
      '*** End Patch',
    ].join('\n');
    const [op] = ops(patch);
    expect(op).toMatchObject({ kind: 'update', path: 'cart.js' });
    if (op?.kind !== 'update') throw new Error('expected an update');
    expect(op.chunks.map((chunk) => chunk.anchor)).toEqual(['add(item) {', 'total() {']);
    expect(applyUpdate('cart.js', file, op.chunks)).toEqual({
      kind: 'applied',
      after: file.replace('this.items.push(item);', 'this.items = [...this.items, item];').replace('return 0;', 'return this.items.length;'),
    });
  });

  it('keeps the file text of context lines that matched only after trimming', () => {
    const patch = ['*** Begin Patch', '*** Update File: cart.js', '@@', ' total() {', '-return 0;', '+return 1;', '*** End Patch'].join('\n');
    const [op] = ops(patch);
    if (op?.kind !== 'update') throw new Error('expected an update');
    expect(applyUpdate('cart.js', file, op.chunks)).toEqual({ kind: 'applied', after: file.replace('    return 0;', 'return 1;') });
  });

  it('parses an added file', () => {
    expect(ops(['*** Begin Patch', '*** Add File: notes.md', '+# Notes', '+', '+first', '*** End Patch'].join('\n'))).toEqual([
      { kind: 'add', path: 'notes.md', content: '# Notes\n\nfirst\n' },
    ]);
  });

  it('parses a deleted file', () => {
    expect(ops('*** Begin Patch\n*** Delete File: old.js\n*** End Patch\n')).toEqual([{ kind: 'delete', path: 'old.js' }]);
  });

  it.each([
    ['a missing begin line', '*** Update File: a.js\n-x\n+y\n*** End Patch', 1, 'the patch must start with "*** Begin Patch"'],
    ['a missing end line', '*** Begin Patch\n*** Update File: a.js\n-x\n+y', 4, 'the patch must end with "*** End Patch"'],
    ['a line without a prefix', '*** Begin Patch\n*** Update File: a.js\n-x\n=y\n*** End Patch', 4, 'each line of an Update File section starts with a space, -, + or @@'],
    ['text before the first file header', '*** Begin Patch\n-x\n*** End Patch', 2, expect.stringContaining('expected "*** Update File: "')],
    ['an add line without +', '*** Begin Patch\n*** Add File: a.js\nx\n*** End Patch', 3, 'every line of an Add File section starts with +'],
  ])('rejects %s with the line', (_, patch, line, message) => {
    expect(parsePatch(patch)).toEqual({ ok: false, line, message });
  });

  it('names the chunk and the closest region when context is not found', () => {
    const [op] = ops(['*** Begin Patch', '*** Update File: cart.js', '@@', '   total() {', '-    return 1;', '+    return 2;', '*** End Patch'].join('\n'));
    if (op?.kind !== 'update') throw new Error('expected an update');
    expect(applyUpdate('cart.js', file, op.chunks)).toEqual({
      kind: 'failed',
      reason: 'zero-matches',
      detail: [
        'chunk 1: its context and - lines do not appear in cart.js after line 0.',
        'The closest text is lines 6-7:',
        '6\t  total() {',
        '7\t    return 0;',
        'Copy context and - lines exactly from the file, each after its one-character prefix.',
      ].join('\n'),
    });
  });

  it('reports a parse error with its line through the apply_patch format', () => {
    const { change } = proposeChange({
      format: 'apply_patch',
      raw: { patch: '*** Begin Patch\n*** Update File: cart.js\n-x' },
      path: 'cart.js',
      base: baseOf(file, null),
      current: file,
      turn: null,
    });
    expect(change.result).toEqual({ kind: 'failed', reason: 'parse-error', detail: 'patch line 3: the patch must end with "*** End Patch"' });
  });
});
