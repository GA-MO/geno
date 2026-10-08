import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_SUBAGENT_MODELS } from '@g-code/core';
import { homesOf } from '../src/commands.js';
import { openStore } from '../src/store.js';
import { loadAgents } from '../src/subagents.js';

const agentFile = (description: string, extra = '') => `---\ndescription: ${description}\n${extra}---\nBody of ${description}.\n`;

async function write(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

describe('loadAgents', () => {
  it("takes the user's global folder, then .agents, then .claude, then plugins, then the built-ins, the first of a name winning, with a problem line for a workspace agent the user's own shadows", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-agents-')));
    const workspace = path.join(root, 'ws');
    const app = path.join(root, 'app');
    const plugin = path.join(root, 'plugin');
    await write(path.join(workspace, '.agents', 'agents', 'scout.md'), agentFile('agents scout'));
    await write(path.join(workspace, '.claude', 'agents', 'scout.md'), agentFile('claude scout'));
    await write(path.join(workspace, '.claude', 'agents', 'explore.md'), agentFile('my explore', 'tools: Read, Grep\n'));
    await write(path.join(app, 'agents', 'scout.md'), agentFile('global scout'));
    await write(path.join(app, 'agents', 'tidy.md'), agentFile('global tidy', 'color: green\n'));
    await write(path.join(app, 'agents', 'broken.md'), '---\nname: broken\n---\nno description\n');
    await write(path.join(app, 'agents', 'notes.txt'), agentFile('not markdown'));
    await write(path.join(plugin, 'agents', 'scout.md'), agentFile('plugin scout'));

    const { agents, problems } = await loadAgents(workspace, { app, user: undefined }, [{ name: 'kit', root: plugin }], NO_SUBAGENT_MODELS);

    expect(agents.map((a) => [a.name, a.source, a.description])).toEqual([
      ['claude-code', 'builtin', expect.any(String)],
      ['cursor', 'builtin', expect.any(String)],
      ['explore', 'workspace', 'my explore'],
      ['kit:scout', 'plugin', 'plugin scout'],
      ['plan', 'builtin', expect.any(String)],
      ['review', 'builtin', expect.any(String)],
      ['scout', 'global', 'global scout'],
      ['tidy', 'global', 'global tidy'],
      ['worker', 'builtin', expect.any(String)],
    ]);
    expect(agents.find((a) => a.name === 'scout')!.path).toBe(path.join(app, 'agents', 'scout.md'));
    expect(agents.find((a) => a.name === 'kit:scout')!.prompt).toBe('Body of plugin scout.');
    expect(problems).toEqual([
      `${path.join(app, 'agents', 'broken.md')}: skipped, it has no description`,
      `${path.join(app, 'agents', 'tidy.md')}: ignored color`,
      `.agents/agents/scout.md: not loaded, because your own agent scout (${path.join(app, 'agents', 'scout.md')}) has its name`,
      `.claude/agents/scout.md: not loaded, because your own agent scout (${path.join(app, 'agents', 'scout.md')}) has its name`,
    ]);
  });

  it("reads the user's Claude Code agents from $HOME/.claude/agents, after Geno's home and before the workspace", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-agents-')));
    const workspace = path.join(root, 'ws');
    const home = path.join(root, 'home');
    const env = { HOME: home, GCODE_HOME: path.join(home, '.g-code') };
    const claude = path.join(home, '.claude', 'agents');
    await write(path.join(claude, 'reviewer.md'), agentFile('claude reviewer', 'tools: Read, Grep\nmodel: inherit\n'));
    await write(path.join(claude, 'tidy.md'), agentFile('claude tidy'));
    await write(path.join(home, '.g-code', 'agents', 'tidy.md'), agentFile('geno tidy'));
    await write(path.join(workspace, '.claude', 'agents', 'reviewer.md'), agentFile('workspace reviewer'));

    const { agents, problems } = await loadAgents(workspace, homesOf(openStore(env), env), [], NO_SUBAGENT_MODELS);

    const of = (name: string) => agents.find((a) => a.name === name);
    expect(of('reviewer')).toMatchObject({ source: 'global', description: 'claude reviewer', tools: ['grep', 'read'], path: path.join(claude, 'reviewer.md') });
    expect(of('tidy')?.description, "Geno's own home wins over Claude Code's").toBe('geno tidy');
    expect(problems).toEqual([`.claude/agents/reviewer.md: not loaded, because your own agent reviewer (${path.join(claude, 'reviewer.md')}) has its name`]);
  });

  it('gives the built-ins alone when no folder exists', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-agents-')));
    const { agents, problems } = await loadAgents(path.join(root, 'ws'), { app: path.join(root, 'app'), user: undefined }, [], NO_SUBAGENT_MODELS);
    expect(agents.map((a) => a.name)).toEqual(['claude-code', 'cursor', 'explore', 'plan', 'review', 'worker']);
    expect(problems).toEqual([]);
  });
});
