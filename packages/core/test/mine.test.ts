import { describe, expect, it } from 'vitest';
import {
  buildTriple,
  countLines,
  DEFAULT_MINE_LIMITS,
  screenCommit,
  screenContents,
  type ChangedFile,
  type CommitFacts,
} from '../src/index.js';

const file = (overrides: Partial<ChangedFile> = {}): ChangedFile => ({
  path: 'src/app.ts',
  status: 'modified',
  changedLines: 4,
  ...overrides,
});

const commit = (overrides: Partial<CommitFacts> = {}): CommitFacts => ({
  sha: 'a1b2c3d4e5f6',
  parent: 'f6e5d4c3b2a1',
  subject: 'Fix the off-by-one in pagination',
  body: '',
  files: [file()],
  ...overrides,
});

const limits = { ...DEFAULT_MINE_LIMITS, maxChangedLines: 40 };

const SLICES = true;

describe('screenCommit', () => {
  it('keeps a clean one-file commit as a whole-commit candidate', () => {
    expect(screenCommit(commit(), limits, SLICES)).toEqual({
      candidates: [{ scope: 'commit', parent: 'f6e5d4c3b2a1', file: file(), sliceIndex: 0 }],
      skipped: [],
    });
  });

  it('slices a two-file commit into one candidate per passing file, in path order', () => {
    const facts = commit({ files: [file({ path: 'src/z.ts' }), file({ path: 'src/a.ts' })] });
    expect(screenCommit(facts, limits, SLICES)).toEqual({
      candidates: [
        { scope: 'file-slice', parent: 'f6e5d4c3b2a1', file: file({ path: 'src/a.ts' }), sliceIndex: 0 },
        { scope: 'file-slice', parent: 'f6e5d4c3b2a1', file: file({ path: 'src/z.ts' }), sliceIndex: 1 },
      ],
      skipped: [],
    });
  });

  it('skips the failing file of a multi-file commit by its own reason and keeps the rest', () => {
    const facts = commit({ files: [file({ path: 'pnpm-lock.yaml' }), file({ path: 'src/app.ts' })] });
    expect(screenCommit(facts, limits, SLICES)).toEqual({
      candidates: [{ scope: 'file-slice', parent: 'f6e5d4c3b2a1', file: file(), sliceIndex: 1 }],
      skipped: ['lockfile'],
    });
  });

  it('skips a commit touching two files as multi-file when slicing is off', () => {
    const facts = commit({ files: [file(), file({ path: 'src/other.ts' })] });
    expect(screenCommit(facts, limits, !SLICES)).toEqual({ candidates: [], skipped: ['multi-file'] });
  });

  const reasonFor = (facts: CommitFacts) => {
    const { candidates, skipped } = screenCommit(facts, limits, SLICES);
    return candidates.length > 0 ? 'candidate' : skipped.join(',');
  };

  it.each(['pnpm-lock.yaml', 'web/package-lock.json', 'Cargo.lock', 'deps/custom.lock'])(
    'skips a lockfile change (%s)',
    (path) => {
      expect(reasonFor(commit({ files: [file({ path })] }))).toBe('lockfile');
    },
  );

  it('skips a 41-line diff at max 40 and keeps a 40-line one', () => {
    expect(reasonFor(commit({ files: [file({ changedLines: 41 })] }))).toBe('diff-too-large');
    expect(reasonFor(commit({ files: [file({ changedLines: 40 })] }))).toBe('candidate');
  });

  it('skips binary, generated, added, deleted, root, and short-subject commits', () => {
    expect(reasonFor(commit({ files: [] }))).toBe('no-files');
    expect(reasonFor(commit({ files: [file({ changedLines: 'binary' })] }))).toBe('binary');
    expect(reasonFor(commit({ files: [file({ path: 'dist/app.min.js' })] }))).toBe('generated');
    expect(reasonFor(commit({ files: [file({ status: 'added' })] }))).toBe('not-in-both');
    expect(reasonFor(commit({ files: [file({ status: 'deleted' })] }))).toBe('not-in-both');
    expect(reasonFor(commit({ parent: undefined }))).toBe('not-in-both');
    expect(reasonFor(commit({ subject: 'wip fix' }))).toBe('short-subject');
  });
});

describe('buildTriple', () => {
  const build = (facts: CommitFacts) => {
    const [candidate] = screenCommit(facts, limits, SLICES).candidates;
    return buildTriple({ repo: '/r/web', repoName: 'web', facts, candidate: candidate!, before: 'a', expected: 'b' });
  };

  it('ids a whole commit by short sha and uses the commit message as the instruction', () => {
    expect(build(commit({ body: 'More detail.' }))).toMatchObject({
      id: 'web-a1b2c3d',
      scope: 'commit',
      instruction: 'Fix the off-by-one in pagination\n\nMore detail.',
    });
  });

  it('ids a slice by its sorted path index and scopes the instruction to its path', () => {
    const facts = commit({ files: [file({ path: 'b.ts' }), file({ path: 'a.ts', changedLines: 'binary' })] });
    expect(build(facts)).toMatchObject({
      id: 'web-a1b2c3d-1',
      scope: 'file-slice',
      path: 'b.ts',
      instruction:
        'Fix the off-by-one in pagination\n\nApply only the part of this change that belongs in b.ts.',
    });
  });
});

describe('screenContents', () => {
  it('passes ordinary text and rejects files over the line limit', () => {
    expect(screenContents('a\n', 'b\n', limits)).toBeUndefined();
    const long = 'x\n'.repeat(2001);
    expect(screenContents('a\n', long, limits)).toBe('file-too-long');
    expect(screenContents('x\n'.repeat(2000), 'y\n', limits)).toBeUndefined();
  });

  it('rejects files marked as generated or containing NUL bytes', () => {
    expect(screenContents('a', '// @generated by protoc\nx', limits)).toBe('generated');
    expect(screenContents('a\0b', 'a', limits)).toBe('binary');
  });

  it('counts lines with and without a trailing newline', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb\n')).toBe(2);
  });
});
