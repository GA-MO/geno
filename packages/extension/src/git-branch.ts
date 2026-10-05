import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** The branch HEAD names, or the short commit of a detached HEAD. */
export function branchOfHead(head: string): string | undefined {
  const text = head.trim();
  const ref = /^ref: refs\/heads\/(.+)$/.exec(text);
  if (ref !== null) return ref[1];
  return /^[0-9a-f]{40,64}$/.test(text) ? text.slice(0, 7) : undefined;
}

/** The checked-out branch of the repository at `folder`, also in a worktree, whose `.git` is a file naming its git dir. */
export async function currentBranch(folder: string): Promise<string | undefined> {
  const dotGit = path.join(folder, '.git');
  try {
    const gitDir = (await stat(dotGit)).isDirectory()
      ? dotGit
      : path.resolve(folder, /^gitdir: (.+)$/m.exec(await readFile(dotGit, 'utf8'))?.[1]?.trim() ?? '.git');
    return branchOfHead(await readFile(path.join(gitDir, 'HEAD'), 'utf8'));
  } catch {
    return undefined;
  }
}
