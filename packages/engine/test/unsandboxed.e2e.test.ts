import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClassifierRun, Denial, NewRule, SessionMode } from '@g-code/core';
import { childEnv } from '../src/child-env.js';
import { workingDirectories } from '../src/directories.js';
import { DISK_FILES } from '../src/files.js';
import { permissionStore } from '../src/permissions.js';
import { openSandbox, sandboxPolicy, type Sandbox } from '../src/sandbox.js';
import { openStore } from '../src/store.js';
import { agentExecutors, NON_INTERACTIVE, type Approval, type PermissionAnswer } from '../src/tools/agent.js';
import { runTool, type PermissionAsk, type ToolContext } from '../src/tools/index.js';
import { ruleAttacher } from '../src/tools/rules.js';
import { rgCommand } from './helpers.js';

let root: string;
let workspace: string;
let tempDir: string;
let outside: string;
let sandbox: Sandbox;

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'gcode-unsandboxed-')));
  workspace = path.join(root, 'ws');
  tempDir = path.join(root, 'tmp');
  outside = path.join(root, 'outside');
  for (const dir of [workspace, tempDir, outside]) await mkdir(dir);
  const home = path.join(root, 'home');
  sandbox = await openSandbox(await sandboxPolicy({ store: openStore({ GCODE_HOME: home }), home, workspace, tempDir }));
});

afterAll(async () => {
  await sandbox.close();
});

type Run = {
  readonly mode?: SessionMode | 'non-interactive';
  readonly answers?: readonly PermissionAnswer[];
  readonly rules?: readonly NewRule[];
  /** The call's PermissionRequest hooks, which answer a card before the user where they may. */
  readonly permissionRequest?: PermissionAsk;
  /** A PreToolUse hook allowed the call. */
  readonly hookAllowed?: boolean;
  readonly lane?: boolean;
};

let calls = 0;

async function bash(input: Record<string, unknown>, { mode = 'auto', answers = [], rules = [], permissionRequest, hookAllowed, lane = false }: Run = {}) {
  const asked: Denial[] = [];
  let classified = 0;
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
          classify: async (): Promise<ClassifierRun> => {
            classified++;
            return { verdict: 'allow', reason: 'looks fine' } as ClassifierRun;
          },
        };
  const permissions = permissionStore(path.join(root, 'home'), workspace);
  for (const rule of rules) await permissions.add(rule);
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
    permissions,
    ...(lane ? { lane: { lane: [workspace], main: [outside], home: undefined } } : {}),
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
    ...(permissionRequest === undefined ? {} : { permissionRequest }),
    ...(hookAllowed === true ? { hookAllowed } : {}),
  };
  const run = await runTool({ type: 'tool_use', id: `tu_out_${calls++}`, name: 'bash', input, caller: { type: 'direct' } }, ctx, executors);
  return { run, asked, classified: () => classified };
}

/** A command that writes outside the workspace and the temp dir, which the sandbox refuses. */
const escape = () => {
  const target = path.join(outside, `escaped-${calls}.txt`);
  return { target, command: `echo escaped > '${target}' && echo "tmp=$TMPDIR"` };
};

describe('bash with dangerouslyDisableSandbox', () => {
  it('runs a write the sandbox refuses once the user says yes in Auto, without the classifier, and records the user and the rule', async () => {
    const sandboxed = escape();
    const inside = await bash({ command: sandboxed.command });
    expect(inside.run.text).toContain('Operation not permitted');
    expect(existsSync(sandboxed.target)).toBe(false);

    const { target, command } = escape();
    const { run, asked, classified } = await bash({ command, dangerouslyDisableSandbox: true }, { answers: ['allow'] });
    expect(classified()).toBe(0);
    // The path outside is one the classifier would judge in Auto; here it joins the card instead.
    expect(asked).toEqual([{ rule: 'unsandboxed', reason: expect.stringMatching(/^no sandbox.*; a path outside the workspace$/), command: `echo escaped ${target}`, line: command, verdict: 'ask' }]);
    expect(run.status).toBe('ok');
    expect(await readFile(target, 'utf8')).toBe('escaped\n');
    expect(run.text).toContain(`tmp=${tempDir}`);
    expect(run.approval).toMatchObject({ mode: 'auto', rule: 'unsandboxed', decidedBy: 'user', verdict: 'allow' });
  });

  it('asks even for a command the safe list, an allow rule or a PreToolUse allow runs unasked, and a no runs nothing', async () => {
    // Each command, the file it makes in the workspace, and the run where it goes unasked without the flag.
    const unasked: readonly [string, string | undefined, Run][] = [
      ['ls', undefined, { mode: 'ask' }],
      ['touch made-by-rule.txt', 'made-by-rule.txt', { mode: 'auto', rules: [{ effect: 'allow', pattern: ['touch'] }] }],
      ['touch made-by-hook.txt', 'made-by-hook.txt', { mode: 'auto', hookAllowed: true }],
    ];
    for (const [command, made, run] of unasked) {
      const isMade = () => made !== undefined && existsSync(path.join(workspace, made));
      const { run: ran, asked } = await bash({ command, dangerouslyDisableSandbox: true }, { ...run, answers: ['reject'] });
      expect(asked, command).toEqual([{ rule: 'unsandboxed', reason: expect.stringMatching(/^no sandbox/), command, verdict: 'ask' }]);
      expect([command, ran.status, isMade()]).toEqual([command, 'rejected', false]);
      const control = await bash({ command }, run);
      expect([command, control.asked, control.run.status, isMade()]).toEqual([command, [], 'ok', made !== undefined]);
    }
  });

  it('never lets a PermissionRequest hook answer for the user: the card still shows, and a run nobody can answer refuses', async () => {
    let hooked = 0;
    const permissionRequest: PermissionAsk = async () => {
      hooked++;
      return { kind: 'allow' };
    };
    const shown = escape();
    const { asked } = await bash({ command: shown.command, dangerouslyDisableSandbox: true }, { mode: 'ask', permissionRequest, answers: ['reject'] });
    expect(asked).toEqual([expect.objectContaining({ rule: 'unsandboxed' })]);
    expect(existsSync(shown.target)).toBe(false);

    const alone = escape();
    const { run } = await bash({ command: alone.command, dangerouslyDisableSandbox: true }, { mode: 'non-interactive', permissionRequest });
    expect(run.status).toBe('denied');
    expect(run.text).toContain('would run outside the sandbox, which only the user can approve, and nobody can answer here');
    expect(existsSync(alone.target)).toBe(false);
    expect(hooked).toBe(0);
  });

  it('refuses in Plan, saying Plan cannot run it there', async () => {
    const { run, asked } = await bash({ command: 'git status', dangerouslyDisableSandbox: true }, { mode: 'plan' });
    expect(asked).toEqual([]);
    expect(run.status).toBe('denied');
    expect(run.text).toMatch(/would run outside the sandbox\. Plan mode is read-only/);
  });

  it('still refuses a command a deny rule names, without a card', async () => {
    const { target, command } = escape();
    const { run, asked } = await bash({ command, dangerouslyDisableSandbox: true }, { mode: 'ask', rules: [{ effect: 'deny', pattern: ['echo'] }], answers: ['allow'] });
    expect(asked).toEqual([]);
    expect(run.status).toBe('denied');
    expect(run.approval).toMatchObject({ rule: 'workspace-deny', verdict: 'deny' });
    expect(existsSync(target)).toBe(false);
  });

  it('is refused with run_in_background, and in a lane, before anyone is asked', async () => {
    const background = await bash({ command: 'ls', dangerouslyDisableSandbox: true, run_in_background: true }, { mode: 'ask', answers: ['allow'] });
    expect(background.asked).toEqual([]);
    expect(background.run).toMatchObject({ status: 'error', text: expect.stringContaining('foreground only') });

    const lane = await bash({ command: 'ls', dangerouslyDisableSandbox: true }, { mode: 'ask', lane: true, answers: ['allow'] });
    expect(lane.asked).toEqual([]);
    expect(lane.run).toMatchObject({ status: 'error', text: expect.stringContaining('not available in a lane') });
  });
});
