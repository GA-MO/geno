import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HookEntry, HookOrigin } from '@g-code/core';
import { loadHookConfig, runnableEntries } from '../src/hook-config.js';
import { hookRunner } from '../src/hooks.js';
import { loadPlugins } from '../src/plugins.js';
import { openSandbox, sandboxPolicy } from '../src/sandbox.js';
import { openStore } from '../src/store.js';

async function tree(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-hooks-')));
  for (const dir of ['ws', 'home', 'app', 'claude']) await mkdir(path.join(root, dir), { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return root;
}

async function installKit(root: string): Promise<void> {
  await mkdir(path.join(root, 'claude/plugins'), { recursive: true });
  await writeFile(path.join(root, 'claude/plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'kit@market': [{ scope: 'user', installPath: path.join(root, 'cache/kit') }] } }));
}

const hooksOf = (event: string, command: string, extra: object = {}) => JSON.stringify({ hooks: { [event]: [{ ...extra, hooks: [{ type: 'command', command }] }] } });

describe('loadHookConfig', () => {
  it("reads every source, the user's own first, with a plugin's root on its hooks", async () => {
    const root = await tree({
      'app/settings.json': hooksOf('SessionStart', 'geno-user'),
      'claude/settings.json': hooksOf('SessionStart', 'claude-user'),
      'cache/kit/hooks/hooks.json': hooksOf('SessionStart', '"${CLAUDE_PLUGIN_ROOT}/start.sh"', { matcher: 'startup|resume|clear|compact' }),
      'ws/.gcode.json': hooksOf('SessionStart', 'geno-project'),
      'ws/.claude/settings.json': hooksOf('SessionStart', 'claude-project'),
      'ws/.claude/settings.local.json': hooksOf('SessionEnd', 'claude-local'),
    });
    await installKit(root);
    const workspace = path.join(root, 'ws');
    const { plugins } = await loadPlugins(path.join(root, 'claude'), workspace);
    const config = await loadHookConfig({ claudeDir: path.join(root, 'claude'), appHome: path.join(root, 'app'), workspace, plugins });
    expect(config.problems).toEqual([]);
    expect(config.entries.map((e) => [e.command, e.origin.scope, e.origin.file])).toEqual([
      ['geno-user', 'user', path.join(root, 'app/settings.json')],
      ['claude-user', 'user', path.join(root, 'claude/settings.json')],
      ['"${CLAUDE_PLUGIN_ROOT}/start.sh"', 'user', path.join(root, 'cache/kit/hooks/hooks.json')],
      ['geno-project', 'project', path.join(workspace, '.gcode.json')],
      ['claude-project', 'project', path.join(workspace, '.claude/settings.json')],
      ['claude-local', 'project', path.join(workspace, '.claude/settings.local.json')],
    ]);
    expect(config.entries[2]!.origin.plugin).toEqual({ name: 'kit', root: path.join(root, 'cache/kit') });
  });

  it('skips the hooks of a plugin turned off in enabledPlugins, and reports a broken file without dropping the rest', async () => {
    const root = await tree({
      'claude/settings.json': JSON.stringify({ enabledPlugins: { 'kit@market': false } }),
      'cache/kit/hooks/hooks.json': hooksOf('SessionStart', 'kit'),
      'ws/.claude/settings.json': '{ "hooks": ',
      'ws/.gcode.json': hooksOf('SessionStart', 'geno-project'),
    });
    await installKit(root);
    const workspace = path.join(root, 'ws');
    const { plugins } = await loadPlugins(path.join(root, 'claude'), workspace);
    expect(plugins.map((p) => p.name)).toEqual(['kit']);
    const config = await loadHookConfig({ claudeDir: path.join(root, 'claude'), appHome: path.join(root, 'app'), workspace, plugins });
    expect(config.entries.map((e) => e.command)).toEqual(['geno-project']);
    expect(config.problems).toEqual([{ severity: 'warning', text: expect.stringContaining(`${path.join(workspace, '.claude/settings.json')} is not valid JSON`) }]);
  });

  it('runs project hooks only in a trusted workspace', () => {
    const at = (scope: 'user' | 'project'): HookEntry => ({ event: 'SessionStart', matcher: undefined, command: scope, timeoutSec: undefined, origin: { file: `/${scope}`, scope } });
    expect(runnableEntries([at('user'), at('project')], false).map((e) => e.command)).toEqual(['user']);
    expect(runnableEntries([at('user'), at('project')], true).map((e) => e.command)).toEqual(['user', 'project']);
  });
});

describe('hookRunner', () => {
  async function setup(entries: (origin: { user: HookOrigin; project: HookOrigin }) => readonly HookEntry[]) {
    const root = await tree({});
    const workspace = path.join(root, 'ws');
    const home = path.join(root, 'home');
    const store = openStore({ GCODE_HOME: path.join(root, 'app') });
    const user: HookOrigin = { file: path.join(home, '.claude/settings.json'), scope: 'user' };
    const project: HookOrigin = { file: path.join(workspace, '.claude/settings.json'), scope: 'project' };
    const runner = hookRunner({
      entries: entries({ user, project }),
      session: { id: 's-1', transcriptPath: path.join(root, 'app/sessions/s-1.jsonl') },
      workspace,
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home, DASHSCOPE_API_KEY: 'sk-secret' },
      sandbox: async () => openSandbox(await sandboxPolicy({ store, home, workspace, tempDir: path.join(root, 'app') })),
    });
    return { root, workspace, home, runner };
  }
  const at = (origin: HookOrigin, command: string, over: Partial<HookEntry> = {}): HookEntry => ({ event: 'SessionStart', matcher: undefined, command, timeoutSec: undefined, origin, ...over });

  it('B/B-94 gives the hook the common payload on stdin, and the project dir, but no API key, in its env', async () => {
    const out = await tree({});
    const payload = path.join(out, 'payload.json');
    const env = path.join(out, 'env.txt');
    const { workspace, runner } = await setup(({ user }) => [at(user, `cat > '${payload}'; env > '${env}'`)]);
    const [result] = await runner.run('SessionStart', { source: 'startup' }, 'default');
    expect(result!.outcome).toEqual({ kind: 'ok', code: 0, notes: [] });
    expect(JSON.parse(await readFile(payload, 'utf8'))).toEqual({
      session_id: 's-1',
      transcript_path: expect.stringMatching(/s-1\.jsonl$/),
      cwd: workspace,
      permission_mode: 'default',
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    const seen = await readFile(env, 'utf8');
    expect(seen).toContain(`CLAUDE_PROJECT_DIR=${workspace}`);
    expect(seen).not.toContain('sk-secret');
  });

  it('T-HOOK-09 runs matching hooks in parallel, and an identical handler once', async () => {
    const log = path.join(await tree({}), 'log.txt');
    const { runner } = await setup(({ user, project }) => [at(user, `sleep 1; echo a >> '${log}'`), at(user, `sleep 1; echo b >> '${log}'`), at(project, `sleep 1; echo a >> '${log}'`)]);
    const started = performance.now();
    const results = await runner.run('SessionStart', { source: 'startup' }, 'default');
    const ms = performance.now() - started;
    expect(results).toHaveLength(2);
    expect((await readFile(log, 'utf8')).split('\n').filter(Boolean).toSorted()).toEqual(['a', 'b']);
    expect(ms, 'two 1 s hooks run at once').toBeLessThan(1900);
  });

  it('T-HOOK-11 kills a hook at its timeout, and a slow hook does not hold up the others past it', async () => {
    const { runner } = await setup(({ user }) => [at(user, 'sleep 30', { timeoutSec: 1 }), at(user, 'echo fast')]);
    const started = performance.now();
    const results = await runner.run('SessionStart', { source: 'startup' }, 'default');
    expect(performance.now() - started).toBeLessThan(5000);
    expect(results.map((r) => r.outcome)).toEqual([
      { kind: 'error', code: null, message: 'timed out after 1 s and was killed' },
      { kind: 'ok', code: 0, notes: [{ how: 'success', text: 'fast' }] },
    ]);
  });

  it('runs a plugin hook with CLAUDE_PLUGIN_ROOT set to its folder', async () => {
    const pluginRoot = await tree({ 'start.sh': '#!/bin/sh\necho "from $CLAUDE_PLUGIN_ROOT"\n' });
    const { runner } = await setup(({ user }) => [at({ ...user, plugin: { name: 'kit', root: pluginRoot } }, 'sh "${CLAUDE_PLUGIN_ROOT}/start.sh"')]);
    const [result] = await runner.run('SessionStart', { source: 'startup' }, 'default');
    expect(result!.outcome).toEqual({ kind: 'ok', code: 0, notes: [{ how: 'success', text: `from ${pluginRoot}` }] });
  });

  it('runs a project hook inside the sandbox, which cannot write outside the workspace, and a user hook as the user', async () => {
    const { home, workspace, runner } = await setup(({ user, project }) => [at(project, 'echo inside > in-workspace.txt; echo project > "$HOME/project.txt"'), at(user, 'echo user > "$HOME/user.txt"')]);
    const results = await runner.run('SessionStart', { source: 'startup' }, 'default');
    expect(existsSync(path.join(workspace, 'in-workspace.txt')), 'the workspace is writable').toBe(true);
    expect(results[0]!.outcome.kind).toBe('error');
    expect(existsSync(path.join(home, 'project.txt'))).toBe(false);
    expect(results[1]!.outcome).toEqual({ kind: 'ok', code: 0, notes: [] });
    expect(existsSync(path.join(home, 'user.txt'))).toBe(true);
  });
});
