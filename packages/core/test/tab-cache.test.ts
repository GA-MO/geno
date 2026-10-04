import { describe, expect, it } from 'vitest';
import { classifyEdit, remainderAfter, TabCache } from '../src/tab/index.js';

describe('TabCache', () => {
  it('returns an exact hit with nothing typed', () => {
    const cache = new TabCache<string>();
    cache.put('const x = ', ';', 'compute()');
    expect(cache.find('const x = ', ';')).toEqual({ value: 'compute()', typed: '' });
  });

  it('reuses a result when the typing so far matches the start of its text', () => {
    const cache = new TabCache<string>();
    cache.put('const x = ', ';', 'compute()');
    const hit = cache.find('const x = comp', ';')!;
    expect(hit.typed).toBe('comp');
    expect(remainderAfter(hit.value, hit.typed)).toBe('ute()');
  });

  it('does not reuse when the typing diverged, the suffix changed, or the text is used up', () => {
    const cache = new TabCache<string>();
    cache.put('const x = ', ';', 'compute()');
    const diverged = cache.find('const x = zz', ';')!;
    expect(remainderAfter(diverged.value, diverged.typed)).toBeUndefined();
    expect(cache.find('const x = ', '; // changed')).toBeUndefined();
    expect(cache.find('const y = ', ';')).toBeUndefined();
    const used = cache.find('const x = compute()', ';')!;
    expect(remainderAfter(used.value, used.typed)).toBeUndefined();
  });

  it('prefers the newest matching entry and evicts the oldest past capacity', () => {
    const cache = new TabCache<string>(2);
    cache.put('a', '', 'old');
    cache.put('ab', '', 'new');
    expect(cache.find('abc', '')).toEqual({ value: 'new', typed: 'c' });
    cache.put('zz', '', 'third');
    expect(cache.find('a', '')).toBeUndefined();
  });

  it('holds an in-flight value that a later keystroke can wait on', async () => {
    const cache = new TabCache<Promise<string>>();
    let resolve!: (text: string) => void;
    cache.put('fn(', ')', new Promise((r) => (resolve = r)));
    const hit = cache.find('fn(a', ')')!;
    resolve('a, b');
    expect(remainderAfter(await hit.value, hit.typed)).toBe(', b');
    cache.delete(hit.value);
    expect(cache.find('fn(a', ')')).toBeUndefined();
  });
});

describe('classifyEdit', () => {
  const shown = { offset: 10, text: 'compute()' };

  it('keeps a completion alive while one typed character matches it', () => {
    expect(classifyEdit(shown, { offset: 10, removed: 0, inserted: 'c' })).toEqual({
      kind: 'pending',
      shown: { offset: 11, text: 'ompute()' },
    });
  });

  it('settles partial, typed-over, rejected, and leaves a full insert to the accept command', () => {
    const at = (inserted: string, offset = 10, removed = 0) => classifyEdit(shown, { offset, removed, inserted });
    expect(at('compute')).toEqual({ kind: 'settled', outcome: 'partial' });
    expect(at('x')).toEqual({ kind: 'settled', outcome: 'typed-over' });
    expect(at('c', 3)).toEqual({ kind: 'settled', outcome: 'rejected' });
    expect(at('', 9, 1)).toEqual({ kind: 'settled', outcome: 'rejected' });
    expect(at('compute()')).toEqual({ kind: 'inserted' });
  });
});
