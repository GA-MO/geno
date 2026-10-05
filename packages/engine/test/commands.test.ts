import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND_META, type SlashCommand } from '@g-code/core';
import { availableCommands, loadCommands, watchCommands } from '../src/commands.js';
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
  it('reads commands and skills from the workspace and ~/.g-code, and the workspace wins a name in both', async () => {
    const { workspace, home } = await tree({
      'ws/.claude/commands/review.md': '---\ndescription: Review a file\nargument-hint: <file>\n---\nReview $1.\n',
      'ws/.agents/commands/ship.md': 'Ship it now, carefully and with a changelog entry for every package touched.\n',
      'ws/.claude/commands/notes.txt': 'not a command',
      'ws/.claude/skills/add-i18n/SKILL.md': skill('add-i18n', 'Add a locale', 'argument-hint: <locale>\n'),
      'ws/.agents/skills/no-description/SKILL.md': '---\nname: no-description\n---\nbody',
      'home/commands/review.md': '---\ndescription: Global review\n---\nGlobal.',
      'home/commands/standup.md': '---\ndescription: Write a standup\n---\nStandup for $ARGUMENTS.',
      'home/skills/add-i18n/SKILL.md': skill('add-i18n', 'Global locale skill'),
      'home/skills/tidy/SKILL.md': skill('tidy', 'Tidy the repo'),
    });

    const commands = await loadCommands(workspace, home);

    expect(commands.slice(0, 8).map((c) => c.name)).toEqual(['new', 'history', 'mode', 'model', 'clear', 'rules', 'memory', 'init']);
    expect(summary(commands)).toEqual([
      'prompt ship workspace: Ship it now, carefully and with a changelog entry for every ...',
      'prompt review workspace: Review a file',
      'skill add-i18n workspace: Add a locale',
      'prompt standup global: Write a standup',
      'skill tidy global: Tidy the repo',
    ]);
    expect(commands.find((c) => c.name === 'review')).toMatchObject({ hint: '<file>', path: '.claude/commands/review.md', template: 'Review $1.' });
    expect(commands.find((c) => c.name === 'add-i18n')).toMatchObject({ hint: '<locale>', text: skill('add-i18n', 'Add a locale', 'argument-hint: <locale>\n') });
    expect(commands.find((c) => c.name === 'tidy')).toMatchObject({ path: path.join(home, 'skills', 'tidy', 'SKILL.md') });
  });

  it('never lets a file shadow a built-in', async () => {
    const { workspace, home } = await tree({ 'ws/.claude/commands/new.md': 'Pretend to be new.' });
    expect((await loadCommands(workspace, home)).filter((c) => c.name === 'new')).toEqual([expect.objectContaining({ kind: 'builtin' })]);
  });

  it('lists each command for ACP with its description, its input hint, and whether a built-in is the editor\'s to run', async () => {
    const { workspace, home } = await tree({ 'ws/.claude/commands/review.md': '---\ndescription: Review a file\nargument-hint: <file>\n---\nReview $1.' });
    const listed = availableCommands(await loadCommands(workspace, home));
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
    const stop = watchCommands(workspace, home, () => calls++, 50);
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
      '/rules               built-in, engine    Show the project rules',
      '/memory              built-in, engine    Show what Geno remembers',
      '/init                built-in, engine    Create or update AGENTS.md for this project',
      '/review <file>       .claude/commands/review.md    Review a file',
      `/tidy                ${path.join(home, 'skills', 'tidy', 'SKILL.md')}    Tidy the repo`,
    ]);
  });
});
