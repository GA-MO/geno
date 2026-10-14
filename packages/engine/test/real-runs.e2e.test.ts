import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { asSessionId, type TurnEvent } from '@g-code/core';
import { readSessionLog, sessionFile } from '../src/sessions.js';
import { openStore } from '../src/store.js';
import { fakeModel, RECORDINGS } from './fake-model.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand, runCli } from './helpers.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

/** What a recording made by scripts/run-to-recording.ts says about the run it came from. */
type RecordedRun = { readonly source: string; readonly mode: string; readonly prompts: readonly string[]; readonly files: Readonly<Record<string, string>> };

type Call = { readonly name: string; readonly input: Record<string, unknown>; readonly status: string | undefined; readonly seq: number };

const callsOf = (events: readonly TurnEvent[]): Call[] => {
  const results = new Map(events.flatMap((e) => (e.kind === 'tool-result' ? [[e.toolUseId, e] as const] : [])));
  return events.flatMap((e) =>
    e.kind === 'assistant'
      ? e.content.flatMap((b) => (b.type === 'tool_use' ? [{ name: b.name, input: b.input as Record<string, unknown>, status: results.get(b.id)?.status, seq: e.seq }] : []))
      : [],
  );
};

/** The workspace's change against its first commit, untracked files included, as the campaign archived it. */
function diffOf(workspace: string): string {
  const index = path.join(tmpdir(), `real-runs-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  rmSync(index, { force: true });
  const root = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();
  execFileSync('git', ['add', '-A'], { cwd: workspace, env });
  const diff = execFileSync('git', ['diff', '--cached', root], { cwd: workspace, env, encoding: 'utf8' });
  rmSync(index, { force: true });
  return diff;
}

const archived = (source: string, file: string): string => readFileSync(path.join(REPO, source, file), 'utf8');

/**
 * Runs the real engine through each prompt of an archived real-model run, with the model's answers replayed by turn
 * from `recordings/real/<name>.json`, in a fresh copy of the workspace the run started from.
 */
async function replay(name: string) {
  const recorded = JSON.parse(readFileSync(path.join(RECORDINGS, 'real', `${name}.json`), 'utf8')) as { run: RecordedRun };
  const { run } = recorded;
  const workspace = await realpath(makeRepo('repo', [{ message: 'Initial commit', files: run.files }]));
  const home = await mkdtemp(path.join(tmpdir(), 'gcode-home-'));
  const env = {
    GCODE_HOME: home,
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    GCODE_PROVIDER: 'modelstudio',
    GCODE_MODEL: 'qwen3.8-flash',
    DASHSCOPE_API_KEY: 'sk-fake',
    DASHSCOPE_BASE_URL: 'https://ws-1.example.com/apps/anthropic',
    GCODE_RG: rgCommand(),
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  };
  const model = fakeModel({ recording: `real/${name}` });
  const questions: string[] = [];
  const mode = run.mode === 'non-interactive' ? ['--non-interactive'] : ['--mode', run.mode];
  let session: string | undefined;
  for (const prompt of run.prompts) {
    const args = ['agent', ...(session === undefined ? ['--workspace', workspace] : ['--session', session]), ...mode, '--max-turns', '40', prompt];
    const ran = await runCli(args, env, { cwd: workspace, fetch: model.fetch, confirm: (question) => (questions.push(question), true) });
    expect(model.misses, 'every request has a recorded turn').toEqual([]);
    expect(ran.code, ran.stderr).toBe(0);
    session ??= /^session: (\S+)$/m.exec(ran.stdout)?.[1];
  }
  const store = openStore(env);
  const logOf = async (id: string) => (await readSessionLog(sessionFile(store, asSessionId(id)))).events;
  const events = await logOf(session!);
  const children = await Promise.all(events.flatMap((e) => (e.kind === 'child-start' ? [logOf(e.child)] : [])));
  return { run, workspace, events, calls: callsOf(events), children, questions, diff: diffOf(workspace) };
}

/** Each file an edit changed was read earlier in the same conversation. */
function readBeforeEdit(calls: readonly Call[]): void {
  for (const [i, edit] of calls.entries()) {
    if (edit.name !== 'edit') continue;
    expect(calls.slice(0, i).some((c) => c.name === 'read' && c.input['path'] === edit.input['path']), `${String(edit.input['path'])} read before its edit`).toBe(true);
  }
}

describe('real-model runs, replayed through the engine', () => {
  it('A13: reads the stub and its test, implements it in one edit, runs the test, and leaves the archived diff', async () => {
    const { run, calls, diff } = await replay('A13-fail-then-fix');
    expect(calls.map((c) => c.name)).toEqual(['read', 'read', 'edit', 'bash']);
    expect(calls.slice(0, 2).map((c) => c.input['path'])).toEqual(['src/duration.ts', 'test/duration.test.ts']);
    readBeforeEdit(calls);
    expect(calls.every((c) => c.status === 'ok'), calls.map((c) => `${c.name}:${c.status}`).join(' ')).toBe(true);
    expect(diff).toBe(archived(run.source, 'diff.patch'));
  });

  it('A06: answers a question about the repository with read, list and glob in one turn, and changes nothing', async () => {
    const { calls, diff } = await replay('A06-read-not-cat');
    expect(calls.map((c) => c.name)).toEqual(['read', 'list', 'glob']);
    expect(new Set(calls.map((c) => c.seq)).size, 'the three calls go out in one turn').toBe(1);
    expect(diff).toBe('');
  });

  it('A10: in Plan, searches and reads, runs only read-only commands, keeps a todo list, and edits nothing', async () => {
    const { events, calls, diff } = await replay('A10-plan-mode');
    expect(calls.map((c) => c.name)).toEqual(['grep', 'read', 'read', 'bash', 'bash', 'list', 'todo']);
    expect(calls.every((c) => c.status === 'ok'), calls.map((c) => `${c.name}:${c.status}`).join(' ')).toBe(true);
    const todo = events.flatMap((e) => (e.kind === 'tool-result' && e.name === 'todo' && e.todo !== undefined ? [e.todo] : []));
    expect(todo, 'one todo update, every item pending').toHaveLength(1);
    expect(todo[0]!.map((item) => item.status)).toEqual(todo[0]!.map(() => 'pending'));
    expect(todo[0]!.map((item) => item.text).join('\n')).toMatch(/src\/money\.ts/);
    expect(diff).toBe('');
  });

  it('A02: a Thai prompt; reads slug.ts and its test before the one edit, then the test passes and the diff matches', async () => {
    const { run, calls, diff, workspace } = await replay('A02-thai-fix');
    expect(run.prompts[0]).toMatch(/[฀-๿]/);
    expect(calls.map((c) => c.name)).toEqual(['grep', 'list', 'read', 'read', 'bash', 'edit', 'bash']);
    readBeforeEdit(calls);
    expect(diff).toBe(archived(run.source, 'diff.patch'));
    expect(() => execFileSync('node', ['--test', 'test/slug.test.ts'], { cwd: workspace, stdio: 'pipe' })).not.toThrow();
  });

  it('A11: an explore subagent capped at its turn limit, a retried one that reports, and the parent checking with grep', async () => {
    const { events, calls, children, diff } = await replay('A11-explore-subagent');
    expect(calls.map((c) => c.name)).toEqual(['agent', 'list', 'agent', 'glob', 'grep', 'grep']);
    const ends = events.flatMap((e) => (e.kind === 'child-end' ? [e.end.kind] : []));
    expect(ends).toEqual(['capped', 'done']);
    expect(children.map((log) => callsOf(log).map((c) => c.name))).toEqual([
      ['grep', 'grep', 'list', 'read', 'read', 'read', 'list', 'read', 'read'],
      ['grep', 'report'],
    ]);
    expect(diff).toBe('');
  });

  it('B01: in Ask, looks before it deletes, asks once for rm -rf build (its ls -d check runs after the delete, so it is not refused), and the folder is gone after the allow', async () => {
    const { calls, questions, workspace } = await replay('B01-ask-allow');
    expect(calls.map((c) => c.name)).toEqual(['bash', 'bash', 'bash', 'bash']);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain('rm -rf build');
    const asked = calls.findIndex((c) => String(c.input['command']).includes('rm -rf build'));
    expect(asked, 'two looks come before the delete').toBe(2);
    expect(existsSync(path.join(workspace, 'build'))).toBe(false);
    expect(existsSync(path.join(workspace, 'dist')), 'nothing else is deleted').toBe(true);
  });
});
