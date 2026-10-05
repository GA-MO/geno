import { z } from 'zod';
import {
  AGENT_EDIT_FORMAT,
  baseOf,
  classifierInputOf,
  DEFAULT_BASH_TIMEOUT_SECONDS,
  denialFor,
  formatDiagnostics,
  MAX_BASH_TIMEOUT_SECONDS,
  AGENT_MODE_TOOLS,
  AGENT_TOOL_NAMES,
  MODE_REFUSALS,
  type AgentToolName,
  type ApprovalMode,
  type ApprovalRecord,
  type BaseRead,
  type ClassifierInput,
  type ClassifierRun,
  type CommandScope,
  type Denial,
  type EditorDiagnostic,
  type SessionMode,
} from '@g-code/core';
import type { Classify } from '../classifier.js';
import { applyEditToFile, type Files } from '../files.js';
import { tail } from '../process.js';
import type { Sandbox } from '../sandbox.js';
import {
  displayPath,
  executor,
  optional,
  resolveInside,
  resolveWritable,
  ToolDenied,
  ToolError,
  type Executor,
  type ToolContext,
} from './context.js';
import { EXECUTORS } from './index.js';
import { withRuleAttachments, type RuleAttacher } from './rules.js';

/** The user's answer. `allow-session` is offered only for an MCP tool, and allows it for the rest of the session. */
export type PermissionAnswer = 'allow' | 'allow-session' | 'reject';

/** Asked before a flagged command runs, with the classifier's answer when it sent the question on. */
export type Approver = (denial: Denial, classifier: ClassifierRun | undefined) => Promise<PermissionAnswer>;

/** Only an interactive run has someone to ask, and a classifier to ask first in Auto. */
export type Approval =
  /** `mcp` turns MCP tools on, which a non-interactive run never has otherwise. */
  | { readonly kind: 'non-interactive'; readonly mcp?: boolean }
  | {
      readonly kind: 'interactive';
      /** Read before each command, so a switch during a turn applies from the next command on. */
      mode(): SessionMode;
      readonly approve: Approver;
      readonly classify: Classify;
    };

export const NON_INTERACTIVE: Approval = { kind: 'non-interactive' };

export const modeOf = (approval: Approval): ApprovalMode => (approval.kind === 'interactive' ? approval.mode() : 'non-interactive');

/**
 * Settles a flagged command: the rule's verdict, then the classifier's for a gray one, then the user's for a question.
 * `forSession` runs when the user allows it for the rest of the session.
 */
export async function settle(
  approval: Approval,
  mode: ApprovalMode,
  denial: Denial,
  input: () => ClassifierInput,
  signal: AbortSignal,
  forSession: () => void = () => {},
): Promise<ApprovalRecord> {
  const record = { mode, rule: denial.rule, reason: denial.reason, command: denial.command };
  if (approval.kind === 'non-interactive' || denial.verdict === 'deny') return { ...record, decidedBy: 'rule', verdict: 'deny' };
  const classifier = denial.verdict === 'classify' ? await approval.classify(input(), signal) : undefined;
  if (classifier !== undefined && classifier.verdict !== 'ask') return { ...record, classifier, decidedBy: 'classifier', verdict: classifier.verdict };
  const answer = await approval.approve(denial, classifier);
  if (answer === 'allow-session') forSession();
  const allowed = answer !== 'reject';
  return { ...record, ...(classifier === undefined ? {} : { classifier }), decidedBy: 'user', verdict: allowed ? 'allow' : 'deny' };
}

export const denialText = ({ mode, command, reason, classifier, decidedBy }: ApprovalRecord): string =>
  `denied: \`${command}\` ${
    decidedBy === 'classifier'
      ? `was refused by the safety classifier: ${classifier?.reason}`
      : MODE_REFUSALS[mode] === undefined
        ? `uses ${reason}, which needs the user's approval`
        : `uses ${reason}. ${MODE_REFUSALS[mode]}`
  }. Do not retry it; find another way.`;

/**
 * The tool, refused while the session's mode leaves it out. A run offers only its starting mode's tools, so this
 * holds when the user switches modes mid-turn, say to Plan after an edit was offered.
 */
function inMode(name: AgentToolName, tool: Executor, approval: Approval): Executor {
  return {
    ...tool,
    async run(raw, ctx) {
      const mode = modeOf(approval);
      if (!AGENT_MODE_TOOLS[mode].includes(name)) {
        throw new ToolError(`${name} is not available: ${MODE_REFUSALS[mode] ?? `${mode} mode does not offer it`}. Do not retry it.`);
      }
      return tool.run(raw, ctx);
    },
  };
}

/** The editor's problems in some files, given and returned as absolute paths. */
export type Diagnostics = (files: readonly string[]) => Promise<readonly EditorDiagnostic[]>;

export type AgentToolEnv = {
  readonly sandbox: Sandbox;
  readonly env: Readonly<Record<string, string>>;
  readonly scope: CommandScope;
  readonly check: string | undefined;
  readonly checkAfterEdit: boolean;
  readonly approval: Approval;
  /** Stands in for the check command when the workspace has none and an editor is attached. */
  readonly diagnostics: Diagnostics | undefined;
  readonly rules: RuleAttacher;
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

const currentBase = async (ctx: ToolContext, file: string): Promise<BaseRead> => baseOf(await ctx.files.read(file), null);

/**
 * The edit tool. `reads` holds what the model last saw of each file, the base an edit must still match;
 * `afterEdit` returns text to append to a successful edit's result, such as a check run.
 */
export function editExecutor(reads: Map<string, BaseRead>, afterEdit: (ctx: ToolContext) => Promise<string | undefined>): Executor {
  return executor({
    input: z.looseObject({ path: z.string().min(1) }),
    describe: ({ path }) => `edit ${path}`,
    async run(input, ctx) {
      const file = await resolveWritable(ctx, input.path);
      const current = await currentBase(ctx, file);
      const base = current.hash === null ? current : reads.get(file);
      if (base === undefined) throw new ToolError(`read ${input.path} before editing it`);
      const { proposed, change } = await applyEditToFile(ctx.files, file, { path: input.path, format: AGENT_EDIT_FORMAT, raw: input, base }, null);
      if (proposed.result.kind === 'failed') throw new ToolError(proposed.result.detail);
      reads.set(file, await currentBase(ctx, file));
      const after = await afterEdit(ctx);
      const text = after === undefined ? `Edited ${input.path}.` : `Edited ${input.path}.\n\n${after}`;
      return change === undefined ? text : { text, change };
    },
  });
}

export function agentExecutors(tools: AgentToolEnv): Readonly<Record<AgentToolName, Executor>> {
  // What the model last saw of each file: the base an edit must still match.
  const reads = new Map<string, BaseRead>();

  const read: Executor = {
    input: EXECUTORS.read.input,
    describe: EXECUTORS.read.describe,
    async run(raw, ctx) {
      // The base is the very text the read tool showed, so a change a moment later makes the next edit stale.
      let seen: string | null = null;
      const files: Files = { ...ctx.files, read: async (file) => (seen = await ctx.files.read(file)) };
      const text = await EXECUTORS.read.run(raw, { ...ctx, files });
      reads.set(await resolveInside(ctx, (raw as { path: string }).path), baseOf(seen, null));
      return text;
    },
  };

  const edit = editExecutor(reads, async (ctx) => (tools.checkAfterEdit ? (await runCheck(tools, ctx))?.text : undefined));

  const bash = executor({
    input: z.strictObject({
      command: z.string().min(1),
      timeout_seconds: optional(z.number().int().positive().max(MAX_BASH_TIMEOUT_SECONDS)),
    }),
    describe: ({ command }) => `bash ${command}`,
    async run({ command, timeout_seconds = DEFAULT_BASH_TIMEOUT_SECONDS }, ctx) {
      const mode = modeOf(tools.approval);
      const denial = denialFor(command, tools.scope, mode);
      const approval =
        denial === undefined ? undefined : await settle(tools.approval, mode, denial, () => classifierInputOf(ctx.events(), command, denial), ctx.signal);
      if (approval?.verdict === 'deny') throw new ToolDenied(denialText(approval), approval);
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
      const text = `${truncated}${result.output}${result.output === '' || result.output.endsWith('\n') ? '' : '\n'}${status}`;
      return approval === undefined ? text : { text, approval };
    },
  });

  const check = executor({
    input: z.strictObject({}),
    describe: () => 'check',
    async run(_input, ctx) {
      const result = await runCheck(tools, ctx);
      if (result !== undefined) return result.text;
      if (tools.diagnostics !== undefined && reads.size > 0) {
        return formatDiagnostics(await tools.diagnostics([...reads.keys()]), (file) => displayPath(ctx, file));
      }
      return 'This workspace has no check command. Run its tests or type checker with bash instead.';
    },
  });

  const all: Readonly<Record<AgentToolName, Executor>> = { ...EXECUTORS, read: withRuleAttachments(read, tools.rules), edit, bash, check };
  return Object.fromEntries(AGENT_TOOL_NAMES.map((name) => [name, inMode(name, all[name], tools.approval)])) as Record<AgentToolName, Executor>;
}
