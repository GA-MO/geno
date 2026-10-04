import { asTripleId, type ApplyTriple, type TripleId, type TripleScope } from './types.js';

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

export type Candidate = {
  readonly scope: TripleScope;
  readonly parent: string;
  readonly file: ChangedFile;
  readonly sliceIndex: number;
};

export type Screening = {
  readonly candidates: readonly Candidate[];
  readonly skipped: readonly SkipReason[];
};

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

type FileRule = (file: ChangedFile, facts: CommitFacts, limits: MineLimits) => boolean;

// Order matters: a file that fails several rules reports only the first.
const FILE_RULES: readonly (readonly [SkipReason, FileRule])[] = [
  ['binary', (file) => file.changedLines === 'binary'],
  ['lockfile', (file) => isLockfile(file.path)],
  ['generated', (file) => isGeneratedPath(file.path)],
  ['not-in-both', (file, facts) => file.status !== 'modified' || facts.parent === undefined],
  ['short-subject', (_, facts) => wordCount(facts.subject) < 3],
  [
    'diff-too-large',
    (file, _, limits) => file.changedLines !== 'binary' && file.changedLines > limits.maxChangedLines,
  ],
];

const failedRule = (file: ChangedFile, facts: CommitFacts, limits: MineLimits): SkipReason | undefined =>
  FILE_RULES.find(([, fails]) => fails(file, facts, limits))?.[0];

export function screenCommit(facts: CommitFacts, limits: MineLimits, slices: boolean): Screening {
  const files = [...facts.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (files.length === 0) return { candidates: [], skipped: ['no-files'] };
  if (files.length > 1 && !slices) return { candidates: [], skipped: ['multi-file'] };
  const scope: TripleScope = files.length === 1 ? 'commit' : 'file-slice';
  const candidates: Candidate[] = [];
  const skipped: SkipReason[] = [];
  files.forEach((file, sliceIndex) => {
    const reason = failedRule(file, facts, limits);
    if (reason !== undefined) skipped.push(reason);
    else if (facts.parent !== undefined) candidates.push({ scope, parent: facts.parent, file, sliceIndex });
  });
  return { candidates, skipped };
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

const shortSha = (sha: string) => sha.slice(0, 7);

const TRIPLE_IDS: Record<TripleScope, (repoName: string, sha: string, sliceIndex: number) => TripleId> = {
  commit: (repoName, sha) => asTripleId(`${repoName}-${shortSha(sha)}`),
  'file-slice': (repoName, sha, sliceIndex) => asTripleId(`${repoName}-${shortSha(sha)}-${sliceIndex}`),
};

export const instructionOf = (facts: Pick<CommitFacts, 'subject' | 'body'>): string => {
  const body = facts.body.trim();
  return body === '' ? facts.subject.trim() : `${facts.subject.trim()}\n\n${body}`;
};

const INSTRUCTIONS: Record<TripleScope, (message: string, path: string) => string> = {
  commit: (message) => message,
  'file-slice': (message, path) =>
    `${message}\n\nApply only the part of this change that belongs in ${path}.`,
};

export function buildTriple(input: {
  readonly repo: string;
  readonly repoName: string;
  readonly facts: CommitFacts;
  readonly candidate: Candidate;
  readonly before: string;
  readonly expected: string;
}): ApplyTriple {
  const { scope, file, sliceIndex } = input.candidate;
  return {
    id: TRIPLE_IDS[scope](input.repoName, input.facts.sha, sliceIndex),
    scope,
    repo: input.repo,
    commit: input.facts.sha,
    path: file.path,
    instruction: INSTRUCTIONS[scope](instructionOf(input.facts), file.path),
    before: input.before,
    expected: input.expected,
  };
}
