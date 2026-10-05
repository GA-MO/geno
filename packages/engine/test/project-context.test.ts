import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProjectContext, parseFrontmatter, triggerOf } from '../src/project-context.js';

async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-context-')));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return root;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });

describe('instruction files', () => {
  it('walks from the workspace to the root, root first, one file per directory', async () => {
    const root = await tree({
      'AGENTS.md': 'top',
      'mid/CLAUDE.md': 'mid claude',
      'mid/ws/AGENTS.md': 'workspace agents',
      'mid/ws/CLAUDE.md': 'workspace claude, not loaded beside AGENTS.md',
      'mid/ws/sub/AGENTS.md': 'below the workspace, not loaded',
    });
    const { instructions } = await loadProjectContext(path.join(root, 'mid', 'ws'));
    expect(instructions).toEqual([
      { path: path.join(root, 'AGENTS.md'), text: 'top' },
      { path: path.join(root, 'mid', 'CLAUDE.md'), text: 'mid claude' },
      { path: 'AGENTS.md', text: 'workspace agents' },
    ]);
  });

  it('prefers AGENTS.override.md, then AGENTS.md, then CLAUDE.md, and skips a directory of that name', async () => {
    const root = await tree({ 'AGENTS.override.md': 'override', 'AGENTS.md': 'agents', 'CLAUDE.md': 'claude', 'b/CLAUDE.md': 'claude b', 'b/AGENTS.md/x': '' });
    expect((await loadProjectContext(root)).instructions).toEqual([{ path: 'AGENTS.override.md', text: 'override' }]);
    expect((await loadProjectContext(path.join(root, 'b'))).instructions).toEqual([
      { path: path.join(root, 'AGENTS.override.md'), text: 'override' },
      { path: 'CLAUDE.md', text: 'claude b' },
    ]);
  });

  it('loads a file reached twice through a symlinked directory once', async () => {
    const root = await tree({ 'real/AGENTS.md': 'once' });
    await symlink(path.join(root, 'real', 'AGENTS.md'), path.join(root, 'AGENTS.md'));
    expect((await loadProjectContext(path.join(root, 'real'))).instructions).toEqual([{ path: 'AGENTS.md', text: 'once' }]);
  });

  it("lets a nested worktree's file shadow the main repository's, and inherits it when the worktree has none", async () => {
    const root = await tree({ 'repo/AGENTS.md': 'main copy', 'repo/.gitignore': 'trees/\n' });
    const repo = path.join(root, 'repo');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'start');
    git(repo, 'worktree', 'add', '-q', path.join(repo, 'trees', 'nested'));
    git(repo, 'worktree', 'add', '-q', path.join(repo, 'trees', 'without'));
    await writeFile(path.join(repo, 'trees', 'nested', 'AGENTS.md'), 'worktree copy');
    await rm(path.join(repo, 'trees', 'without', 'AGENTS.md'));

    expect((await loadProjectContext(path.join(repo, 'trees', 'nested'))).instructions).toEqual([{ path: 'AGENTS.md', text: 'worktree copy' }]);
    expect((await loadProjectContext(path.join(repo, 'trees', 'without'))).instructions).toEqual([{ path: path.join(repo, 'AGENTS.md'), text: 'main copy' }]);
    expect((await loadProjectContext(repo)).instructions).toEqual([{ path: 'AGENTS.md', text: 'main copy' }]);
  });

  it('strips hidden Unicode and carriage returns', async () => {
    const root = await tree({ 'AGENTS.md': 'Use pnpm.​‮\r\nRun tests.\u{E0041}\r\n' });
    expect((await loadProjectContext(root)).instructions).toEqual([{ path: 'AGENTS.md', text: 'Use pnpm.\nRun tests.\n' }]);
  });
});

describe('.cursor/rules', () => {
  it('sorts rules by when they apply and drops manual ones', async () => {
    const root = await tree({
      '.cursor/rules/always.mdc': '---\ndescription: house style\nalwaysApply: true\n---\nUse tabs.\n',
      '.cursor/rules/react.mdc': '---\ndescription: React\nglobs: *.tsx, src/ui/**\nalwaysApply: false\n---\nPrefer function components.\n',
      '.cursor/rules/listed.mdc': '---\nglobs:\n  - "db/**/*.sql"\n  - migrations/*\n---\nNo destructive migrations.\n',
      '.cursor/rules/requested.mdc': '---\ndescription: How releases are cut\nglobs:\nalwaysApply: false\n---\nTag, then publish.\n',
      '.cursor/rules/manual.mdc': '---\ndescription:\nglobs:\nalwaysApply: false\n---\nOnly when mentioned.\n',
      '.cursor/rules/notes.md': 'not a rule',
    });
    expect((await loadProjectContext(root)).rules).toEqual([
      { path: '.cursor/rules/always.mdc', trigger: { kind: 'always' }, text: 'Use tabs.' },
      { path: '.cursor/rules/listed.mdc', trigger: { kind: 'globs', globs: ['db/**/*.sql', 'migrations/*'] }, text: 'No destructive migrations.' },
      { path: '.cursor/rules/react.mdc', trigger: { kind: 'globs', globs: ['*.tsx', 'src/ui/**'] }, text: 'Prefer function components.' },
      { path: '.cursor/rules/requested.mdc', trigger: { kind: 'requested', description: 'How releases are cut' }, text: 'Tag, then publish.' },
    ]);
  });

  it('reads frontmatter YAML would reject, and bracketed lists', () => {
    expect(triggerOf(parseFrontmatter('---\nglobs: *.ts\n---\nx').fields)).toEqual({ kind: 'globs', globs: ['*.ts'] });
    expect(triggerOf(parseFrontmatter('---\nglobs: ["a/*.ts", \'b/**\']\n---\n').fields)).toEqual({ kind: 'globs', globs: ['a/*.ts', 'b/**'] });
    expect(triggerOf(parseFrontmatter('---\nalwaysApply: TRUE\nglobs: *.ts\n---\n').fields)).toEqual({ kind: 'always' });
    expect(parseFrontmatter('no frontmatter\n---\n')).toEqual({ fields: {}, body: 'no frontmatter\n---\n' });
  });
});

describe('skills', () => {
  it('lists SKILL.md files by frontmatter name and description, .agents before .claude, first name wins', async () => {
    const root = await tree({
      '.agents/skills/deploy/SKILL.md': '---\nname: deploy-app\ndescription: Ship the app to staging.\n---\nSteps.\n',
      '.agents/skills/fold/SKILL.md': '---\ndescription: >\n  Folded over\n  two lines.\n---\n',
      '.claude/skills/review/SKILL.md': '---\nname: review\ndescription: "Review a diff."\n---\n',
      '.claude/skills/deploy/SKILL.md': '---\nname: deploy-app\ndescription: The other deploy.\n---\n',
      '.claude/skills/bare/SKILL.md': '---\nname: bare\n---\nNo description, so not listed.\n',
      '.claude/skills/loose.md': 'not in a skill directory',
    });
    expect((await loadProjectContext(root)).skills).toEqual([
      { name: 'deploy-app', description: 'Ship the app to staging.', path: '.agents/skills/deploy/SKILL.md' },
      { name: 'fold', description: 'Folded over two lines.', path: '.agents/skills/fold/SKILL.md' },
      { name: 'review', description: 'Review a diff.', path: '.claude/skills/review/SKILL.md' },
    ]);
  });

  it('loads nothing from an empty workspace', async () => {
    expect(await loadProjectContext(await tree({}))).toEqual({ instructions: [], rules: [], skills: [] });
  });
});
