import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import { AGENT_MODE_TOOL_DEFINITIONS, AGENT_TOOL_DEFINITIONS, type SlashCommand } from '@g-code/core';
import { availableCommands, loadCommands } from '../src/commands.js';
import { DISK_FILES } from '../src/files.js';
import { claudeDirOf, loadPlugins } from '../src/plugins.js';
import { editExecutor } from '../src/tools/agent.js';
import { EXECUTORS, runTool, type Executors, type ToolContext } from '../src/tools/index.js';
import { skillExecutor } from '../src/tools/skill.js';
import { rgCommand } from './helpers.js';

const HOW = '---\nname: how\ndescription: Explain how a subsystem works\n---\n# How\n\nRead references/explorer.md first.\n';
const PRINCIPLE = '---\nname: principle-x\ndescription: A principle\nuser-invocable: false\n---\n# Principle X\n';

async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-plugins-')));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  await mkdir(path.join(root, 'ws'), { recursive: true });
  await mkdir(path.join(root, 'home'), { recursive: true });
  return root;
}

const installed = (plugins: Record<string, readonly object[]>) => JSON.stringify({ version: 2, plugins });

/** A Claude config dir with pstack installed for the user, as Claude Code lays it out. */
async function withPstack(extra: Readonly<Record<string, string>> = {}) {
  const root = await tree({
    'cache/pstack/.claude-plugin/plugin.json': JSON.stringify({ name: 'pstack', version: '1.0.0' }),
    'cache/pstack/skills/how/SKILL.md': HOW,
    'cache/pstack/skills/how/references/explorer.md': 'Explore with grep.\n',
    'cache/pstack/skills/principle-x/SKILL.md': PRINCIPLE,
    ...extra,
  });
  await mkdir(path.join(root, 'claude', 'plugins'), { recursive: true });
  await writeFile(
    path.join(root, 'claude', 'plugins', 'installed_plugins.json'),
    installed({ 'pstack@pstack-claude': [{ scope: 'user', installPath: path.join(root, 'cache', 'pstack'), version: '1.0.0' }] }),
  );
  return { root, claude: path.join(root, 'claude'), workspace: path.join(root, 'ws'), home: path.join(root, 'home'), pluginRoot: path.join(root, 'cache', 'pstack') };
}

const skillNames = (commands: readonly SlashCommand[]) => commands.flatMap((c) => (c.kind === 'skill' ? [`${c.name} ${c.scope}`] : []));

describe('installed Claude Code plugins', () => {
  it('finds the plugins file under CLAUDE_CONFIG_DIR, else HOME, and never guesses a home the environment does not name', () => {
    expect(claudeDirOf({ CLAUDE_CONFIG_DIR: '/c', HOME: '/h' })).toBe('/c');
    expect(claudeDirOf({ HOME: '/h' })).toBe(path.join('/h', '.claude'));
    expect(claudeDirOf({})).toBeUndefined();
  });

  it('lists each plugin skill as <plugin>:<skill> with its absolute path, after the workspace and global skills', async () => {
    const { claude, workspace, home, pluginRoot } = await withPstack({ 'ws/.claude/skills/local/SKILL.md': '---\nname: local\ndescription: Local\n---\nbody\n' });
    const scan = await loadPlugins(claude, workspace);
    expect(scan).toEqual({ plugins: [{ name: 'pstack', root: pluginRoot }], problems: [] });

    const commands = await loadCommands(workspace, home, scan.plugins);
    expect(skillNames(commands)).toEqual(['local workspace', 'pstack:how plugin', 'pstack:principle-x plugin']);
    expect(commands.find((c) => c.name === 'pstack:how')).toMatchObject({ description: 'Explain how a subsystem works', path: path.join(pluginRoot, 'skills', 'how', 'SKILL.md'), text: HOW });
  });

  it('keeps a skill marked user-invocable: false out of the published list, though it stays loadable', async () => {
    const { claude, workspace, home } = await withPstack();
    const commands = await loadCommands(workspace, home, (await loadPlugins(claude, workspace)).plugins);
    const published = availableCommands(commands).map((c) => c.name);
    expect(published).toContain('pstack:how');
    expect(published).not.toContain('pstack:principle-x');
    expect(commands.map((c) => c.name)).toContain('pstack:principle-x');
  });

  it('reads a double-quoted description with its escaped quotes, as pstack writes them', async () => {
    const { claude, workspace, home } = await withPstack({ 'cache/pstack/skills/why/SKILL.md': '---\nname: why\ndescription: "Use for \\"why is X\\" questions, a \\\\ path"\n---\n' });
    const commands = await loadCommands(workspace, home, (await loadPlugins(claude, workspace)).plugins);
    expect(commands.find((c) => c.name === 'pstack:why')?.description).toBe('Use for "why is X" questions, a \\ path');
  });

  it('lets a workspace skill of the same name win', async () => {
    const { claude, workspace, home } = await withPstack({ 'ws/.agents/skills/mine/SKILL.md': '---\nname: pstack:how\ndescription: The workspace one\n---\nmine\n' });
    const commands = await loadCommands(workspace, home, (await loadPlugins(claude, workspace)).plugins);
    expect(commands.filter((c) => c.name === 'pstack:how')).toEqual([expect.objectContaining({ scope: 'workspace', description: 'The workspace one' })]);
  });

  it('applies a project-scoped plugin only in its own project, and names a plugin without a manifest by its key', async () => {
    const root = await tree({ 'cache/a/skills/one/SKILL.md': '---\nname: one\ndescription: One\n---\n', 'cache/b/skills/two/SKILL.md': '---\nname: two\ndescription: Two\n---\n' });
    await mkdir(path.join(root, 'claude', 'plugins'), { recursive: true });
    await writeFile(
      path.join(root, 'claude', 'plugins', 'installed_plugins.json'),
      installed({
        'alpha@market': [{ scope: 'project', projectPath: path.join(root, 'ws'), installPath: path.join(root, 'cache', 'a') }],
        'beta@market': [{ scope: 'project', projectPath: path.join(root, 'elsewhere'), installPath: path.join(root, 'cache', 'b') }],
      }),
    );
    expect(await loadPlugins(path.join(root, 'claude'), path.join(root, 'ws'))).toEqual({ plugins: [{ name: 'alpha', root: path.join(root, 'cache', 'a') }], problems: [] });
  });

  it('treats a missing plugins file as no plugins, without a problem', async () => {
    const root = await tree({});
    expect(await loadPlugins(path.join(root, 'claude'), path.join(root, 'ws'))).toEqual({ plugins: [], problems: [] });
    expect(await loadPlugins(undefined, path.join(root, 'ws'))).toEqual({ plugins: [], problems: [] });
  });

  it('reports a malformed plugins file, a missing install path and a malformed manifest as problems, never a crash', async () => {
    const root = await tree({ 'claude/plugins/installed_plugins.json': '{ not json' });
    const broken = await loadPlugins(path.join(root, 'claude'), path.join(root, 'ws'));
    expect(broken.plugins).toEqual([]);
    expect(broken.problems).toEqual([expect.stringContaining('installed_plugins.json')]);

    await writeFile(path.join(root, 'claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: 'nope' }));
    expect((await loadPlugins(path.join(root, 'claude'), path.join(root, 'ws'))).problems).toEqual([expect.stringContaining('installed_plugins.json')]);

    await mkdir(path.join(root, 'cache', 'bad', '.claude-plugin'), { recursive: true });
    await writeFile(path.join(root, 'cache', 'bad', '.claude-plugin', 'plugin.json'), '[');
    await writeFile(
      path.join(root, 'claude', 'plugins', 'installed_plugins.json'),
      installed({ 'gone@m': [{ scope: 'user', installPath: path.join(root, 'cache', 'gone') }], 'bad@m': [{ scope: 'user', installPath: path.join(root, 'cache', 'bad') }] }),
    );
    const scan = await loadPlugins(path.join(root, 'claude'), path.join(root, 'ws'));
    expect(scan.plugins).toEqual([]);
    expect(scan.problems).toEqual([expect.stringMatching(/^bad@m: .*plugin\.json/), expect.stringMatching(/^gone@m: .*does not exist/)]);
  });
});

describe('a plugin root as a read-only root', () => {
  const setup = async () => {
    const fixture = await withPstack({ 'outside/secret.txt': 'secret\n' });
    const ctx: ToolContext = {
      workspace: fixture.workspace,
      spillDir: path.join(fixture.root, 'spill'),
      attachmentsDir: path.join(fixture.root, 'spill', 'attachments'),
      readRoots: [fixture.pluginRoot],
      rg: rgCommand(),
      signal: new AbortController().signal,
      files: DISK_FILES,
      events: () => [],
    };
    return { ...fixture, ctx };
  };
  let nextId = 0;
  const call = (ctx: ToolContext, name: string, input: unknown, executors: Executors = EXECUTORS) =>
    runTool({ type: 'tool_use', id: `tu_${nextId++}`, name, input, caller: { type: 'direct' } } as ToolUseBlock, ctx, executors);

  it('reads, lists, greps and globs inside the plugin root, by absolute path', async () => {
    const { ctx, pluginRoot } = await setup();
    const how = path.join(pluginRoot, 'skills', 'how');
    expect(await call(ctx, 'read', { path: path.join(how, 'references', 'explorer.md') })).toEqual({ status: 'ok', text: '1\tExplore with grep.' });
    expect(await call(ctx, 'list', { directory: how })).toEqual({ status: 'ok', text: [`${how}/SKILL.md`, `${how}/references/`, `${how}/references/explorer.md`].join('\n') });
    expect(await call(ctx, 'grep', { pattern: 'grep', directory: pluginRoot })).toEqual({ status: 'ok', text: `${how}/references/explorer.md:1:Explore with grep.` });
    expect(await call(ctx, 'glob', { pattern: '**/SKILL.md', directory: pluginRoot })).toEqual({
      status: 'ok',
      text: [`${how}/SKILL.md`, `${pluginRoot}/skills/principle-x/SKILL.md`].join('\n'),
    });
  });

  it('still refuses a path outside every root', async () => {
    const { ctx, root } = await setup();
    expect(await call(ctx, 'read', { path: path.join(root, 'outside', 'secret.txt') })).toEqual({ status: 'error', text: expect.stringMatching(/outside the workspace/) });
    expect(await call(ctx, 'grep', { pattern: 'secret', directory: path.join(root, 'outside') })).toEqual({ status: 'error', text: expect.stringMatching(/outside the workspace/) });
  });

  it('refuses an edit or a new file there', async () => {
    const { ctx, pluginRoot } = await setup();
    const skillFile = path.join(pluginRoot, 'skills', 'how', 'SKILL.md');
    const edit = { edit: editExecutor(new Map(), async () => undefined) };
    expect(await call(ctx, 'read', { path: skillFile })).toMatchObject({ status: 'ok' });
    expect(await call(ctx, 'edit', { path: skillFile, old_str: '# How', new_str: '# Changed' }, edit)).toEqual({ status: 'error', text: expect.stringMatching(/outside the workspace/) });
    expect(await call(ctx, 'edit', { path: path.join(pluginRoot, 'new.md'), create: true, new_str: 'x' }, edit)).toEqual({ status: 'error', text: expect.stringMatching(/outside the workspace/) });
    expect(await readFile(skillFile, 'utf8')).toBe(HOW);
  });
});

describe('the skill tool', () => {
  const setup = async () => {
    const fixture = await withPstack({ 'ws/.claude/skills/local/SKILL.md': '---\nname: local\ndescription: Local\n---\nLocal steps.\n' });
    const commands = await loadCommands(fixture.workspace, fixture.home, (await loadPlugins(fixture.claude, fixture.workspace)).plugins);
    const ctx = { workspace: fixture.workspace } as ToolContext;
    return { ...fixture, ctx, tool: skillExecutor(async () => commands) };
  };

  it('returns a plugin skill body, without its frontmatter, and the folder its relative paths resolve against', async () => {
    const { ctx, tool, pluginRoot } = await setup();
    const folder = path.join(pluginRoot, 'skills', 'how');
    expect(await tool.run({ name: 'pstack:how' }, ctx)).toBe(`Skill pstack:how, from ${folder}/SKILL.md. Resolve relative paths in it against ${folder}.\n\n# How\n\nRead references/explorer.md first.\n`);
    expect(tool.describe({ name: 'pstack:how' })).toBe('skill pstack:how');
  });

  it('loads a skill hidden from the slash list, and a workspace skill by its workspace path', async () => {
    const { ctx, tool } = await setup();
    expect(await tool.run({ name: 'pstack:principle-x' }, ctx)).toContain('# Principle X');
    expect(await tool.run({ name: 'local' }, ctx)).toBe('Skill local, from .claude/skills/local/SKILL.md. Resolve relative paths in it against .claude/skills/local.\n\nLocal steps.\n');
  });

  it('names the skills there are when asked for one that is not', async () => {
    const { ctx, tool } = await setup();
    await expect(tool.run({ name: 'pstack:nope' }, ctx)).rejects.toThrow('no skill named pstack:nope; the skills are local, pstack:how, pstack:principle-x');
  });

  it('is offered in every mode, Plan included, in the sorted and frozen definitions', () => {
    const names = AGENT_TOOL_DEFINITIONS.map((tool) => tool.name);
    expect(names).toContain('skill');
    expect(names).toEqual(names.toSorted());
    expect(Object.isFrozen(AGENT_TOOL_DEFINITIONS)).toBe(true);
    for (const tools of Object.values(AGENT_MODE_TOOL_DEFINITIONS)) expect(tools.map((tool) => tool.name)).toContain('skill');
  });
});

describe('docs/geno-tools.md', () => {
  it('is shipped in the engine bundle byte for byte; run scripts/geno-tools.ts after editing it', async () => {
    const { GENO_TOOLS } = await import('../src/geno-tools.generated.js');
    expect(GENO_TOOLS).toBe(await readFile(path.join(import.meta.dirname, '..', '..', '..', 'docs', 'geno-tools.md'), 'utf8'));
  });
});
