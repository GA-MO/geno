import { asTripleId, type ApplyTriple } from './types.js';

export type FileStatus = 'added' | 'modified' | 'deleted' | 'other';

export type ChangedFile = {
  readonly path: string;
  readonly status: FileStatus;
  readonly changedLines: number | 'binary';
};

export type CommitFacts = {
  readonly sha: string;
  readonly parent: string | undefined;
  readonly subject: string;
  readonly body: string;
  readonly files: readonly ChangedFile[];
};

export type MineLimits = {
  readonly maxChangedLines: number;
  readonly maxFileLines: number;
};

export const DEFAULT_MINE_LIMITS: MineLimits = { maxChangedLines: 40, maxFileLines: 2000 };

export const SKIP_REASONS = [
  'no-files',
  'multi-file',
  'binary',
  'lockfile',
  'generated',
  'not-in-both',
  'short-subject',
  'diff-too-large',
  'file-too-long',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export type CommitVerdict =
  | { readonly kind: 'candidate'; readonly parent: string; readonly file: ChangedFile }
  | { readonly kind: 'skip'; readonly reason: SkipReason };

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'Pipfile.lock',
  'composer.lock',
  'go.sum',
  'flake.lock',
  'Package.resolved',
  'Podfile.lock',
  'uv.lock',
]);

const GENERATED_PATH = [
  /\.min\.(js|mjs|cjs|css)$/,
  /\.map$/,
  /(^|\/)(dist|build|out|vendor|node_modules|__generated__|generated)\//,
  /\.generated\.\w+$/,
  /\.pb\.go$/,
  /_pb2(_grpc)?\.py$/,
  /\.snap$/,
];

const GENERATED_MARKER = /@generated|DO NOT EDIT/;

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export const isLockfile = (path: string): boolean => {
  const name = basename(path);
  return LOCKFILES.has(name) || name.endsWith('.lock');
};

export const isGeneratedPath = (path: string): boolean =>
  GENERATED_PATH.some((pattern) => pattern.test(path));

export const countLines = (text: string): number =>
  text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

const wordCount = (text: string): number => text.split(/\s+/).filter(Boolean).length;

export function screenCommit(facts: CommitFacts, limits: MineLimits): CommitVerdict {
  const skip = (reason: SkipReason): CommitVerdict => ({ kind: 'skip', reason });
  const [file, ...others] = facts.files;
  if (file === undefined) return skip('no-files');
  if (others.length > 0) return skip('multi-file');
  if (file.changedLines === 'binary') return skip('binary');
  if (isLockfile(file.path)) return skip('lockfile');
  if (isGeneratedPath(file.path)) return skip('generated');
  if (file.status !== 'modified' || facts.parent === undefined) return skip('not-in-both');
  if (wordCount(facts.subject) < 3) return skip('short-subject');
  if (file.changedLines > limits.maxChangedLines) return skip('diff-too-large');
  return { kind: 'candidate', parent: facts.parent, file };
}

export function screenContents(
  before: string,
  expected: string,
  limits: MineLimits,
): SkipReason | undefined {
  if (before.includes('\0') || expected.includes('\0')) return 'binary';
  if (Math.max(countLines(before), countLines(expected)) > limits.maxFileLines) return 'file-too-long';
  const header = expected.split('\n', 5).join('\n');
  if (GENERATED_MARKER.test(header)) return 'generated';
  return undefined;
}

export const tripleId = (repoName: string, sha: string) => asTripleId(`${repoName}-${sha.slice(0, 7)}`);

export const instructionOf = (facts: Pick<CommitFacts, 'subject' | 'body'>): string => {
  const body = facts.body.trim();
  return body === '' ? facts.subject.trim() : `${facts.subject.trim()}\n\n${body}`;
};

export function buildTriple(input: {
  readonly repo: string;
  readonly repoName: string;
  readonly facts: CommitFacts;
  readonly path: string;
  readonly before: string;
  readonly expected: string;
}): ApplyTriple {
  return {
    id: tripleId(input.repoName, input.facts.sha),
    scope: 'commit',
    repo: input.repo,
    commit: input.facts.sha,
    path: input.path,
    instruction: instructionOf(input.facts),
    before: input.before,
    expected: input.expected,
  };
}
