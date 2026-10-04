import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  AGENT_EDIT_FORMAT,
  baseOf,
  DEFAULT_BASH_TIMEOUT_SECONDS,
  denialFor,
  MAX_BASH_TIMEOUT_SECONDS,
  type AgentToolName,
  type BaseRead,
  type CommandScope,
  type Denial,
} from '@g-code/core';
import { applyEditToFile } from '../apply.js';
import { tail } from '../process.js';
import type { Sandbox } from '../sandbox.js';
import { isMissing } from '../store.js';
import { executor, optional, resolveInside, resolveWritable, ToolDenied, ToolError, type Executor, type ToolContext } from './context.js';
import { EXECUTORS } from './index.js';

/** Asked before a command on the deny list runs; true lets it run. */
export type Approver = (denial: Denial) => Promise<boolean>;

export type AgentToolEnv = {
  readonly sandbox: Sandbox;
  readonly env: Readonly<Record<string, string>>;
  readonly scope: CommandScope;
  readonly check: string | undefined;
  readonly checkAfterEdit: boolean;
  readonly approve: Approver;
};

export const CHECK_TIMEOUT_MS = 10 * 60 * 1000;

type CheckResult = { readonly passed: boolean; readonly text: string };

async function runCheck(tools: AgentToolEnv, ctx: ToolContext): Promise<CheckResult | undefined> {
  if (tools.check === undefined) return undefined;
  const result = await tools.sandbox.run(tools.check, {
    cwd: ctx.workspace,
    env: tools.env,
    timeoutMs: CHECK_TIMEOUT_MS,
    signal: ctx.signal,
  });
  const passed = result.code === 0;
  const verdict = result.timedOut ? 'timed out' : passed ? 'passed' : `failed (exit ${result.code ?? 'killed'})`;
  const output = tail(result.output);
  return { passed, text: `check \`${tools.check}\` ${verdict}${output === '' ? '' : `\n${output}`}` };
}

async function currentBase(file: string): Promise<BaseRead> {
  try {
    return baseOf(await readFile(file, 'utf8'), null);
  } catch (error) {
    if (isMissing(error)) return baseOf(null, null);
    throw error;
  }
}

export function agentExecutors(tools: AgentToolEnv): Readonly<Record<AgentToolName, Executor>> {
  // What the model last saw of each file: the base an edit must still match.
  const reads = new Map<string, BaseRead>();

  const read: Executor = {
    input: EXECUTORS.read.input,
    describe: EXECUTORS.read.describe,
    async run(raw, ctx) {
      const text = await EXECUTORS.read.run(raw, ctx);
      const file = await resolveInside(ctx, (raw as { path: string }).path);
      reads.set(file, await currentBase(file));
      return text;
    },
  };

  const edit = executor({
    input: z.looseObject({ path: z.string().min(1) }),
    describe: ({ path }) => `edit ${path}`,
    async run(input, ctx) {
      const file = await resolveWritable(ctx, input.path);
      const current = await currentBase(file);
      const base = current.hash === null ? current : reads.get(file);
      if (base === undefined) throw new ToolError(`read ${input.path} before editing it`);
      const change = await applyEditToFile(file, { path: input.path, format: AGENT_EDIT_FORMAT, raw: input, base }, null);
      if (change.result.kind === 'failed') throw new ToolError(change.result.detail);
      reads.set(file, await currentBase(file));
      if (!tools.checkAfterEdit) return `Edited ${input.path}.`;
      const check = await runCheck(tools, ctx);
      return check === undefined ? `Edited ${input.path}.` : `Edited ${input.path}.\n\n${check.text}`;
    },
  });

  const bash = executor({
    input: z.strictObject({
      command: z.string().min(1),
      timeout_seconds: optional(z.number().int().positive().max(MAX_BASH_TIMEOUT_SECONDS)),
    }),
    describe: ({ command }) => `bash ${command}`,
    async run({ command, timeout_seconds = DEFAULT_BASH_TIMEOUT_SECONDS }, ctx) {
      const denial = denialFor(command, tools.scope);
      if (denial !== undefined && !(await tools.approve(denial))) {
        throw new ToolDenied(`denied: \`${denial.command}\` uses ${denial.reason}, which needs the user's approval. Do not retry it; find another way.`);
      }
      const result = await tools.sandbox.run(command, {
        cwd: ctx.workspace,
        env: tools.env,
        timeoutMs: timeout_seconds * 1000,
        signal: ctx.signal,
      });
      const status = result.timedOut
        ? `[killed after ${timeout_seconds} seconds]`
        : `[exit code ${result.code ?? 'killed'}]`;
      const truncated = result.truncated ? '[earlier output dropped]\n' : '';
      return `${truncated}${result.output}${result.output === '' || result.output.endsWith('\n') ? '' : '\n'}${status}`;
    },
  });

  const check = executor({
    input: z.strictObject({}),
    describe: () => 'check',
    async run(_input, ctx) {
      const result = await runCheck(tools, ctx);
      return result?.text ?? 'This workspace has no check command. Run its tests or type checker with bash instead.';
    },
  });

  return { ...EXECUTORS, read, edit, bash, check };
}
