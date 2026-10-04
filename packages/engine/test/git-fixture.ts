import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type FixtureCommit = {
  readonly message: string;
  readonly files: Readonly<Record<string, string>>;
};

export function makeRepo(name: string, commits: readonly FixtureCommit[]): string {
  const repo = path.join(mkdtempSync(path.join(tmpdir(), 'gcode-repo-')), name);
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', ...args], {
      stdio: 'pipe',
    });
  git('init', '-q', '-b', 'main');
  for (const commit of commits) {
    for (const [file, text] of Object.entries(commit.files)) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      writeFileSync(path.join(repo, file), text);
    }
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', commit.message);
  }
  return repo;
}
