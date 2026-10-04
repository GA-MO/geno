import path from 'node:path';
import {
  buildTriple,
  screenCommit,
  screenContents,
  type MineLimits,
  type SkipReason,
  type TripleId,
} from '@g-code/core';
import { changedFiles, fileAt, listCommits, repoRoot } from './git.js';
import { writeTriple, type Store } from './store.js';

export type MineOptions = {
  readonly limit: number;
  readonly limits: MineLimits;
  readonly slices: boolean;
};

export type MineReport = {
  readonly repo: string;
  readonly scanned: number;
  readonly kept: readonly TripleId[];
  readonly skipped: ReadonlyMap<SkipReason, number>;
};

export async function mine(store: Store, repoDir: string, options: MineOptions): Promise<MineReport> {
  const repo = await repoRoot(repoDir);
  const repoName = path.basename(repo);
  const kept: TripleId[] = [];
  const skipped = new Map<SkipReason, number>();
  const skip = (reason: SkipReason) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  let scanned = 0;

  for (const header of await listCommits(repo)) {
    if (kept.length >= options.limit) break;
    scanned += 1;
    const facts = { ...header, files: await changedFiles(repo, header.sha) };
    const screening = screenCommit(facts, options.limits, options.slices);
    screening.skipped.forEach(skip);
    for (const candidate of screening.candidates) {
      if (kept.length >= options.limit) break;
      const filePath = candidate.file.path;
      const [before, expected] = await Promise.all([
        fileAt(repo, candidate.parent, filePath),
        fileAt(repo, facts.sha, filePath),
      ]);
      const contentSkip = screenContents(before, expected, options.limits);
      if (contentSkip !== undefined) {
        skip(contentSkip);
        continue;
      }
      const triple = buildTriple({ repo, repoName, facts, candidate, before, expected });
      await writeTriple(store, triple);
      kept.push(triple.id);
    }
  }
  return { repo, scanned, kept, skipped };
}
