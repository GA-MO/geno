import { z } from 'zod';
import {
  AGENT_EDIT_FORMAT,
  AUTO_START,
  baseOf,
  changesDirectory,
  CLASSIFIER_OUTCOMES,
  checkHeadline,
  commandLineOf,
  classifierInputOf,
  commandFailureLine,
  commandStatusLine,
  cwdResetLine,
  DEFAULT_BASH_TIMEOUT_SECONDS,
  formatDiagnostics,
  laneCommandDenial,
  laneDenialText,
  leadingSleep,
  MAX_BASH_TIMEOUT_SECONDS,
  AGENT_MODE_TOOLS,
  AGENT_TOOL_NAMES,
  MODE_REFUSALS,
  neutralizeNoticeLines,
  nextAutoState,
  OUTCOME_VERDICTS,
  restoreHidden,
  STOP_AND_WAIT,
  ruledDenial,
  secretReadDenial,
  sleepRefusal,
  type AgentToolName,
  type ApprovalMode,
  type ApprovalRecord,
  type AutoState,
  type BaseRead,
  type ClassifierInput,
  type ClassifierRun,
  type CommandPattern,
  type CommandScope,
  type Denial,
  type EditorDiagnostic,
  type LaneBounds,
  type SessionMode,
  type SlashCommand,
} from '@g-code/core';
import type { JobStart } from '../background.js';
import type { CheckCommand } from '../check-command.js';
import type { Classify } from '../classifier.js';
import { diskStat, stampOf, type DiskStat } from '../file-tracker.js';
import { applyEditToFile, type Files } from '../files.js';
import { tail } from '../process.js';
import type { PermissionStore } from '../permissions.js';
import type { Sandbox } from '../sandbox.js';
import {
  displayPath,
  executor,
  optional,
  resolveInside,
  resolveWritable,
  ToolDenied,
  ToolError,
  ToolRejected,
  type Executor,
  type ToolContext,
} from './context.js';
import { backgroundExecutors, NO_BACKGROUND, type SessionBackground } from './background.js';
import { previewExecutors } from './preview.js';
import { EXECUTORS } from './index.js';
import { readTool, type SecretGate } from './read.js';
import { withRuleAttachments, type RuleAttacher } from './rules.js';
import { recallExecutor, type Recall } from './recall.js';
import { skillExecutor } from './skill.js';
import { wakeExecutors, type SessionWakes } from './wake.js';
import { watchPrExecutor, type PrTools } from './pr.js';
import { todo } from './todo.js';

/**
 * The user's answer. `allow-session` is offered only for an MCP tool, and allows it for the rest of the session.
 * `allow-workspace` is offered only with a command's `offer`, and saves that allow rule for the workspace.
 */
export type PermissionAnswer = 'allow' | 'allow-session' | 'allow-workspace' | 'reject';
/** An answer that outlives the one call. */
export type KeptAnswer = Extract<PermissionAnswer, 'allow-session' | 'allow-workspace'>;

/** The subagent a question comes from; the user answers it, since a subagent can approve nothing itself. */
export type Asker = { readonly name: string; readonly sessionId: string };

/** Asked before a flagged command runs, with the classifier's answer when it sent the question on. */
export type Approver = (denial: Denial, classifier: ClassifierRun | undefined, asker?: Asker) => Promise<PermissionAnswer>;

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
      /** The session's Auto state, which outlives the turn. */
      readonly auto: { state: AutoState };
    };

export const NON_INTERACTIVE: Approval = { kind: 'non-interactive' };

export const freshAuto = (): { state: AutoState } => ({ state: AUTO_START });

export const modeOf = (approval: Approval): ApprovalMode => (approval.kind === 'interactive' ? approval.mode() : 'non-interactive');

/**
 * Settles a flagged command: the rule's verdict, then the classifier's for a gray one, then the user's for a question.
 * In Auto a classifier `ask` blocks the command without asking anyone, until the blocks pause Auto. `keep` runs, and
 * is awaited, when the user's yes outlives the call.
 */
export async function settle(
  approval: Approval,
  mode: ApprovalMode,
  denial: Denial,
  input: () => ClassifierInput,
  signal: AbortSignal,
  keep: (answer: KeptAnswer) => void | Promise<void> = () => {},
): Promise<ApprovalRecord> {
  const record = { mode, rule: denial.rule, reason: denial.reason, command: denial.command };
  if (approval.kind === 'non-interactive' || denial.verdict === 'deny') return { ...record, decidedBy: 'rule', verdict: 'deny' };
  const { auto } = approval;
  const classifier = denial.verdict === 'classify' ? await approval.classify(input(), signal) : undefined;
  const outcome = classifier === undefined ? 'ask-user' : CLASSIFIER_OUTCOMES[auto.state.phase][classifier.verdict];
  if (outcome !== 'ask-user') {
    auto.state = nextAutoState(auto.state, outcome);
    return { ...record, classifier, decidedBy: 'classifier', verdict: OUTCOME_VERDICTS[outcome] };
  }
  const answer = await approval.approve(denial, classifier);
  if (answer === 'allow-session' || answer === 'allow-workspace') await keep(answer);
  const allowed = answer !== 'reject';
  auto.state = nextAutoState(auto.state, allowed ? 'user-allow' : 'user-reject');
  return { ...record, ...(classifier === undefined ? {} : { classifier }), decidedBy: 'user', verdict: allowed ? 'allow' : 'deny' };
}

export function denialText({ mode, rule, command, reason, classifier, decidedBy }: ApprovalRecord): string {
  if (decidedBy === 'user') return `The user rejected \`${command}\`, so it did not run. ${STOP_AND_WAIT}`;
  if (rule === 'hook-ask') {
    return `denied: \`${command}\` did not run. ${reason} Nobody can answer here, so Geno refused it. Do not retry it; find another way, or say in your answer what you need the user to allow.`;
  }
  if (rule === 'workspace-deny') {
    return `denied: \`${command}\` matches ${reason}, which the user set in Settings under Permissions. Do not retry it; find another way, or say in your answer that the rule stops you.`;
  }
  if (decidedBy === 'classifier' && classifier?.verdict === 'ask') {
    return `denied: Auto mode blocked \`${command}\` without asking the user, because the safety classifier would not allow it: ${classifier.reason}. Do not retry it. Find another way, or say in your answer what you need the user to allow.`;
  }
  return `denied: \`${command}\` ${
    decidedBy === 'classifier'
      ? `was refused by the safety classifier: ${classifier?.reason}`
      : MODE_REFUSALS[mode] === undefined
        ? `uses ${reason}, which needs the user's approval`
        : `uses ${reason}. ${MODE_REFUSALS[mode]}`
  }. Do not retry it; find another way.`;
}

/** The error a refused call throws: a user's no ends the turn, and a rule's or the classifier's lets the model go on. */
export const refusalOf = (record: ApprovalRecord, text = denialText(record)): ToolError =>
  record.decidedBy === 'user' ? new ToolRejected(text, record) : new ToolDenied(text, record);

/**
 * The tool, refused while the session's mode leaves it out. Every mode is offered every tool, so the cached prefix
 * holds across a switch; this is what keeps Plan read-only.
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
  readonly check: CheckCommand | undefined;
  readonly checkAfterEdit: boolean;
  readonly approval: Approval;
  /** Stands in for the check command when the workspace has none and an editor is attached. */
  readonly diagnostics: Diagnostics | undefined;
  readonly rules: RuleAttacher;
  /** The slash commands as discovered now, for the skill tool. */
  readonly commands: () => Promise<readonly SlashCommand[]>;
  /** Set when the session runs in a lane: commands that would reach the main checkout are refused. */
  readonly lane?: LaneBounds | undefined;
  /** Where the session's background commands run; undefined for a subagent, which starts none. */
  readonly background?: SessionBackground | undefined;
  /** The workspace's remembered rules; undefined runs with none. */
  readonly permissions?: PermissionStore | undefined;
  /** What wakes the session later; undefined where nothing would, as in a command-line run or with auto-wake off. */
  readonly wakes?: SessionWakes | undefined;
  /** Searches the workspace's earlier sessions; undefined for a subagent, which is not offered recall. */
  readonly recall?: Recall | undefined;
  /** The user's gh, for watch_pr; undefined for a subagent, which is not offered it. */
  readonly pr?: PrTools | undefined;
};

export const CHECK_TIMEOUT_MS = 10 * 60 * 1000;

type CheckResult = { readonly passed: boolean; readonly text: string };

async function runCheck(tools: AgentToolEnv, ctx: ToolContext): Promise<CheckResult | undefined> {
  if (tools.check === undefined) return undefined;
  const { shown, run, writable } = tools.check;
  const result = await tools.sandbox.run(run, {
    cwd: ctx.workspace,
    env: tools.env,
    timeoutMs: CHECK_TIMEOUT_MS,
    signal: ctx.signal,
    writable,
  });
  const output = tail(result.output);
  return { passed: result.code === 0, text: `${checkHeadline(shown, result.code, result.timedOut)}${output === '' ? '' : `\n${neutralizeNoticeLines(output)}`}` };
}

const currentBase = async (ctx: ToolContext, file: string): Promise<BaseRead> => baseOf(await ctx.files.read(file), null);

/** An edit's result, for a file it made or one it changed. The model knows the file as it wrote it, as Claude Code's result says. */
const editedText = (shown: string, made: boolean): string => `${made ? 'Created' : 'Edited'} ${shown}. The file state is current in your context; no need to read it back.`;

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
      // read showed hidden characters as escapes, so an edit written from what it showed gets them back.
      const raw = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, typeof value === 'string' && key !== 'path' ? restoreHidden(value) : value]));
      const { proposed, change } = await applyEditToFile(ctx.files, file, { path: input.path, format: AGENT_EDIT_FORMAT, raw, base }, null);
      if (proposed.result.kind === 'failed') throw new ToolError(proposed.result.detail);
      // The stat goes first, so a change on disk after it is seen as one.
      const disk = await diskStat(file);
      const written = await ctx.files.read(file);
      reads.set(file, baseOf(written, null));
      const after = await afterEdit(ctx);
      const done = editedText(input.path, current.hash === null);
      const text = after === undefined ? done : `${done}\n\n${after}`;
      return { text, change, file: stampOf(file, written, disk) };
    },
  });
}

export function agentExecutors(tools: AgentToolEnv): Readonly<Record<AgentToolName, Executor>> {
  // What the model last saw of each file: the base an edit must still match.
  const reads = new Map<string, BaseRead>();

  // A credentials file opens only with the user's yes or the classifier's, as `cat .env` does.
  const askSecret: SecretGate = async (ctx, shown) => {
    const mode = modeOf(tools.approval);
    const denial = secretReadDenial(shown, mode);
    if (denial === undefined) return undefined;
    const approval = await settle(tools.approval, mode, denial, () => classifierInputOf(ctx.events(), denial.command, denial), ctx.signal);
    if (approval.verdict === 'deny') throw refusalOf(approval);
    return approval;
  };
  const gated = readTool(askSecret);

  const read: Executor = {
    ...gated,
    async run(raw, ctx) {
      // The base is the very text the read tool showed, so a change a moment later makes the next edit stale. The disk's
      // stat is taken before the text is read, so a change on disk after it is seen as one.
      let seen: string | null = null;
      let disk: DiskStat | undefined;
      const files: Files = {
        ...ctx.files,
        read: async (file) => {
          disk = await diskStat(file);
          return (seen = await ctx.files.read(file));
        },
      };
      const reply = await gated.run(raw, { ...ctx, files });
      const file = await resolveInside(ctx, (raw as { path: string }).path);
      await ctx.earlierCalls();
      reads.set(file, baseOf(seen, null));
      const stamp = stampOf(file, seen, disk);
      return stamp === undefined ? reply : { ...(typeof reply === 'string' ? { text: reply } : reply), file: stamp };
    },
  };

  const edit = editExecutor(reads, async (ctx) => (tools.checkAfterEdit ? (await runCheck(tools, ctx))?.text : undefined));

  /** The lane check, rules, classifier and approval every command goes through, foreground or background; a refusal throws. */
  const approveCommand = async (command: string, ctx: ToolContext, background: boolean): Promise<ApprovalRecord | undefined> => {
    const mode = modeOf(tools.approval);
    if (background && mode === 'plan') throw new ToolError(`background commands are not available: ${MODE_REFUSALS.plan}. Do not retry it.`);
    const outOfLane = tools.lane === undefined ? undefined : laneCommandDenial(command, ctx.workspace, tools.lane);
    if (outOfLane !== undefined) throw new ToolError(laneDenialText(outOfLane));
    const { permissions } = tools;
    const denial = ruledDenial(command, tools.scope, mode, (await permissions?.list()) ?? [], ctx.hookAllowed === true);
    const keep = async () => {
      if (denial?.offer !== undefined) await permissions?.add('allow', denial.offer as CommandPattern);
    };
    const approval =
      denial === undefined ? undefined : await settle(tools.approval, mode, denial, () => classifierInputOf(ctx.events(), command, denial), ctx.signal, keep);
    if (approval?.verdict === 'deny') throw refusalOf(approval);
    return approval;
  };

  const startInBackground = (
    background: SessionBackground,
    command: string,
    description: string | undefined,
    ctx: ToolContext,
    server?: Pick<JobStart, 'preview' | 'cwd' | 'env'>,
  ) =>
    background.jobs.start({
      sessionId: background.sessionId,
      toolUseId: ctx.toolUseId ?? '',
      command,
      description,
      cwd: ctx.workspace,
      env: tools.env,
      spillDir: ctx.spillDir,
      events: ctx.events(),
      sandbox: tools.sandbox,
      ...server,
    });

  const bash = executor({
    input: z.strictObject({
      command: z.string().min(1),
      description: optional(z.string()),
      timeout_seconds: optional(z.number().int().positive().max(MAX_BASH_TIMEOUT_SECONDS)),
      run_in_background: optional(z.boolean()),
    }),
    describe: ({ command }) => `bash ${command}`,
    async run({ command, description, timeout_seconds = DEFAULT_BASH_TIMEOUT_SECONDS, run_in_background = false }, ctx) {
      const background = run_in_background ? tools.background : undefined;
      if (run_in_background && background === undefined) throw new ToolError(NO_BACKGROUND);
      // Only where run_in_background and monitor exist to wait with instead; a subagent may still sleep.
      const sleep = run_in_background || tools.background === undefined ? undefined : leadingSleep(command);
      if (sleep !== undefined) throw new ToolError(sleepRefusal(sleep));
      const approval = await approveCommand(command, ctx, background !== undefined);
      if (background !== undefined) {
        const { text } = await startInBackground(background, command, description, ctx);
        return approval === undefined ? text : { text, approval };
      }
      const result = await tools.sandbox.run(command, {
        cwd: ctx.workspace,
        env: tools.env,
        timeoutMs: timeout_seconds * 1000,
        signal: ctx.signal,
      });
      const killedAfter = result.timedOut ? timeout_seconds : undefined;
      const failure = commandFailureLine(result.code, killedAfter);
      const truncated = result.truncated ? '[earlier output dropped]\n' : '';
      const output = `${neutralizeNoticeLines(result.output)}${result.output === '' || result.output.endsWith('\n') ? '' : '\n'}`;
      const reset = changesDirectory(command) ? `${cwdResetLine(ctx.workspace)}\n` : '';
      const text = `${failure === undefined ? '' : `${failure}\n`}${truncated}${output}${reset}${commandStatusLine(result.code, killedAfter)}`;
      return { text, approval, ...(failure === undefined ? {} : { status: 'error' }) };
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

  const all: Readonly<Record<AgentToolName, Executor>> = {
    ...EXECUTORS,
    read: withRuleAttachments(read, tools.rules),
    edit,
    bash,
    ...backgroundExecutors(tools.background),
    ...wakeExecutors(tools.wakes, tools.background, async (command, description, ctx) => {
      const approval = await approveCommand(command, ctx, true);
      const { job, text } = await startInBackground(tools.background!, command, description, ctx);
      return { job: job.id, text, approval };
    }),
    ...previewExecutors(tools.background, async (config, cwd, ctx) => {
      const command = commandLineOf(config);
      const approval = await approveCommand(command, ctx, true);
      // PORT is how Next.js and most dev servers pick their port, so the entry's port holds without a flag.
      const server = { preview: { name: config.name, url: config.url }, cwd, env: { ...tools.env, PORT: String(config.port) } };
      const { job } = await startInBackground(tools.background!, command, `Dev server ${config.name}`, ctx, server);
      return { job, approval };
    }),
    check,
    recall: recallExecutor(tools.recall),
    skill: skillExecutor(tools.commands),
    todo,
    watch_pr: watchPrExecutor(tools.wakes, tools.pr),
  };
  return Object.fromEntries(AGENT_TOOL_NAMES.map((name) => [name, inMode(name, all[name], tools.approval)])) as Record<AgentToolName, Executor>;
}
