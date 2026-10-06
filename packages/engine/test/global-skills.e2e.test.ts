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
  it('loads it, reads the files it points to, and still cannot read the rest of the home or write in the skill folder', async () => {
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
      toolCall('Reading elsewhere.', [use('read', { path: path.join(user, 'secret.txt') })], usage),
      toolCall('Writing there.', [use('edit', { path: created, create: true, new_str: 'x\n' })], usage),
      answer('Done.', usage),
    ]);
    const run = await runCli(['agent', '--workspace', workspace, '--mode', 'ask', 'Deploy with the deploy skill'], env, { fetch: transport.fetch, confirm: () => true });
    expect(run.code).toBe(0);

    const log = await readSessionLog(sessionFile(openStore(env), asSessionId(sessionIdOf(run.stdout))));
    const [, skill, steps, secret, edit] = results(log.events);
    expect(skill).toEqual({ name: 'skill', status: 'ok', output: expect.stringContaining('# Deploy\n\nRead references/steps.md first.') });
    expect(steps).toEqual({ name: 'read', status: 'ok', output: '1\tBuild, then upload.' });
    expect(secret).toMatchObject({ name: 'read', status: 'error', output: expect.stringContaining('outside the workspace') });
    expect(edit).toMatchObject({ name: 'edit', status: 'error' });
    expect(existsSync(created)).toBe(false);
  });
});
