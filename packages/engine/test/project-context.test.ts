import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProjectContext, parseFrontmatter, triggerOf, type UserDirs } from '../src/project-context.js';

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
    const { instructions } = (await loadProjectContext(path.join(root, 'mid', 'ws'))).context;
    expect(instructions).toEqual([
      { path: path.join(root, 'AGENTS.md'), text: 'top' },
      { path: path.join(root, 'mid', 'CLAUDE.md'), text: 'mid claude' },
      { path: 'AGENTS.md', text: 'workspace agents' },
    ]);
  });

  it('prefers AGENTS.override.md, then AGENTS.md, then CLAUDE.md, and skips a directory of that name', async () => {
    const root = await tree({ 'AGENTS.override.md': 'override', 'AGENTS.md': 'agents', 'CLAUDE.md': 'claude', 'b/CLAUDE.md': 'claude b', 'b/AGENTS.md/x': '' });
    expect((await loadProjectContext(root)).context.instructions).toEqual([{ path: 'AGENTS.override.md', text: 'override' }]);
    expect((await loadProjectContext(path.join(root, 'b'))).context.instructions).toEqual([
      { path: path.join(root, 'AGENTS.override.md'), text: 'override' },
      { path: 'CLAUDE.md', text: 'claude b' },
    ]);
  });

  it('loads a file reached twice through a symlinked directory once', async () => {
    const root = await tree({ 'real/AGENTS.md': 'once' });
    await symlink(path.join(root, 'real', 'AGENTS.md'), path.join(root, 'AGENTS.md'));
    expect((await loadProjectContext(path.join(root, 'real'))).context.instructions).toEqual([{ path: 'AGENTS.md', text: 'once' }]);
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

    expect((await loadProjectContext(path.join(repo, 'trees', 'nested'))).context.instructions).toEqual([{ path: 'AGENTS.md', text: 'worktree copy' }]);
    expect((await loadProjectContext(path.join(repo, 'trees', 'without'))).context.instructions).toEqual([{ path: path.join(repo, 'AGENTS.md'), text: 'main copy' }]);
    expect((await loadProjectContext(repo)).context.instructions).toEqual([{ path: 'AGENTS.md', text: 'main copy' }]);
  });

  it('strips hidden Unicode and carriage returns', async () => {
    const root = await tree({ 'AGENTS.md': 'Use pnpm.​‮\r\nRun tests.\u{E0041}\r\n' });
    expect((await loadProjectContext(root)).context.instructions).toEqual([{ path: 'AGENTS.md', text: 'Use pnpm.\nRun tests.\n' }]);
  });
});

describe('layers and imports', () => {
  const MiB = 1024 * 1024;

  /** A workspace and a home side by side; `home/.g-code` is the app home, `home/.claude` Claude Code's. */
  async function layout(files: Readonly<Record<string, string>>) {
    const root = await tree(files);
    const home = path.join(root, 'home');
    const dirs: UserDirs = { app: path.join(home, '.g-code'), home, claude: path.join(home, '.claude') };
    return { home, workspace: path.join(root, 'ws'), dirs };
  }

  it('loads the user files, then the project files, then .claude/CLAUDE.md and CLAUDE.local.md, each import right after its importer', async () => {
    const { home, workspace, dirs } = await layout({
      'home/.g-code/AGENTS.md': 'App rules.',
      'home/.claude/CLAUDE.md': '@~/.claude/pstack-models.md\n',
      'home/.claude/pstack-models.md': 'feature: opus',
      'ws/AGENTS.md': 'Workspace.\n@docs/style.md\nMore workspace.\n',
      'ws/docs/style.md': 'Style.',
      'ws/.claude/CLAUDE.md': 'Claude dir.',
      'ws/CLAUDE.local.md': 'Local.\n@./notes/mine.md',
      'ws/notes/mine.md': 'Mine.',
    });
    const { context, problems } = await loadProjectContext(workspace, dirs);
    expect(context.user).toEqual([
      { path: path.join(home, '.g-code', 'AGENTS.md'), text: 'App rules.' },
      { path: path.join(home, '.claude', 'CLAUDE.md'), text: '@~/.claude/pstack-models.md\n' },
      { path: path.join(home, '.claude', 'pstack-models.md'), text: 'feature: opus', importedFrom: path.join(home, '.claude', 'CLAUDE.md') },
    ]);
    expect(context.instructions).toEqual([
      { path: 'AGENTS.md', text: 'Workspace.\n@docs/style.md\nMore workspace.\n' },
      { path: 'docs/style.md', text: 'Style.', importedFrom: 'AGENTS.md' },
      { path: '.claude/CLAUDE.md', text: 'Claude dir.' },
      { path: 'CLAUDE.local.md', text: 'Local.\n@./notes/mine.md' },
      { path: 'notes/mine.md', text: 'Mine.', importedFrom: 'CLAUDE.local.md' },
    ]);
    expect(context.global).toBeUndefined();
    expect(problems).toEqual([]);
  });

  it('follows only whole @path lines outside code fences, and resolves them against the importing file', async () => {
    const { workspace, dirs } = await layout({
      'ws/AGENTS.md': 'Install @g-code/core first; mail me@example.com.\n```\n@fenced.md\n```\n  @sub/a.md  \n',
      'ws/fenced.md': 'never',
      'ws/sub/a.md': '@b.md',
      'ws/sub/b.md': 'B beside a.',
      'ws/b.md': 'not this b',
    });
    const { context, problems } = await loadProjectContext(workspace, dirs);
    expect(context.instructions.map((file) => [file.path, file.importedFrom])).toEqual([
      ['AGENTS.md', undefined],
      ['sub/a.md', 'AGENTS.md'],
      ['sub/b.md', 'sub/a.md'],
    ]);
    expect(problems).toEqual([]);
  });

  it('follows imports 4 levels deep and skips a fifth with a problem line', async () => {
    const { workspace, dirs } = await layout({
      'ws/AGENTS.md': '@l1.md',
      'ws/l1.md': '@l2.md',
      'ws/l2.md': '@l3.md',
      'ws/l3.md': '@l4.md',
      'ws/l4.md': '@l5.md',
      'ws/l5.md': 'too deep',
    });
    const { context, problems } = await loadProjectContext(workspace, dirs);
    expect(context.instructions.map((file) => file.path)).toEqual(['AGENTS.md', 'l1.md', 'l2.md', 'l3.md', 'l4.md']);
    expect(problems).toEqual(['l4.md: @l5.md skipped, imports nest at most 4 levels deep']);
  });

  it('loads each file once when imports form a cycle, import the file itself, or reach a file the user layer loaded', async () => {
    const { workspace, dirs } = await layout({
      'ws/.claude/CLAUDE.md': 'Claude dir.',
      'ws/AGENTS.md': '@a.md\n@AGENTS.md',
      'ws/a.md': '@b.md',
      'ws/b.md': '@a.md\n@.claude/CLAUDE.md',
      'home/.claude/CLAUDE.md': '@~/../ws/a.md',
    });
    const { context, problems } = await loadProjectContext(workspace, dirs);
    expect(context.user?.map((file) => path.basename(file.path))).toEqual(['CLAUDE.md', 'a.md', 'b.md', 'CLAUDE.md']);
    expect(context.instructions.map((file) => file.path)).toEqual(['AGENTS.md']);
    expect(problems).toEqual([]);
  });

  it('skips a file over 4 MiB, loaded or imported, with a problem line', async () => {
    const big = 'x'.repeat(4 * MiB + 1);
    const { workspace, dirs } = await layout({
      'home/.claude/CLAUDE.md': big,
      'ws/AGENTS.md': 'Small.\n@big.md',
      'ws/big.md': big,
      'ws/edge.md': 'y'.repeat(4 * MiB),
      'ws/CLAUDE.local.md': '@edge.md',
    });
    const { context, problems } = await loadProjectContext(workspace, dirs);
    expect(context.user).toBeUndefined();
    expect(context.instructions.map((file) => file.path)).toEqual(['AGENTS.md', 'CLAUDE.local.md', 'edge.md']);
    expect(problems).toEqual([
      `${path.join(dirs.claude!, 'CLAUDE.md')}: skipped, it is 4,194,305 bytes, over the 4 MiB limit`,
      'AGENTS.md: @big.md skipped, it is 4,194,305 bytes, over the 4 MiB limit',
    ]);
  });

  it('reports an import that names no file, and still loads the file that holds it', async () => {
    const { workspace, dirs } = await layout({ 'ws/AGENTS.md': 'Kept.\n@missing.md\n@docs', 'ws/docs/x.md': '' });
    const { context, problems } = await loadProjectContext(workspace, dirs);
    expect(context.instructions).toEqual([{ path: 'AGENTS.md', text: 'Kept.\n@missing.md\n@docs' }]);
    expect(problems).toEqual(['AGENTS.md: @missing.md skipped, there is no such file', 'AGENTS.md: @docs skipped, there is no such file']);
  });

  it('refuses an import of a credentials path, from the user files and the project files alike, symlinks included', async () => {
    const { workspace, dirs } = await layout({
      'home/.ssh/id_rsa': 'PRIVATE KEY',
      'home/.claude/CLAUDE.md': '@~/.ssh/id_rsa',
      'ws/.env': 'API_KEY=sk-live-123',
      'ws/AGENTS.md': '@.env\n@notes.md',
    });
    await symlink(path.join(workspace, '.env'), path.join(workspace, 'notes.md'));
    const { context, problems } = await loadProjectContext(workspace, dirs);
    const loaded = [...(context.user ?? []), ...context.instructions].map((file) => file.text).join('\n');
    expect(loaded).not.toContain('PRIVATE KEY');
    expect(loaded).not.toContain('sk-live-123');
    expect(problems).toEqual([
      `${path.join(dirs.claude!, 'CLAUDE.md')}: @~/.ssh/id_rsa skipped, it names a credentials file`,
      'AGENTS.md: @.env skipped, it names a credentials file',
      'AGENTS.md: @notes.md skipped, it names a credentials file',
    ]);
  });

  it("keeps a project file's imports inside its own directory, while the user's files may import any file", async () => {
    const { home, workspace, dirs } = await layout({
      'home/notes.md': 'Home notes.',
      'home/.claude/CLAUDE.md': '@~/notes.md',
      'ws/AGENTS.md': '@~/notes.md\n@../home/notes.md',
    });
    const { context, problems } = await loadProjectContext(workspace, { ...dirs, claude: undefined });
    expect(context.user).toBeUndefined();
    expect(context.instructions).toEqual([{ path: 'AGENTS.md', text: '@~/notes.md\n@../home/notes.md' }]);
    expect(problems).toEqual([
      `AGENTS.md: @~/notes.md skipped, a project file can import only files under ${workspace}`,
      `AGENTS.md: @../home/notes.md skipped, a project file can import only files under ${workspace}`,
    ]);
    const mine = await loadProjectContext(workspace, dirs);
    expect(mine.context.user).toEqual([
      { path: path.join(home, '.claude', 'CLAUDE.md'), text: '@~/notes.md' },
      { path: path.join(home, 'notes.md'), text: 'Home notes.', importedFrom: path.join(home, '.claude', 'CLAUDE.md') },
    ]);
  });

  it('strips hidden Unicode from an imported file, and leaves a blank user file out', async () => {
    const { workspace, dirs } = await layout({ 'home/.g-code/AGENTS.md': ' \n', 'ws/AGENTS.md': '@a.md', 'ws/a.md': 'Use pnpm.​‮\r\n' });
    const { context } = await loadProjectContext(workspace, dirs);
    expect(context.user).toBeUndefined();
    expect(context.instructions[1]).toEqual({ path: 'a.md', text: 'Use pnpm.\n', importedFrom: 'AGENTS.md' });
  });
});

describe('nested instruction files', () => {
  it('registers one file per directory below the workspace, outer first, skipping node_modules, .git and ignored directories', async () => {
    const root = await tree({
      'AGENTS.md': 'Root, loaded at the start.',
      '.gitignore': 'build/\n',
      'pkg/AGENTS.md': 'Package.​‮\r\n',
      'pkg/CLAUDE.md': 'not beside AGENTS.md',
      'pkg/sub/CLAUDE.md': 'Sub.',
      'pkg-two/AGENTS.override.md': 'Override.',
      'pkg-two/AGENTS.md': 'not beside the override',
      '.github/AGENTS.md': 'Workflows.',
      'node_modules/dep/AGENTS.md': 'a dependency',
      'build/AGENTS.md': 'ignored',
      'empty/CLAUDE.md': ' \n',
      'docs/AGENTS.md/x': '',
    });
    git(root, 'init', '-q');
    const { context, problems } = await loadProjectContext(root);
    expect(context.instructions).toEqual([{ path: 'AGENTS.md', text: 'Root, loaded at the start.' }]);
    expect(context.nested).toEqual([
      { path: '.github/AGENTS.md', text: 'Workflows.', dir: '.github' },
      { path: 'pkg/AGENTS.md', text: 'Package.\n', dir: 'pkg' },
      { path: 'pkg/sub/CLAUDE.md', text: 'Sub.', dir: 'pkg/sub' },
      { path: 'pkg-two/AGENTS.override.md', text: 'Override.', dir: 'pkg-two' },
    ]);
    expect(problems).toEqual([]);
  });

  it("follows a nested file's imports by P8's rules: under each directory that imports it, never a file the opening loaded, never outside the workspace or a credentials file", async () => {
    const root = await tree({
      'ws/AGENTS.md': '@docs/shared.md',
      'ws/docs/shared.md': 'Shared, loaded at the start.',
      'ws/docs/style.md': 'Style.',
      'ws/.env': 'API_KEY=sk-live-123',
      'ws/a/AGENTS.md': '@../docs/style.md\n@../docs/shared.md\n@../.env\n@../../outside.md',
      'ws/b/AGENTS.md': '@../docs/style.md',
      'outside.md': 'Outside.',
    });
    const workspace = path.join(root, 'ws');
    const { context, problems } = await loadProjectContext(workspace);
    expect(context.nested).toEqual([
      { path: 'a/AGENTS.md', text: '@../docs/style.md\n@../docs/shared.md\n@../.env\n@../../outside.md', dir: 'a' },
      { path: 'docs/style.md', text: 'Style.', importedFrom: 'a/AGENTS.md', dir: 'a' },
      { path: 'b/AGENTS.md', text: '@../docs/style.md', dir: 'b' },
      { path: 'docs/style.md', text: 'Style.', importedFrom: 'b/AGENTS.md', dir: 'b' },
    ]);
    expect(problems).toEqual([
      'a/AGENTS.md: @../.env skipped, it names a credentials file',
      `a/AGENTS.md: @../../outside.md skipped, a project file can import only files under ${workspace}`,
    ]);
  });

  it('leaves out a nested file the opening already loaded through an import', async () => {
    const root = await tree({ 'AGENTS.md': '@pkg/AGENTS.md', 'pkg/AGENTS.md': 'Package.' });
    const { context } = await loadProjectContext(root);
    expect(context.instructions.map((file) => file.path)).toEqual(['AGENTS.md', 'pkg/AGENTS.md']);
    expect(context.nested).toBeUndefined();
  });

  it('says nested files did not load when ripgrep is missing', async () => {
    const root = await tree({ 'pkg/AGENTS.md': 'Package.' });
    const rg = path.join(root, 'no-rg');
    const { context, problems } = await loadProjectContext(root, undefined, rg);
    expect(context.nested).toBeUndefined();
    expect(problems).toEqual([`nested instruction files not loaded: ripgrep (${rg}) is not installed or not on PATH`]);
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
    expect((await loadProjectContext(root)).context.rules).toEqual([
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
  it('loads nothing from an empty workspace', async () => {
    expect(await loadProjectContext(await tree({}))).toEqual({ context: { instructions: [], rules: [] }, problems: [] });
  });
});
