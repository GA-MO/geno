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

export type MineReport = {
  readonly repo: string;
  readonly scanned: number;
  readonly kept: readonly TripleId[];
  readonly skipped: ReadonlyMap<SkipReason, number>;
};

export async function mine(
  store: Store,
  repoDir: string,
  limit: number,
  limits: MineLimits,
): Promise<MineReport> {
  const repo = await repoRoot(repoDir);
  const repoName = path.basename(repo);
  const kept: TripleId[] = [];
  const skipped = new Map<SkipReason, number>();
  const skip = (reason: SkipReason) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  let scanned = 0;

  for (const header of await listCommits(repo)) {
    if (kept.length >= limit) break;
    scanned += 1;
    const facts = { ...header, files: await changedFiles(repo, header.sha) };
    const verdict = screenCommit(facts, limits);
    if (verdict.kind === 'skip') {
      skip(verdict.reason);
      continue;
    }
    const filePath = verdict.file.path;
    const [before, expected] = await Promise.all([
      fileAt(repo, verdict.parent, filePath),
      fileAt(repo, facts.sha, filePath),
    ]);
    const contentSkip = screenContents(before, expected, limits);
    if (contentSkip !== undefined) {
      skip(contentSkip);
      continue;
    }
    const triple = buildTriple({ repo, repoName, facts, path: filePath, before, expected });
    await writeTriple(store, triple);
    kept.push(triple.id);
  }
  return { repo, scanned, kept, skipped };
}
