import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_MODE_SYSTEM_PROMPTS, asSessionId, toolResultText, type TurnEvent } from '@g-code/core';
import { GENO_TOOLS } from '../src/geno-tools.generated.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, toolCall, type FakeToolUse } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand, runCli } from './helpers.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const HOW = '---\nname: how\ndescription: Explain how a subsystem works\n---\n# How\n\nRead references/explorer.md first.\n';

async function setup(pluginName: string) {
  const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'export const a = 1;\n' } }]));
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-plugins-e2e-')));
  const pluginRoot = path.join(root, 'cache', pluginName);
  const write = async (file: string, text: string) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  };
  await write(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: pluginName }));
  await write(path.join(pluginRoot, 'skills', 'how', 'SKILL.md'), HOW);
  await write(path.join(pluginRoot, 'skills', 'how', 'references', 'explorer.md'), 'Explore with grep.\n');
  await write(
    path.join(root, 'claude', 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { [`${pluginName}@market`]: [{ scope: 'user', installPath: pluginRoot }] } }),
  );
  const home = path.join(root, 'gcode-home');
  const env = {
    GCODE_HOME: home,
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    GCODE_PROVIDER: 'modelstudio',
    DASHSCOPE_API_KEY: 'sk-fake',
    DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
    GCODE_RG: rgCommand(),
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  };
  return { workspace, env, home, pluginRoot, store: openStore(env) };
}

const sessionIdOf = (stdout: string): string => /^session: (\S+)$/m.exec(stdout)![1]!;
let nextId = 0;
const use = (name: string, input: unknown): FakeToolUse => ({ id: `tu_${nextId++}`, name, input });
const results = (events: readonly TurnEvent[]) =>
  events.flatMap((e) => (e.kind === 'tool-result' ? [{ name: e.name, status: e.status, output: toolResultText(e) }] : []));

describe('pstack through gcode agent', () => {
  it('loads a plugin skill with the skill tool, reads its folder, and cannot write there even when the user allows the command', async () => {
    const { workspace, env, home, pluginRoot, store } = await setup('pstack');
    const escaped = path.join(pluginRoot, 'escaped.txt');
    const transport = fakeTransport([
      toolCall('Loading the skill.', [use('skill', { name: 'pstack:how' })], usage),
      toolCall('Reading its reference.', [use('read', { path: path.join(pluginRoot, 'skills', 'how', 'references', 'explorer.md') })], usage),
      toolCall('Writing there.', [use('bash', { command: `echo escaped > '${escaped}'` })], usage),
      answer('Done.', usage),
    ]);
    const run = await runCli(['agent', '--workspace', workspace, '--mode', 'ask', 'Explain a.ts with /pstack:how'], env, { fetch: transport.fetch, confirm: () => true });
    expect(run.code).toBe(0);

    const genoTools = path.join(await realpath(home), 'geno-tools.md');
    expect(await readFile(genoTools, 'utf8')).toBe(GENO_TOOLS);
    const system = transport.requests[0]!.body.system[0].text as string;
    expect(system.startsWith(AGENT_MODE_SYSTEM_PROMPTS.ask)).toBe(true);
    expect(system.slice(AGENT_MODE_SYSTEM_PROMPTS.ask.length)).toBe(
      `\n\npstack skills are installed. They are written for Claude Code; before you follow one, read ${genoTools}, which maps their tools to yours.`,
    );

    const log = await readSessionLog(sessionFile(store, asSessionId(sessionIdOf(run.stdout))));
    const [skill, read, bash] = results(log.events);
    expect(skill).toEqual({ name: 'skill', status: 'ok', output: expect.stringContaining('# How\n\nRead references/explorer.md first.') });
    expect(read).toEqual({ name: 'read', status: 'ok', output: '1\tExplore with grep.' });
    expect(bash).toMatchObject({ name: 'bash', status: 'ok', output: expect.stringMatching(/Operation not permitted[\s\S]*\[exit code 1\]/) });
    expect(existsSync(escaped)).toBe(false);
  });

  it('leaves the system prompt as it was when no pstack skill is installed', async () => {
    const { workspace, env, home } = await setup('other');
    const transport = fakeTransport([answer('Hi.', usage)]);
    expect((await runCli(['agent', '--workspace', workspace, '--non-interactive', 'Hi'], env, { fetch: transport.fetch })).code).toBe(0);
    expect(transport.requests[0]!.body.system[0].text).toBe(AGENT_MODE_SYSTEM_PROMPTS['non-interactive']);
    expect(existsSync(path.join(home, 'geno-tools.md'))).toBe(false);
  });
});
