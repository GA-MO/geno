import { mkdir, mkdtemp, realpath, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { asSessionId, SHOW_FILES_LIMITS, type Denial, type NewRule, type SessionMode, type TurnEvent } from '@g-code/core';
import { workingDirectories } from '../src/directories.js';
import { DISK_FILES } from '../src/files.js';
import { bindSession, createLane, laneRepoOf, type LaneSession } from '../src/lanes.js';
import { permissionStore } from '../src/permissions.js';
import type { Sandbox } from '../src/sandbox.js';
import { agentExecutors, NON_INTERACTIVE, type Approval, type PermissionAnswer } from '../src/tools/agent.js';
import { runTool, type ToolContext } from '../src/tools/index.js';
import { ruleAttacher } from '../src/tools/rules.js';
import { twoColorPng } from '../../core/test/png.js';
import { makeRepo } from './git-fixture.js';
import { rgCommand } from './helpers.js';

const NO_SANDBOX: Sandbox = {
  run: async () => {
    throw new Error('no command runs in this test');
  },
  wrap: async () => {
    throw new Error('no command runs in this test');
  },
  spawn: async () => {
    throw new Error('no command runs in this test');
  },
  retain: () => async () => {},
  close: async () => {},
};

const PNG = twoColorPng(4, 4, [255, 0, 0], [0, 0, 255]);

type Place = { readonly root: string; readonly workspace: string; readonly spill: string; readonly scratch: string; readonly outside: string };

async function place(workspace?: string): Promise<Place> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-show-')));
  const ws = workspace ?? path.join(root, 'ws');
  const spill = path.join(root, 'home', 'spill', 's1');
  const scratch = path.join(root, 'scratch');
  const outside = path.join(root, 'outside');
  for (const dir of [ws, spill, scratch, outside]) await mkdir(dir, { recursive: true });
  for (const dir of [ws, spill, scratch, outside]) await writeFile(path.join(dir, 'shot.png'), PNG);
  return { root, workspace: ws, spill, scratch, outside };
}

type Run = { readonly mode?: SessionMode | 'non-interactive'; readonly answers?: readonly PermissionAnswer[]; readonly rules?: readonly NewRule[]; readonly events?: readonly TurnEvent[] };

async function show(at: Place, input: unknown, { mode = 'ask', answers = [], rules = [], events = [] }: Run = {}) {
  const asked: Denial[] = [];
  const pending = [...answers];
  const approval: Approval =
    mode === 'non-interactive'
      ? NON_INTERACTIVE
      : {
          kind: 'interactive',
          mode: () => mode,
          approve: async (denial) => {
            asked.push(denial);
            return pending.shift() ?? 'reject';
          },
          classify: async () => {
            throw new Error('no classifier in these tests');
          },
        };
  const permissions = permissionStore(path.join(at.root, 'home'), at.workspace);
  for (const rule of rules) await permissions.add(rule);
  const executors = agentExecutors({
    sandbox: NO_SANDBOX,
    env: {},
    scope: { workspace: at.workspace, tempDir: at.scratch, home: at.root },
    check: undefined,
    checkAfterEdit: false,
    approval,
    diagnostics: undefined,
    rules: ruleAttacher([]),
    commands: async () => [],
    directories: workingDirectories([], new Set()),
    permissions,
  });
  const ctx: ToolContext = {
    workspace: at.workspace,
    spillDir: at.spill,
    spillChars: 24_000,
    readRoots: [],
    credentialPlaces: [],
    attachmentsDir: path.join(at.spill, 'attachments'),
    rg: rgCommand(),
    signal: new AbortController().signal,
    files: DISK_FILES,
    events: () => events,
    earlierCalls: async () => {},
  };
  const run = await runTool({ type: 'tool_use', id: 'tu_show', name: 'show_files', input, caller: { type: 'direct' } }, ctx, executors);
  return { run, asked };
}

describe('show_files path rules', () => {
  it('shows a workspace file, the spill folder and the scratchpad unasked, with real paths and sizes, and never sends their bytes', async () => {
    const at = await place();
    const { run, asked } = await show(at, { files: ['shot.png', path.join(at.spill, 'shot.png'), path.join(at.scratch, 'shot.png')], caption: 'Three shots' });
    expect(asked).toEqual([]);
    expect(run.status).toBe('ok');
    expect(run.shown).toEqual({
      caption: 'Three shots',
      layout: 'grid',
      files: [at.workspace, at.spill, at.scratch].map((dir, i) => ({ kind: 'shown', given: i === 0 ? 'shot.png' : path.join(dir, 'shot.png'), path: path.join(dir, 'shot.png'), name: 'shot.png', bytes: PNG.length, show: 'image' })),
    });
    expect(run.text).not.toContain(PNG.toString('base64').slice(0, 20));
    expect(run.images).toBeUndefined();
  });

  it('asks in Ask before a file outside every folder it may show, and shows it after a yes', async () => {
    const at = await place();
    const file = path.join(at.outside, 'shot.png');
    const { run, asked } = await show(at, { files: [file] }, { answers: ['allow'] });
    expect(asked).toEqual([{ rule: 'path-outside-workspace', reason: 'a path outside the workspace', command: `show_files ${file}`, verdict: 'ask', directory: at.outside, subject: { kind: 'read', path: file } }]);
    expect(run.status).toBe('ok');
    expect(run.approval).toMatchObject({ decidedBy: 'user', verdict: 'allow' });
    expect(run.shown?.files).toEqual([expect.objectContaining({ kind: 'shown', path: file })]);
  });

  it("ends the turn on the user's no, as a read outside does", async () => {
    const at = await place();
    const { run } = await show(at, { files: ['shot.png', path.join(at.outside, 'shot.png')] }, { answers: ['reject'] });
    expect(run.status).toBe('rejected');
    expect(run.shown).toBeUndefined();
  });

  it('refuses a file outside when nobody can answer, naming the folders it may read, and shows the rest', async () => {
    const at = await place();
    const { run, asked } = await show(at, { files: ['shot.png', path.join(at.outside, 'shot.png')] }, { mode: 'non-interactive' });
    expect(asked).toEqual([]);
    expect(run.status).toBe('ok');
    expect(run.shown?.files.map((entry) => entry.kind)).toEqual(['shown', 'refused']);
    expect(run.text).toMatch(/Not shown:\n- .*outside\/shot\.png: denied: `show_files .*` uses a path outside the workspace/);
    expect(run.text).toContain(`Geno may read only in these directories in this session: '${at.workspace}'`);
  });

  it('refuses in Plan a file outside, which Plan never asks about', async () => {
    const at = await place();
    const { run, asked } = await show(at, { files: [path.join(at.outside, 'shot.png')] }, { mode: 'plan' });
    expect(asked).toEqual([]);
    expect(run.status).toBe('error');
    expect(run.shown?.files[0]).toMatchObject({ kind: 'refused' });
  });

  it('never shows a credentials file, in the workspace or outside it, and asks nothing about one', async () => {
    const at = await place();
    await writeFile(path.join(at.workspace, '.env'), 'API_KEY=x\n');
    await mkdir(path.join(at.outside, '.ssh'));
    await writeFile(path.join(at.outside, '.ssh', 'id_ed25519'), 'key\n');
    const { run, asked } = await show(at, { files: ['.env', path.join(at.outside, '.ssh', 'id_ed25519')] }, { answers: ['allow', 'allow'] });
    expect(asked).toEqual([]);
    expect(run.status).toBe('error');
    expect(run.shown?.files).toEqual([
      { kind: 'refused', given: '.env', reason: expect.stringContaining(".env is off limits to show_files: it matches Geno's built-in rule for credentials files") },
      { kind: 'refused', given: path.join(at.outside, '.ssh', 'id_ed25519'), reason: expect.stringContaining('off limits to show_files') },
    ]);
  });

  it("refuses a file a Read deny rule covers, naming the rule, and asks first under a Read ask rule", async () => {
    const at = await place();
    await mkdir(path.join(at.workspace, 'private'));
    await writeFile(path.join(at.workspace, 'private', 'plan.png'), PNG);
    await mkdir(path.join(at.workspace, 'notes'));
    await writeFile(path.join(at.workspace, 'notes', 'chart.png'), PNG);
    const rules: NewRule[] = [
      { effect: 'deny', tool: 'read', path: 'private/**' },
      { effect: 'ask', tool: 'read', path: 'notes/**' },
    ];
    const { run, asked } = await show(at, { files: ['private/plan.png', 'notes/chart.png'] }, { rules, answers: ['allow'] });
    expect(run.shown?.files[0]).toEqual({ kind: 'refused', given: 'private/plan.png', reason: expect.stringContaining('`Read(private/**)`') });
    expect(asked).toEqual([expect.objectContaining({ rule: 'workspace-ask', command: 'read notes/chart.png' })]);
    expect(run.shown?.files[1]).toMatchObject({ kind: 'shown', given: 'notes/chart.png' });
  });

  it(`refuses a file over ${SHOW_FILES_LIMITS.fileBytes / 1024 / 1024} MB, a directory and a missing path, and shows the rest`, async () => {
    const at = await place();
    await writeFile(path.join(at.workspace, 'huge.png'), '');
    await truncate(path.join(at.workspace, 'huge.png'), SHOW_FILES_LIMITS.fileBytes + 1);
    await mkdir(path.join(at.workspace, 'shots'));
    const { run } = await show(at, { files: ['huge.png', 'shots', 'gone.png', 'shot.png'] });
    expect(run.status).toBe('ok');
    expect(run.shown?.files).toEqual([
      { kind: 'refused', given: 'huge.png', reason: 'huge.png is 15.0 MB; show_files shows files up to 15.0 MB' },
      { kind: 'refused', given: 'shots', reason: 'shots is a directory; name the files in it' },
      { kind: 'refused', given: 'gone.png', reason: `no such file or directory: gone.png. Relative paths start at the workspace root, ${at.workspace}.` },
      expect.objectContaining({ kind: 'shown', given: 'shot.png' }),
    ]);
  });

  it("shows a file in a lane one of the session's subagents worked in unasked, and asks about another lane", async () => {
    const repo = await realpath(makeRepo('repo', [{ message: 'start', files: { 'app/a.ts': 'export const a = 1;\n' } }]));
    const at = await place(path.join(repo, 'app'));
    const lanes = await laneRepoOf(repo);
    const mine = await createLane(lanes, 'shots', 'head');
    const other = await createLane(lanes, 'other', 'head');
    await bindSession({ repo: lanes, record: mine } as LaneSession, asSessionId('child-1'));
    await bindSession({ repo: lanes, record: other } as LaneSession, asSessionId('child-2'));
    for (const lane of [mine, other]) await writeFile(path.join(lane.path, 'after.png'), PNG);
    const started = { kind: 'child-start', seq: 3, at: new Date().toISOString(), child: asSessionId('child-1'), toolUseId: 'tu_agent', role: 'worker' } as unknown as TurnEvent;
    const { run, asked } = await show(at, { files: [path.join(mine.path, 'after.png'), path.join(other.path, 'after.png')] }, { events: [started], answers: ['reject'] });
    expect(asked).toEqual([expect.objectContaining({ rule: 'path-outside-workspace', command: `show_files ${path.join(other.path, 'after.png')}` })]);
    expect(run.status).toBe('rejected');
    const alone = await show(at, { files: [path.join(mine.path, 'after.png')] }, { events: [started] });
    expect(alone.asked).toEqual([]);
    expect(alone.run.shown?.files).toEqual([expect.objectContaining({ kind: 'shown', path: path.join(mine.path, 'after.png') })]);
  });
});
