import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND_META, type SlashCommand } from '@g-code/core';
import { availableCommands, globalSkillRoots, loadCommands, watchCommands } from '../src/commands.js';
import { runCli } from './helpers.js';

async function tree(files: Readonly<Record<string, string>>): Promise<{ readonly workspace: string; readonly home: string }> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-commands-')));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  await mkdir(path.join(root, 'ws'), { recursive: true });
  await mkdir(path.join(root, 'home'), { recursive: true });
  return { workspace: path.join(root, 'ws'), home: path.join(root, 'home') };
}

const skill = (name: string, description: string, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${name} steps\n`;

const summary = (commands: readonly SlashCommand[]) =>
  commands.flatMap((c) => (c.kind === 'builtin' ? [] : [`${c.kind} ${c.name} ${c.scope}: ${c.description}`]));

describe('command discovery', () => {
  it("reads commands and skills from ~/.g-code and the workspace, and the user's own wins a name in both, with a problem line", async () => {
    const { workspace, home } = await tree({
      'ws/.claude/commands/review.md': '---\ndescription: Review a file\nargument-hint: <file>\n---\nReview $1.\n',
      'ws/.agents/commands/ship.md': 'Ship it now, carefully and with a changelog entry for every package touched.\n',
      'ws/.claude/commands/notes.txt': 'not a command',
      'ws/.claude/skills/add-i18n/SKILL.md': skill('add-i18n', 'Add a locale', 'argument-hint: <locale>\n'),
      'ws/.claude/skills/lint/SKILL.md': skill('lint', 'Lint the repo'),
      'ws/.agents/skills/no-description/SKILL.md': '---\nname: no-description\n---\nbody',
      'home/commands/review.md': '---\ndescription: Global review\n---\nGlobal.',
      'home/commands/standup.md': '---\ndescription: Write a standup\n---\nStandup for $ARGUMENTS.',
      'home/skills/add-i18n/SKILL.md': skill('add-i18n', 'Global locale skill', 'argument-hint: <locale>\n'),
      'home/skills/tidy/SKILL.md': skill('tidy', 'Tidy the repo'),
    });

    const { commands, problems } = await loadCommands(workspace, { app: home, user: undefined }, []);

    expect(commands.slice(0, 10).map((c) => c.name)).toEqual(['new', 'history', 'mode', 'model', 'clear', 'compact', 'rules', 'memory', 'init', 'best-of-n']);
    expect(summary(commands)).toEqual([
      'prompt review global: Global review',
      'prompt standup global: Write a standup',
      'skill add-i18n global: Global locale skill',
      'skill tidy global: Tidy the repo',
      'prompt ship workspace: Ship it now, carefully and with a changelog entry for every ...',
      'skill lint workspace: Lint the repo',
    ]);
    expect(problems).toEqual([
      `.claude/commands/review.md: not loaded, because your own command review (${path.join(home, 'commands', 'review.md')}) has its name`,
      `.claude/skills/add-i18n/SKILL.md: not loaded, because your own skill add-i18n (${path.join(home, 'skills', 'add-i18n', 'SKILL.md')}) has its name`,
    ]);
    expect(commands.find((c) => c.name === 'review')).toMatchObject({ path: path.join(home, 'commands', 'review.md'), template: 'Global.' });
    expect(commands.find((c) => c.name === 'add-i18n')).toMatchObject({ hint: '<locale>', text: skill('add-i18n', 'Global locale skill', 'argument-hint: <locale>\n') });
    expect(commands.find((c) => c.name === 'lint')).toMatchObject({ path: '.claude/skills/lint/SKILL.md' });
    expect(commands.find((c) => c.name === 'tidy')).toMatchObject({ path: path.join(home, 'skills', 'tidy', 'SKILL.md') });
  });

  it('reads the frontmatter that decides who may load a skill and where it runs', async () => {
    const { workspace, home } = await tree({
      'home/skills/plain/SKILL.md': skill('plain', 'Plain'),
      'home/skills/go/SKILL.md': skill('go', 'User only', 'disable-model-invocation: true\n'),
      'home/skills/digest/SKILL.md': skill('digest', 'Summarize in a child', 'context: fork\nagent: Explore\n'),
      'home/skills/background/SKILL.md': skill('background', 'Model only', 'user-invocable: false\n'),
    });
    const { commands } = await loadCommands(workspace, { app: home, user: undefined }, []);
    const of = (name: string) => commands.find((c) => c.name === name);
    expect(of('plain')).toMatchObject({ userInvocable: true, modelInvocable: true, fork: undefined });
    expect(of('go')).toMatchObject({ userInvocable: true, modelInvocable: false });
    expect(of('digest')).toMatchObject({ modelInvocable: true, fork: { agent: 'Explore' } });
    expect(of('background')).toMatchObject({ userInvocable: false, modelInvocable: true });
  });

  it('reads ~/.claude/skills, after ~/.g-code and ~/.agents', async () => {
    const { workspace, home } = await tree({
      'home/skills/tidy/SKILL.md': skill('tidy', 'Geno tidy'),
      'claude/skills/tidy/SKILL.md': skill('tidy', 'Claude tidy'),
      'claude/skills/ship/SKILL.md': skill('ship', 'Claude ship'),
      'user/.agents/skills/ship/SKILL.md': skill('ship', 'Agents ship'),
    });
    const root = path.dirname(home);
    const { commands, problems } = await loadCommands(workspace, { app: home, user: path.join(root, 'user'), claude: path.join(root, 'claude') }, []);
    expect(summary(commands)).toEqual(['skill tidy global: Geno tidy', 'skill ship global: Agents ship']);
    expect(commands.find((c) => c.name === 'ship')).toMatchObject({ path: path.join(root, 'user', '.agents', 'skills', 'ship', 'SKILL.md') });
    expect(problems).toEqual([]);
  });

  it('reads commands and skills from ~/.agents, ~/.claude/commands and the workspace\'s .g-code, Geno\'s own name first in each place', async () => {
    const { workspace, home } = await tree({
      'user/.agents/commands/standup.md': '---\ndescription: Agents standup\n---\nStandup.',
      'claude/commands/standup.md': '---\ndescription: Claude standup\n---\nStandup.',
      'claude/commands/retro.md': '---\ndescription: Claude retro\n---\nRetro.',
      'ws/.g-code/commands/review.md': '---\ndescription: Geno review\n---\nReview.',
      'ws/.agents/commands/review.md': '---\ndescription: Agents review\n---\nReview.',
      'ws/.g-code/skills/lint/SKILL.md': skill('lint', 'Geno lint'),
      'ws/.claude/skills/lint/SKILL.md': skill('lint', 'Claude lint'),
    });
    const root = path.dirname(home);
    const { commands, problems } = await loadCommands(workspace, { app: home, user: path.join(root, 'user'), claude: path.join(root, 'claude') }, []);
    expect(summary(commands)).toEqual(['prompt standup global: Agents standup', 'prompt retro global: Claude retro', 'prompt review workspace: Geno review', 'skill lint workspace: Geno lint']);
    expect(commands.find((c) => c.name === 'lint')).toMatchObject({ path: '.g-code/skills/lint/SKILL.md' });
    expect(problems).toEqual([]);
  });

  it('never lets a file shadow a built-in', async () => {
    const { workspace, home } = await tree({ 'ws/.claude/commands/new.md': 'Pretend to be new.' });
    expect((await loadCommands(workspace, { app: home, user: undefined }, [])).commands.filter((c) => c.name === 'new')).toEqual([expect.objectContaining({ kind: 'builtin' })]);
  });

  it('lists each command for ACP with its description, its input hint, and whether a built-in is the editor\'s to run', async () => {
    const { workspace, home } = await tree({ 'ws/.claude/commands/review.md': '---\ndescription: Review a file\nargument-hint: <file>\n---\nReview $1.' });
    const listed = availableCommands((await loadCommands(workspace, { app: home, user: undefined }, [])).commands);
    expect(listed.find((c) => c.name === 'new')).toEqual({ name: 'new', description: 'Start a new chat', input: null, _meta: { [COMMAND_META]: { kind: 'builtin', runs: 'client' } } });
    expect(listed.find((c) => c.name === 'mode')).toEqual({
      name: 'mode',
      description: 'Switch the approval mode',
      input: { hint: 'plan | ask | auto' },
      _meta: { [COMMAND_META]: { kind: 'builtin', runs: 'engine' } },
    });
    expect(listed.find((c) => c.name === 'review')).toEqual({ name: 'review', description: 'Review a file', input: { hint: '<file>' }, _meta: { [COMMAND_META]: { kind: 'prompt' } } });
  });

  it('calls back after a change, including in a commands folder created after the watch began', async () => {
    const { workspace, home } = await tree({});
    let calls = 0;
    const stop = watchCommands(workspace, { app: home, user: undefined }, () => calls++, 50);
    // FSEvents misses changes made in the first moments of a watch.
    await new Promise((r) => setTimeout(r, 100));
    try {
      await mkdir(path.join(workspace, '.claude', 'commands'), { recursive: true });
      await writeFile(path.join(workspace, '.claude', 'commands', 'one.md'), 'One.');
      await writeFile(path.join(workspace, '.claude', 'commands', 'two.md'), 'Two.');
      await until(() => calls > 0);
      await new Promise((r) => setTimeout(r, 200));
      let seen = calls;
      await writeFile(path.join(workspace, '.claude', 'commands', 'three.md'), 'Three.');
      await until(() => calls > seen);
      await new Promise((r) => setTimeout(r, 200));
      seen = calls;
      await mkdir(path.join(home, 'skills', 'tidy'), { recursive: true });
      await writeFile(path.join(home, 'skills', 'tidy', 'SKILL.md'), skill('tidy', 'Tidy'));
      await until(() => calls > seen);
    } finally {
      stop();
    }
  });

  it('sees a change made the moment it calls back, in a folder it was already watching', async () => {
    const { workspace, home } = await tree({});
    await mkdir(path.join(home, 'commands'), { recursive: true });
    let calls = 0;
    const stop = watchCommands(
      workspace,
      { app: home, user: undefined },
      () => {
        // A client re-lists on the callback and the user adds the next command at once.
        if (++calls === 1) writeFileSync(path.join(home, 'commands', 'two.md'), 'Two.');
      },
      50,
    );
    await new Promise((r) => setTimeout(r, 100));
    try {
      await mkdir(path.join(workspace, '.claude', 'commands'), { recursive: true });
      await writeFile(path.join(workspace, '.claude', 'commands', 'one.md'), 'One.');
      await until(() => calls >= 2);
    } finally {
      stop();
    }
  });

  it('reads the standard ~/.agents/skills too: ~/.g-code wins a name in both, and either wins over the workspace', async () => {
    const { workspace, home } = await tree({
      'ws/.agents/skills/lint/SKILL.md': skill('lint', 'Workspace lint'),
      'ws/.agents/skills/build/SKILL.md': skill('build', 'Workspace build'),
      'home/skills/tidy/SKILL.md': skill('tidy', 'Geno tidy'),
      'user/.agents/skills/tidy/SKILL.md': skill('tidy', 'Agents tidy'),
      'user/.agents/skills/lint/SKILL.md': skill('lint', 'Agents lint'),
      'user/.agents/skills/deploy/SKILL.md': skill('deploy', 'Deploy the site'),
    });
    const user = path.join(path.dirname(home), 'user');
    const { commands } = await loadCommands(workspace, { app: home, user }, []);
    expect(summary(commands)).toEqual(['skill tidy global: Geno tidy', 'skill deploy global: Deploy the site', 'skill lint global: Agents lint', 'skill build workspace: Workspace build']);
    expect(commands.find((c) => c.name === 'deploy')).toMatchObject({ path: path.join(user, '.agents', 'skills', 'deploy', 'SKILL.md') });
    expect(summary((await loadCommands(workspace, { app: home, user: undefined }, [])).commands)).toEqual(['skill tidy global: Geno tidy', 'skill build workspace: Workspace build', 'skill lint workspace: Workspace lint']);
  });

  it('opens the global skill folders for reading, as real paths, and never one that holds the home or the Claude config dir', async () => {
    const { home } = await tree({ 'home/skills/tidy/SKILL.md': skill('tidy', 'Tidy'), 'user/.agents/skills/deploy/SKILL.md': skill('deploy', 'Deploy') });
    const user = path.join(path.dirname(home), 'user');
    const claude = path.join(user, '.claude');
    expect(await globalSkillRoots({ app: home, user }, claude)).toEqual([path.join(home, 'skills'), path.join(user, '.agents', 'skills')]);
    expect(await globalSkillRoots({ app: path.join(home, 'missing'), user: undefined }, undefined)).toEqual([]);

    const { symlink, rm } = await import('node:fs/promises');
    await rm(path.join(user, '.agents', 'skills'), { recursive: true });
    await symlink(user, path.join(user, '.agents', 'skills'));
    expect(await globalSkillRoots({ app: home, user }, claude)).toEqual([path.join(home, 'skills')]);
    await rm(path.join(user, '.agents', 'skills'));
    await symlink(claude, path.join(user, '.agents', 'skills'));
    await mkdir(claude, { recursive: true });
    expect(await globalSkillRoots({ app: home, user: undefined }, path.join(home, 'skills'))).toEqual([]);
  });

  it('calls back when a skill appears in ~/.agents/skills, a folder created after the watch began', async () => {
    const { workspace, home } = await tree({});
    const user = path.join(path.dirname(home), 'user');
    await mkdir(user, { recursive: true });
    let calls = 0;
    const stop = watchCommands(workspace, { app: home, user }, () => calls++, 50);
    await new Promise((r) => setTimeout(r, 100));
    try {
      await mkdir(path.join(user, '.agents', 'skills', 'deploy'), { recursive: true });
      await writeFile(path.join(user, '.agents', 'skills', 'deploy', 'SKILL.md'), skill('deploy', 'Deploy'));
      await until(() => calls > 0);
    } finally {
      stop();
    }
  });
});

async function until(done: () => boolean): Promise<void> {
  for (let waited = 0; !done(); waited += 10) {
    if (waited > 5000) throw new Error('timed out waiting for the watcher');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('gcode commands list', () => {
  it('prints every command with where it comes from', async () => {
    const { workspace, home } = await tree({
      'ws/.claude/commands/review.md': '---\ndescription: Review a file\nargument-hint: <file>\n---\nReview $1.',
      'home/skills/tidy/SKILL.md': skill('tidy', 'Tidy the repo'),
    });
    const { code, stdout } = await runCli(['commands', 'list', '--workspace', workspace], { GCODE_HOME: home });
    expect(code).toBe(0);
    expect(stdout.split('\n')).toEqual([
      '/new                 built-in, editor    Start a new chat',
      '/history             built-in, editor    Open a past chat',
      '/mode plan | ask | auto built-in, engine    Switch the approval mode',
      '/model               built-in, editor    Choose the model',
      '/clear               built-in, editor    Clear the chat and start fresh',
      '/compact [focus]     built-in, engine    Summarize the older turns to free context',
      '/rules               built-in, editor    Show the project rules',
      '/memory              built-in, editor    Show what Geno remembers',
      '/init                built-in, engine    Create or update AGENTS.md for this project',
      '/best-of-n <2-4> <task> built-in, editor    Run a task in 2 to 4 lanes and pick the best; --vary seeds, effort or models',
      '/schedule <when> [--edits] <prompt> built-in, engine    Run a prompt later or on a schedule, as a background task',
      '/workflow <name> [--resume <run>] [input] built-in, engine    Run a workflow from .g-code/workflows in the background, after its cost preview',
      `/tidy                ${path.join(home, 'skills', 'tidy', 'SKILL.md')}    Tidy the repo`,
      '/review <file>       .claude/commands/review.md    Review a file',
    ]);
  });
});
