import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Denial, NewRule, SessionMode } from '@g-code/core';
import { BackgroundJobs } from '../src/background.js';
import { childEnv } from '../src/child-env.js';
import { workingDirectories } from '../src/directories.js';
import { DISK_FILES } from '../src/files.js';
import { permissionStore } from '../src/permissions.js';
import { openSandbox, sandboxPolicy, type Sandbox } from '../src/sandbox.js';
import { openStore } from '../src/store.js';
import { agentExecutors, denialText, type Approval } from '../src/tools/agent.js';
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
  await writeFile(path.join(workspace, 'notes.md'), 'TODO: ship\n');
  const home = path.join(root, 'home');
  sandbox = await openSandbox(await sandboxPolicy({ store: openStore({ GCODE_HOME: home }), home, workspace, tempDir }));
});

afterAll(async () => {
  await sandbox.close();
});

let sessions = 0;

/** A session in `start` (Ask unless named) whose user, shown a card, switches it to Plan and then allows the call. */
async function switchingToPlan(rule?: NewRule, start: SessionMode = 'ask') {
  let mode = start;
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
  if (rule !== undefined) await permissions.add(rule);
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
  const call = (name: string, input: Record<string, unknown>) => runTool({ type: 'tool_use', id: `tu_${asked.length}`, name, input, caller: { type: 'direct' } }, ctx, executors);
  const bash = (command: string, more: Record<string, unknown> = {}) => call('bash', { command, ...more });
  return { bash, call, asked };
}

const REFUSED = 'is not available: Plan mode is read-only; switch to Ask or Auto to make changes. Do not retry it.';

describe('a command the user allowed on its card while the session switched to Plan', () => {
  it('runs when Plan would run it unasked, such as a safe-list command under an ask rule', async () => {
    const { bash, asked } = await switchingToPlan({ effect: 'ask', pattern: ['ls'] });
    const run = await bash('ls');
    expect(asked, 'Ask asked about it').toHaveLength(1);
    expect(run.status).toBe('ok');
    expect(run.text).toContain('a.ts');
    expect(run.approval).toMatchObject({ decidedBy: 'user', verdict: 'allow' });
  });

  it('is refused in the background, which Plan refuses, though Plan would run it in the foreground', async () => {
    const { bash, asked } = await switchingToPlan({ effect: 'ask', pattern: ['ls'] });
    const run = await bash('ls', { run_in_background: true });
    expect(asked, 'Ask asked about it').toHaveLength(1);
    expect(run.status).toBe('error');
    expect(run.text).toBe(`\`ls\` ${REFUSED}`);
  });

  it.each([
    ['a line Geno cannot parse', "echo 'open", {}],
    ['a command outside the sandbox', 'ls', { dangerouslyDisableSandbox: true }],
    ['a command outside the safe list', 'make build', {}],
  ])('is refused when Plan refuses it: %s', async (_what, command, more) => {
    const { bash, asked } = await switchingToPlan();
    const run = await bash(command, more);
    expect(asked, 'Ask asked about it').toHaveLength(1);
    expect(run.status).toBe('error');
    expect(run.text).toBe(`\`${command}\` ${REFUSED}`);
    expect(run.approval, 'the user\'s yes stays on the result').toMatchObject({ decidedBy: 'user', verdict: 'allow' });
  });
});

describe('a command in Plan that reads a path a Read rule covers', () => {
  it.each([
    ['asks before', 'ask'],
    ['denies', 'deny'],
  ] as const)('is refused, as read is, when the rule %s it', async (_what, effect) => {
    const { bash, call, asked } = await switchingToPlan({ effect, tool: 'read', path: 'notes.md' }, 'plan');
    const read = await call('read', { path: 'notes.md' });
    const grep = await bash('grep -n TODO notes.md');
    expect(asked, 'Plan asks nobody').toEqual([]);
    expect(read.status, 'read refuses it in Plan').toBe('denied');
    expect(grep.status).toBe('denied');
    expect(grep.text).not.toContain('TODO: ship');
    expect(grep.text, 'the Read rule refused it').toContain('Read(notes.md)');
  });

  it('tells the model, for a rule that asks, that the user is asked in Ask or Auto, with one text for read and bash', async () => {
    const { bash, call } = await switchingToPlan({ effect: 'ask', tool: 'read', path: 'notes.md' }, 'plan');
    const rule = 'the workspace rule that asks before `Read(notes.md)`, which the user set in Settings under Permissions';
    const advice = 'Plan mode refuses what this rule asks about, with no card; in Ask or Auto Geno asks the user first, so the user can switch modes to allow it. Do not retry it in Plan; find another way, or say in your answer what you need the user to allow.';
    expect((await call('read', { path: 'notes.md' })).text).toBe(`denied: \`read notes.md\` matches ${rule}. ${advice}`);
    expect((await bash('grep -n TODO notes.md')).text).toBe(`denied: \`grep -n TODO notes.md\` matches ${rule}. ${advice}`);
  });

  it('still says nobody can answer a rule that asks in a run nobody watches', () => {
    const text = denialText({ mode: 'non-interactive', rule: 'workspace-ask', reason: 'the workspace rule that asks before `ls`', command: 'ls', decidedBy: 'rule', verdict: 'deny' });
    expect(text).toContain('nobody can answer here');
  });

  it('runs when no Read rule covers the path', async () => {
    const { bash } = await switchingToPlan({ effect: 'ask', tool: 'read', path: 'other.md' }, 'plan');
    const grep = await bash('grep -n TODO notes.md');
    expect(grep.status).toBe('ok');
    expect(grep.text).toContain('TODO: ship');
  });
});
