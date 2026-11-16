import { afterEach, describe, expect, test, vi } from 'vitest';
import { codeUrl } from '../src/scenario/refs.js';

afterEach(() => vi.unstubAllEnvs());

describe('codeUrl', () => {
  test('opens the file in VS Code when the build names no source', () => {
    expect(codeUrl('/repo', 'packages/core/src/loop.ts', 12)).toBe('vscode://file/repo/packages/core/src/loop.ts:12');
    expect(codeUrl('/repo', 'docs/results/run/session.jsonl')).toBe('vscode://file/repo/docs/results/run/session.jsonl');
  });

  test('treats an empty DOCS_SOURCE_URL as unset', () => {
    vi.stubEnv('DOCS_SOURCE_URL', '');
    expect(codeUrl('/repo', 'a.ts', 1)).toBe('vscode://file/repo/a.ts:1');
  });

  test('links the published site to the commit on GitHub, with or without a trailing slash', () => {
    vi.stubEnv('DOCS_SOURCE_URL', 'https://github.com/GA-MO/geno/blob/abc123');
    expect(codeUrl('/home/runner/work/geno/geno', 'packages/core/src/loop.ts', 12)).toBe('https://github.com/GA-MO/geno/blob/abc123/packages/core/src/loop.ts#L12');
    expect(codeUrl('/x', 'docs/results/run/session.jsonl')).toBe('https://github.com/GA-MO/geno/blob/abc123/docs/results/run/session.jsonl');
    vi.stubEnv('DOCS_SOURCE_URL', 'https://github.com/GA-MO/geno/blob/abc123/');
    expect(codeUrl('/x', 'a.ts', 3)).toBe('https://github.com/GA-MO/geno/blob/abc123/a.ts#L3');
  });

  test('encodes a file name a URL cannot carry as is', () => {
    vi.stubEnv('DOCS_SOURCE_URL', 'https://github.com/GA-MO/geno/blob/abc123');
    expect(codeUrl('/x', 'docs/my notes/ไฟล์.md', 2)).toBe('https://github.com/GA-MO/geno/blob/abc123/docs/my%20notes/%E0%B9%84%E0%B8%9F%E0%B8%A5%E0%B9%8C.md#L2');
    expect(codeUrl('/x', 'docs/a#b?c.md')).toBe('https://github.com/GA-MO/geno/blob/abc123/docs/a%23b%3Fc.md');
  });
});
