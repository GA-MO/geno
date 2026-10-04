import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { AGENT_SYSTEM_PROMPT, AGENT_TOOL_DEFINITIONS } from '@g-code/core';
import type { OpenSession } from './chat.js';
import { takeCheckpoint, shadowRepoFor } from './checkpoints.js';
import { childEnv } from './child-env.js';
import type { Command, Io } from './command.js';
import { drive, openForPrompt, positiveNumber, workspaceDir, type DriveResult, type Limits } from './drive.js';
import { openSandbox, sandboxPolicy } from './sandbox.js';
import { isMissing, StoreError, type Store } from './store.js';
import { agentExecutors, type Approver } from './tools/agent.js';

const workspaceConfigSchema = z.looseObject({ check: z.string().min(1).optional() });

export async function configuredCheck(workspace: string): Promise<string | undefined> {
  const file = path.join(workspace, '.gcode.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new StoreError(file, (error as Error).message);
  }
  const parsed = workspaceConfigSchema.safeParse(raw);
  if (!parsed.success) throw new StoreError(file, z.prettifyError(parsed.error));
  return parsed.data.check;
}

export type AgentOptions = {
  readonly limits: Limits;
  /** From --check; undefined falls back to `.gcode.json`. */
  readonly check: string | undefined;
  readonly checkAfterEdit: boolean;
  readonly approve: Approver;
};

export const denyAll: Approver = async () => false;

export const askOnTerminal =
  (io: Io): Approver =>
  (denial) =>
    io.confirm(`Allow \`${denial.command}\`? It uses ${denial.reason}.`);

export async function runAgent(io: Io, store: Store, opened: OpenSession, prompt: string, options: AgentOptions): Promise<DriveResult> {
  const { session } = opened.log;
  const workspace = await workspaceDir(io.cwd, session.workspace);
  const tempDir = await mkdtemp(path.join(tmpdir(), 'gcode-agent-'));
  const home = io.env['HOME'] || homedir();
  const sandbox = await openSandbox(await sandboxPolicy({ store, home, workspace, tempDir }));
  try {
    const executors = agentExecutors({
      sandbox,
      env: childEnv(io.env),
      scope: { workspace, tempDir, home },
      check: options.check ?? (await configuredCheck(workspace)),
      checkAfterEdit: options.checkAfterEdit,
      approve: options.approve,
    });
    const repo = shadowRepoFor(store, session.workspace);
    return await drive(io, store, opened, prompt, options.limits, {
      tools: AGENT_TOOL_DEFINITIONS,
      executors,
      system: AGENT_SYSTEM_PROMPT,
      beforeCall: (events) => takeCheckpoint(repo, session.id, events),
    });
  } finally {
    await sandbox.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

export const agent: Command = async (args, { io, store }) => {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    allowNegative: true,
    options: {
      session: { type: 'string' },
      workspace: { type: 'string' },
      'max-turns': { type: 'string', default: '40' },
      'max-cost': { type: 'string', default: '0.40' },
      check: { type: 'string' },
      'check-after-edit': { type: 'boolean', default: true },
      'non-interactive': { type: 'boolean', default: false },
    },
  });
  const task = positionals.join(' ').trim();
  const limits = {
    maxTurns: positiveNumber('max-turns', values['max-turns'], true),
    maxCostUsd: positiveNumber('max-cost', values['max-cost'], false),
  };

  const opened = await openForPrompt(io, store, values, task, 'task');
  const { exitCode } = await runAgent(io, store, opened, task, {
    limits,
    check: values.check,
    checkAfterEdit: values['check-after-edit'],
    approve: values['non-interactive'] ? denyAll : askOnTerminal(io),
  });
  return exitCode;
};
