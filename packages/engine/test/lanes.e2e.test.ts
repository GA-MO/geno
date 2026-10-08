import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { asSessionId, LANE_CAP, type Lane, type TurnEvent } from '@g-code/core';
import { createLane, laneRepoOf } from '../src/lanes.js';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { answer, fakeTransport, toolCall, type FakeToolUse } from './fake-transport.js';
import { makeRepo, type FixtureCommit } from './git-fixture.js';
import { rgCommand, runCli } from './helpers.js';

const usage = { input: 1000, cacheRead: 0, cacheWrite: 0 };

async function setup(files: FixtureCommit['files']) {
  const repo = await realpath(makeRepo('main', [{ message: 'start', files: { '.gitignore': 'node_modules/\n.env\n', ...files } }]));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const env = { GCODE_HOME: home, GCODE_PROVIDER: 'modelstudio', DASHSCOPE_API_KEY: 'sk-test', DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic', GCODE_RG: rgCommand(), PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home };
  const lane = (...args: string[]) => runCli(['lane', ...args, '--workspace', repo], env);
  return { repo, home, env, lane, store: openStore(env) };
}

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
const lanePath = (repo: string, name: string) => path.join(repo, '.geno', 'worktrees', name);
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const listed = async (lane: (...args: string[]) => ReturnType<typeof runCli>): Promise<Lane[]> => JSON.parse((await lane('list', '--json')).stdout);

describe('gcode lane', () => {
  it('applies the first of two lanes that edit the same line, reports the second as a conflict, and 3-way merges a third', async () => {
    const { repo, lane } = await setup({ 'a.ts': 'one\ntwo\nthree\nfour\nfive\n' });
    for (const name of ['first', 'second', 'third']) expect((await lane('new', name)).code).toBe(0);
    write(path.join(lanePath(repo, 'first'), 'a.ts'), 'one\nTWO first\nthree\nfour\nfive\n');
    write(path.join(lanePath(repo, 'first'), 'new.ts'), 'export {};\n');
    write(path.join(lanePath(repo, 'second'), 'a.ts'), 'one\nTWO second\nthree\nfour\nfive\n');
    write(path.join(lanePath(repo, 'third'), 'a.ts'), 'one\ntwo\nthree\nfour\nFIVE third\n');
    git(lanePath(repo, 'third'), 'commit', '-qam', 'committed in the lane');

    const first = await lane('apply', 'first');
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('applied: 2 files');
    expect(first.stdout).toContain('  changed a.ts (+1 -1, 1 hunk)');
    expect(first.stdout).toContain('  added new.ts (+1 -0, 1 hunk)');
    expect(readFileSync(path.join(repo, 'a.ts'), 'utf8')).toBe('one\nTWO first\nthree\nfour\nfive\n');

    const second = await lane('apply', 'second');
    expect(second.code).toBe(1);
    expect(second.stdout).toBe('conflicts: 1; nothing was applied\n  a.ts: the lane and the main checkout changed the same lines');
    expect(readFileSync(path.join(repo, 'a.ts'), 'utf8')).toBe('one\nTWO first\nthree\nfour\nfive\n');

    expect((await lane('apply', 'third')).code).toBe(0);
    expect(readFileSync(path.join(repo, 'a.ts'), 'utf8')).toBe('one\nTWO first\nthree\nfour\nFIVE third\n');

    // The apply leaves proposed changes in the working tree for review, and lanes never show as untracked files.
    expect(git(repo, 'status', '--porcelain')).toBe(' M a.ts\n?? new.ts\n');
    expect(readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('\n/.geno/\n');
    expect(git(repo, 'log', '--format=%s')).toBe('start\n');
  });

  it('never sweeps or discards a lane with edits or commits unless told to, and sweeps the clean ones', async () => {
    const { repo, lane } = await setup({ 'a.ts': 'a\n' });
    for (const name of ['clean', 'edited', 'committed', 'untracked']) expect((await lane('new', name)).code).toBe(0);
    write(path.join(lanePath(repo, 'edited'), 'a.ts'), 'b\n');
    write(path.join(lanePath(repo, 'committed'), 'a.ts'), 'c\n');
    git(lanePath(repo, 'committed'), 'commit', '-qam', 'c');
    write(path.join(lanePath(repo, 'untracked'), 'b.ts'), 'b\n');
    expect((await listed(lane)).map((l) => [l.name, l.status])).toEqual([['clean', 'clean'], ['committed', 'changed'], ['edited', 'changed'], ['untracked', 'changed']]);

    const swept = await lane('sweep');
    expect(swept.stdout).toBe('swept: clean\nkept, with changes: committed, edited, untracked');
    expect(existsSync(lanePath(repo, 'clean'))).toBe(false);
    expect(git(repo, 'branch', '--list', 'geno/*')).not.toContain('geno/clean');
    for (const name of ['committed', 'edited', 'untracked']) expect(existsSync(lanePath(repo, name))).toBe(true);

    const refused = await lane('discard', 'edited');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('lane edited has changes; apply them first, or pass --discard-changes to lose them');
    expect(readFileSync(path.join(lanePath(repo, 'edited'), 'a.ts'), 'utf8')).toBe('b\n');

    expect((await lane('discard', 'edited', '--discard-changes')).code).toBe(0);
    expect(existsSync(lanePath(repo, 'edited'))).toBe(false);
    expect(git(repo, 'branch', '--list', 'geno/edited')).toBe('');
    expect((await listed(lane)).map((l) => l.name)).toEqual(['committed', 'untracked']);
  });

  it(`refuses a lane past the cap of ${LANE_CAP}`, async () => {
    const { repo } = await setup({ 'a.ts': 'a\n' });
    const laneRepo = await laneRepoOf(repo);
    for (let i = 0; i < LANE_CAP; i++) await createLane(laneRepo, `l${i}`, 'head');
    await expect(createLane(laneRepo, 'one-more', 'head')).rejects.toThrow(`${LANE_CAP} lanes exist, the cap is ${LANE_CAP}; run gcode lane sweep`);
  });

  it('starts from main when asked, while the main checkout is on another branch', async () => {
    const { repo, lane } = await setup({ 'a.ts': 'a\n' });
    git(repo, 'checkout', '-qb', 'feature');
    write(path.join(repo, 'a.ts'), 'feature\n');
    git(repo, 'commit', '-qam', 'feature');
    expect((await lane('new', 'from-main', '--from', 'main')).code).toBe(0);
    expect((await lane('new', 'from-head')).code).toBe(0);
    expect(readFileSync(path.join(lanePath(repo, 'from-main'), 'a.ts'), 'utf8')).toBe('a\n');
    expect(readFileSync(path.join(lanePath(repo, 'from-head'), 'a.ts'), 'utf8')).toBe('feature\n');
    expect((await lane('new', 'a..b')).stderr).toContain('a..b is not a lane name');
  });

  it('copies .worktreeinclude files, clones node_modules copy-on-write, and runs setup only after a per-repository approval', async () => {
    const { repo, home, lane } = await setup({
      'a.ts': 'a\n',
      '.worktreeinclude': '.env\nsecret.txt\n',
      'secret.txt': 'tracked, so never copied over the lane\'s own\n',
      'package.json': '{}\n',
      '.gcode.json': JSON.stringify({ laneSetup: ['echo "$ROOT_WORKTREE_PATH" > setup.out'] }),
    });
    write(path.join(repo, '.env'), 'TOKEN=local\n');
    write(path.join(repo, 'node_modules', '.pnpm', 'dep@1.0.0', 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
    symlinkSync(path.join('.pnpm', 'dep@1.0.0', 'node_modules', 'dep'), path.join(repo, 'node_modules', 'dep'));

    const first = await lane('new', 'a');
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('copied: .env from .worktreeinclude');
    expect(readFileSync(path.join(lanePath(repo, 'a'), '.env'), 'utf8')).toBe('TOKEN=local\n');
    if (process.platform === 'darwin') {
      expect(first.stdout).toMatch(/node_modules: cloned 1 folder copy-on-write in \d+\.\ds/);
      expect(readlinkSync(path.join(lanePath(repo, 'a'), 'node_modules', 'dep'))).toBe(path.join('.pnpm', 'dep@1.0.0', 'node_modules', 'dep'));
      expect(readFileSync(path.join(lanePath(repo, 'a'), 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
    }
    expect(first.stdout).toContain('setup: not run; approve the commands in .gcode.json with --approve-setup');
    expect(existsSync(path.join(lanePath(repo, 'a'), 'setup.out'))).toBe(false);
    expect((await listed(lane))[0]!.status).toBe('clean');

    const approved = await lane('new', 'b', '--approve-setup');
    expect(approved.stdout).toContain('setup: ran 1 command from .gcode.json');
    expect(readFileSync(path.join(lanePath(repo, 'b'), 'setup.out'), 'utf8')).toBe(`${repo}\n`);
    const approvals = JSON.parse(readFileSync(path.join(home, 'lane-setup-approvals.json'), 'utf8'));
    expect(approvals.approvals).toMatchObject([{ repo, commands: ['echo "$ROOT_WORKTREE_PATH" > setup.out'] }]);

    expect((await lane('new', 'c')).stdout).toContain('setup: ran 1 command');
    write(path.join(repo, '.gcode.json'), JSON.stringify({ laneSetup: ['touch changed.out'] }));
    expect((await lane('new', 'd')).stdout).toContain('setup: not run');
    expect(existsSync(path.join(lanePath(repo, 'd'), 'changed.out'))).toBe(false);
  });

  it('reads setup commands from .cursor/worktrees.json', async () => {
    const { repo, lane } = await setup({ 'a.ts': 'a\n', '.cursor/worktrees.json': JSON.stringify({ 'setup-worktree': ['touch cursor.out'] }) });
    expect((await lane('new', 'a', '--approve-setup')).stdout).toContain('setup: ran 1 command from .cursor/worktrees.json');
    expect(existsSync(path.join(lanePath(repo, 'a'), 'cursor.out'))).toBe(true);
  });

  it("B/B-122 runs the user's LaneCreated hook in the new lane after its setup, and never a workspace's own", async () => {
    const { repo, home, lane } = await setup({
      'a.ts': 'a\n',
      '.claude/settings.json': JSON.stringify({ hooks: { LaneCreated: [{ hooks: [{ type: 'command', command: 'touch from-the-repo.out' }] }] } }),
    });
    const payloads = path.join(home, 'lane-created.jsonl');
    // As a pnpm install would: it runs in the lane, and finds the files the setup put there.
    const install = `cat >> '${payloads}' && echo >> '${payloads}' && ls -a > installed.out && echo 'installed' >&2`;
    write(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { LaneCreated: [{ hooks: [{ type: 'command', command: install }] }] } }));

    const created = await lane('new', 'feature');
    expect(created.code).toBe(0);
    const at = lanePath(repo, 'feature');
    const [payload] = readFileSync(payloads, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(payload).toEqual({
      cwd: await realpath(at),
      hook_event_name: 'LaneCreated',
      name: 'feature',
      worktree_path: await realpath(at),
      branch: 'geno/feature',
      base_commit: git(repo, 'rev-parse', 'HEAD').trim(),
      main_checkout: repo,
    });
    expect(readFileSync(path.join(at, 'installed.out'), 'utf8')).toContain('a.ts');
    expect(existsSync(path.join(at, 'from-the-repo.out')), "the repository's own hook does not run").toBe(false);
    expect((await listed(lane))[0]!.status, 'a file the hook leaves that git does not ignore counts as a change').toBe('changed');
  });

  it('reports a LaneCreated hook that fails, and keeps the lane', async () => {
    const { repo, home, lane } = await setup({ 'a.ts': 'a\n' });
    write(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { LaneCreated: [{ hooks: [{ type: 'command', command: 'echo "no network" >&2; exit 1' }] }] } }));
    const created = await lane('new', 'feature');
    expect(created.code).toBe(0);
    expect(created.stderr).toMatch(/LaneCreated hook error: .*exit code 1: no network/);
    expect(existsSync(lanePath(repo, 'feature'))).toBe(true);
  });
});

let nextId = 0;
const use = (name: string, input: unknown): FakeToolUse => ({ id: `lane_${nextId++}`, name, input });
const ofKind = <K extends TurnEvent['kind']>(events: readonly TurnEvent[], kind: K) => events.filter((e): e is Extract<TurnEvent, { kind: K }> => e.kind === kind);
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

describe('a session in a lane', () => {
  it('edits and runs commands in the lane while the main checkout stays untouched, and is bound to the lane', async () => {
    const { repo, env, lane, store } = await setup({ 'a.ts': 'export const a = 1;\n' });
    expect((await lane('new', 'work')).code).toBe(0);
    const work = lanePath(repo, 'work');
    const marker = sha256(path.join(repo, 'a.ts'));
    const escapes = [
      'echo pwned > ../../../marker',
      `echo pwned > ${repo}/marker`,
      'cd .. && touch marker',
      'git -C ../../.. commit --allow-empty -qm pwned',
      `GIT_DIR=${repo}/.git GIT_WORK_TREE=${repo} git commit --allow-empty -qm pwned`,
      `git --git-dir=${repo}/.git log`,
    ];
    // A path built at run time passes the text check; the sandbox, which writes only to the lane, still refuses it.
    const runtime = 'ln -s "$(printf "%s%s/%s%s/%s%s" . . . . . .)" up && echo pwned > up/marker';
    const transport = fakeTransport([
      toolCall('Reading.', [use('read', { path: 'a.ts' })], usage),
      toolCall('Editing.', [use('edit', { path: 'a.ts', old_str: 'a = 1', new_str: 'a = 2' })], usage),
      toolCall('Escaping by edit.', [use('edit', { path: '../../../a.ts', old_str: 'a = 1', new_str: 'a = 3' }), use('edit', { path: path.join(repo, 'marker'), create: true, new_str: 'x' })], usage),
      ...escapes.map((command) => toolCall('Escaping.', [use('bash', { command })], usage)),
      toolCall('Escaping at run time.', [use('bash', { command: runtime })], usage),
      toolCall('Working.', [use('bash', { command: 'echo ok > note.txt && git add note.txt && git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false commit -qm lane-work && echo committed' })], usage),
      answer('Done.', usage),
    ]);
    const result = await runCli(['agent', '--workspace', work, '--mode', 'ask', '--no-mcp', '--no-check-after-edit', 'Do the work'], env, { fetch: transport.fetch, confirm: () => true });
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);

    const id = /^session: (\S+)$/m.exec(result.stdout)![1]!;
    const results = ofKind((await readSessionLog(sessionFile(store, asSessionId(id)))).events, 'tool-result').map((r) => ({ status: r.status, output: 'output' in r ? String(r.output) : '' }));
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok', 'error', 'error', ...escapes.map(() => 'error'), 'error', 'ok']);
    expect(results[2]!.output).toContain('../../../a.ts is outside the workspace');
    expect(results[3]!.output).toContain('is outside the workspace');
    expect(results.slice(4, 4 + escapes.length).map((r) => /the command (.+?) \(/.exec(r.output)?.[1])).toEqual([
      'names a path in the main checkout',
      'names a path in the main checkout',
      'changes to a folder outside the lane, or one that cannot be known before it runs',
      'points git -C outside the lane',
      'redirects git with GIT_DIR, GIT_WORK_TREE or a variable like them',
      'points git at another checkout with --git-dir, --work-tree or core.worktree',
    ]);
    expect(results[4 + escapes.length]!.output).toMatch(/not permitted/i);
    // The sandbox lets the lane's git write its own commits into the git folder it shares with the main checkout.
    expect(results.at(-1)!.output).toContain('committed');
    expect(git(work, 'log', '--format=%s')).toBe('lane-work\nstart\n');

    expect(sha256(path.join(repo, 'a.ts'))).toBe(marker);
    expect(existsSync(path.join(repo, 'marker'))).toBe(false);
    expect(existsSync(path.join(repo, '.geno', 'marker'))).toBe(false);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(git(repo, 'log', '--format=%s')).toBe('start\n');
    expect(readFileSync(path.join(work, 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(readFileSync(path.join(work, 'note.txt'), 'utf8')).toBe('ok\n');
    expect((await listed(lane))[0]).toMatchObject({ name: 'work', session: id, status: 'changed' });
  });
});
