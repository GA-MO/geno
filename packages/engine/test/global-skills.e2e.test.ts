import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { asSessionId, toolResultText, type TurnEvent } from '@g-code/core';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, loadTools, toolCall, type FakeToolUse } from './fake-transport.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand, runCli } from './helpers.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };
const DEPLOY = '---\nname: deploy\ndescription: Deploy the site\n---\n# Deploy\n\nRead references/steps.md first.\n';

const sessionIdOf = (stdout: string): string => /^session: (\S+)$/m.exec(stdout)![1]!;
let nextId = 0;
const use = (name: string, input: unknown): FakeToolUse => ({ id: `tu_${nextId++}`, name, input });
const results = (events: readonly TurnEvent[]) =>
  events.flatMap((e) => (e.kind === 'tool-result' ? [{ name: e.name, status: e.status, output: toolResultText(e) }] : []));

describe('a skill in ~/.agents/skills through gcode agent', () => {
  it('loads it, reads the files it points to, and still asks before reading the rest of the home and cannot write in the skill folder', async () => {
    const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'export const a = 1;\n' } }]));
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-global-skills-')));
    const user = path.join(root, 'user');
    const folder = path.join(user, '.agents', 'skills', 'deploy');
    await mkdir(path.join(folder, 'references'), { recursive: true });
    await writeFile(path.join(folder, 'SKILL.md'), DEPLOY);
    await writeFile(path.join(folder, 'references', 'steps.md'), 'Build, then upload.\n');
    await writeFile(path.join(user, 'secret.txt'), 'not for the model\n');
    const env = {
      HOME: user,
      GCODE_HOME: path.join(root, 'gcode-home'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      GCODE_PROVIDER: 'modelstudio',
      DASHSCOPE_API_KEY: 'sk-fake',
      DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
      GCODE_RG: rgCommand(),
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    };
    const created = path.join(folder, 'created.md');
    const transport = fakeTransport([
      toolCall('', [loadTools('skill')], usage),
      toolCall('Loading the skill.', [use('skill', { name: 'deploy' })], usage),
      toolCall('Reading its steps.', [use('read', { path: path.join(folder, 'references', 'steps.md') })], usage),
      toolCall('Writing there.', [use('edit', { path: created, create: true, new_str: 'x\n' })], usage),
      toolCall('Reading elsewhere.', [use('read', { path: path.join(user, 'secret.txt') })], usage),
      answer('Done.', usage),
    ]);
    const asked: string[] = [];
    const confirm = (question: string) => {
      asked.push(question);
      return false;
    };
    const run = await runCli(['agent', '--workspace', workspace, '--mode', 'ask', 'Deploy with the deploy skill'], env, { fetch: transport.fetch, confirm });
    expect(run.code).toBe(0);

    const log = await readSessionLog(sessionFile(openStore(env), asSessionId(sessionIdOf(run.stdout))));
    const [, skill, steps, edit, secret] = results(log.events);
    expect(skill).toEqual({ name: 'skill', status: 'ok', output: expect.stringContaining('# Deploy\n\nRead references/steps.md first.') });
    expect(steps).toEqual({ name: 'read', status: 'ok', output: '1\tBuild, then upload.' });
    expect(asked).toEqual([`Allow \`read ${path.join(user, 'secret.txt')}\`? It uses a path outside the workspace.`]);
    expect(secret).toMatchObject({ name: 'read', status: 'rejected' });
    expect(JSON.stringify(log.events)).not.toContain('not for the model');
    expect(edit).toMatchObject({ name: 'edit', status: 'error' });
    expect(existsSync(created)).toBe(false);
  });

  it('G-06 returns a skill longer than the spill limit whole, not as a spill file', async () => {
    const workspace = await realpath(makeRepo('ws', [{ message: 'start', files: { 'a.ts': 'export const a = 1;\n' } }]));
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-global-skills-')));
    const folder = path.join(root, 'user', '.agents', 'skills', 'deploy');
    await mkdir(folder, { recursive: true });
    const steps = Array.from({ length: 600 }, (_, i) => `${i + 1}. Check step ${i + 1} of the deploy before the next one.`).join('\n');
    await writeFile(path.join(folder, 'SKILL.md'), `${DEPLOY}\n${steps}\nLast line of the skill.\n`);
    const env = {
      HOME: path.join(root, 'user'),
      GCODE_HOME: path.join(root, 'gcode-home'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      GCODE_PROVIDER: 'modelstudio',
      DASHSCOPE_API_KEY: 'sk-fake',
      DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
      GCODE_RG: rgCommand(),
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    };
    const transport = fakeTransport([toolCall('', [loadTools('skill')], usage), toolCall('Loading the skill.', [use('skill', { name: 'deploy' })], usage), answer('Done.', usage)]);
    const run = await runCli(['agent', '--workspace', workspace, '--non-interactive', 'Deploy with the deploy skill'], env, { fetch: transport.fetch });
    expect(run.code, run.stderr).toBe(0);
    const log = await readSessionLog(sessionFile(openStore(env), asSessionId(sessionIdOf(run.stdout))));
    const loaded = log.events.find((e): e is Extract<TurnEvent, { kind: 'tool-result' }> => e.kind === 'tool-result' && e.name === 'skill')!;
    expect(steps.length).toBeGreaterThan(24_000);
    expect('spill' in loaded, 'no spill file').toBe(false);
    expect(toolResultText(loaded)).toContain('Last line of the skill.');
  });
});
