import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandPattern, Denial, SessionMode } from '@g-code/core';
import { BackgroundJobs } from '../src/background.js';
import { childEnv } from '../src/child-env.js';
import { workingDirectories } from '../src/directories.js';
import { DISK_FILES } from '../src/files.js';
import { permissionStore } from '../src/permissions.js';
import { openSandbox, sandboxPolicy, type Sandbox } from '../src/sandbox.js';
import { openStore } from '../src/store.js';
import { agentExecutors, type Approval } from '../src/tools/agent.js';
import { runTool, type ToolContext } from '../src/tools/index.js';
import { ruleAttacher } from '../src/tools/rules.js';
import { rgCommand } from './helpers.js';

let root: string;
let workspace: string;
let tempDir: string;
let sandbox: Sandbox;

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-plan-switch-')));
  workspace = path.join(root, 'ws');
  tempDir = path.join(root, 'tmp');
  for (const dir of [workspace, tempDir]) await mkdir(dir);
  await writeFile(path.join(workspace, 'a.ts'), 'export const a = 1;\n');
  const home = path.join(root, 'home');
  sandbox = await openSandbox(await sandboxPolicy({ store: openStore({ GCODE_HOME: home }), home, workspace, tempDir }));
});

afterAll(async () => {
  await sandbox.close();
});

/** A session in Ask whose user switches it to Plan while each card shows, then allows the call. */
let sessions = 0;

async function switchingToPlan(askRule?: CommandPattern) {
  let mode: SessionMode = 'ask';
  const asked: Denial[] = [];
  const approval: Approval = {
    kind: 'interactive',
    mode: () => mode,
    approve: async (denial) => {
      asked.push(denial);
      mode = 'plan';
      return 'allow';
    },
    classify: async () => ({ verdict: 'deny', reason: 'unused', model: 'fake', latencyMs: 1, costUsd: 0 }),
  };
  const home = path.join(root, `home-${sessions++}`);
  const permissions = permissionStore(home, workspace);
  if (askRule !== undefined) await permissions.add({ effect: 'ask', pattern: askRule });
  const executors = agentExecutors({
    sandbox,
    env: childEnv(process.env),
    scope: { workspace, tempDir, home },
    check: undefined,
    checkAfterEdit: false,
    approval,
    diagnostics: undefined,
    rules: ruleAttacher([]),
    commands: async () => [],
    directories: workingDirectories([], new Set()),
    permissions,
    background: { jobs: new BackgroundJobs({ changed: () => {}, ended: () => {} }), sessionId: 'session' },
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
    events: () => [],
    earlierCalls: async () => {},
  };
  const bash = (command: string, more: Record<string, unknown> = {}) =>
    runTool({ type: 'tool_use', id: `tu_${asked.length}`, name: 'bash', input: { command, ...more }, caller: { type: 'direct' } }, ctx, executors);
  return { bash, asked };
}

const REFUSED = 'is not available: Plan mode is read-only; switch to Ask or Auto to make changes. Do not retry it.';

describe('a command the user allowed on its card while the session switched to Plan', () => {
  it('runs when Plan would run it unasked, such as a safe-list command under an ask rule', async () => {
    const { bash, asked } = await switchingToPlan(['ls']);
    const run = await bash('ls');
    expect(asked, 'Ask asked about it').toHaveLength(1);
    expect(run.status).toBe('ok');
    expect(run.text).toContain('a.ts');
    expect(run.approval).toMatchObject({ decidedBy: 'user', verdict: 'allow' });
  });

  it.each([
    ['a line Geno cannot parse', "echo 'open", {}],
    ['a command outside the sandbox', 'ls', { dangerouslyDisableSandbox: true }],
    ['a command outside the safe list', 'make build', {}],
    ['a command in the background', 'make build', { run_in_background: true }],
  ])('is refused when Plan refuses it: %s', async (_what, command, more) => {
    const { bash, asked } = await switchingToPlan();
    const run = await bash(command, more);
    expect(asked, 'Ask asked about it').toHaveLength(1);
    expect(run.status).toBe('error');
    expect(run.text).toBe(`\`${command}\` ${REFUSED}`);
    expect(run.approval, 'the user\'s yes stays on the result').toMatchObject({ decidedBy: 'user', verdict: 'allow' });
  });
});
