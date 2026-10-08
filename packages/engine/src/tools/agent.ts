import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
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
  hookMayAnswer,
  isPathRule,
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
  outsideReadDenial,
  filesRun,
  sessionEdits,
  pathRuleFor,
  restoreHidden,
  STOP_AND_WAIT,
  DONT_ASK,
  ruledDenial,
  secretReadDenial,
  sleepRefusal,
  trustedDomains,
  ruleDenial,
  userRuleDenial,
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
  type PathTool,
  type SessionMode,
  type SlashCommand,
} from '@g-code/core';
import type { JobStart } from '../background.js';
import type { CheckCommand } from '../check-command.js';
import type { Classify } from '../classifier.js';
import type { WorkingDirectories } from '../directories.js';
import { diskStat, stampOf, type DiskStat } from '../file-tracker.js';
import { applyEditToFile, type Files } from '../files.js';
import { tail } from '../process.js';
import type { PermissionStore, SessionPermissions } from '../permissions.js';
import type { Sandbox } from '../sandbox.js';
import {
  displayPath,
  executor,
  optional,
  realOrUndefined,
  resolveInside,
  resolveWritable,
  within,
  ToolDenied,
  ToolError,
  PermissionRerun,
  ToolRejected,
  type Executor,
  type ToolContext,
  type ToolReply,
} from './context.js';
import { backgroundExecutors, NO_BACKGROUND, type SessionBackground } from './background.js';
import { previewExecutors } from './preview.js';
import { GLOB_CHARS } from './grep.js';
import { EXECUTORS, type Executors } from './index.js';
import { readTool, type SecretGate } from './read.js';
import { withRuleAttachments, type RuleAttacher } from './rules.js';
import { recallExecutor, type Recall } from './recall.js';
import { skillExecutor } from './skill.js';
import { wakeExecutors, type SessionWakes } from './wake.js';
import { workExecutors, type SessionChildren } from './work.js';
import { watchPrExecutor, type PrTools } from './pr.js';
import { todo } from './todo.js';

/**
 * The user's answer. `allow-session` is offered for an MCP tool, which it allows for the rest of the session, and with
 * a read's `directory`, which it lets the session read. `allow-workspace` is offered only with a command's `offer`,
 * and saves that allow rule for the workspace. A `comment` is a no that tells the agent what to do instead.
 */
export type PermissionAnswer = 'allow' | 'allow-session' | 'allow-workspace' | 'reject' | { readonly comment: string };
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
 * The call a question is about: its signal, its PermissionRequest hooks, which answer a card before the user, and the
 * workspace's rules, whose allowed hosts the classifier is told.
 */
export type CallScope = Pick<ToolContext, 'signal' | 'permissionRequest' | 'permissions'>;

async function withTrustedDomains(input: ClassifierInput | Promise<ClassifierInput>, call: CallScope): Promise<ClassifierInput> {
  const domains = trustedDomains((await call.permissions?.list()) ?? []);
  return domains.length === 0 ? input : { ...(await input), trustedDomains: domains };
}

/**
 * Settles a flagged command: the rule's verdict, then the classifier's for a gray one, then the user's for a question.
 * In Auto a classifier `ask` blocks the command without asking anyone, until the blocks pause Auto. `keep` runs, and
 * is awaited, when the user's yes outlives the call. Where the card would show, or where a run nobody can answer would
 * refuse only for that, the call's PermissionRequest hooks answer first; a refusal that holds whoever answers never
 * reaches them.
 */
export async function settle(
  approval: Approval,
  mode: ApprovalMode,
  denial: Denial,
  input: () => ClassifierInput | Promise<ClassifierInput>,
  call: CallScope,
  keep: (answer: KeptAnswer) => void | Promise<void> = () => {},
): Promise<ApprovalRecord> {
  const record = { mode, rule: denial.rule, reason: denial.reason, command: denial.command };
  const refused: ApprovalRecord = { ...record, decidedBy: 'rule', verdict: 'deny' };
  const hooked = async (): Promise<ApprovalRecord | undefined> => {
    const answer = call.permissionRequest === undefined || !hookMayAnswer(denial, mode) ? undefined : await call.permissionRequest(denial);
    if (answer === undefined || answer.kind === 'none') return undefined;
    if (answer.kind === 'deny') return { ...record, decidedBy: 'hook', verdict: 'deny', ...(answer.message === undefined ? {} : { message: answer.message }), ...(answer.interrupt ? { interrupt: true } : {}) };
    if (answer.input !== undefined) throw new PermissionRerun(answer.input);
    return { ...record, decidedBy: 'hook', verdict: 'allow' };
  };
  if (approval.kind === 'non-interactive' || denial.verdict === 'deny') return (await hooked()) ?? refused;
  const { auto } = approval;
  const classifier = denial.verdict === 'classify' ? await approval.classify(await withTrustedDomains(input(), call), call.signal) : undefined;
  const outcome = classifier === undefined ? 'ask-user' : CLASSIFIER_OUTCOMES[auto.state.phase][classifier.verdict];
  if (outcome !== 'ask-user') {
    auto.state = nextAutoState(auto.state, outcome);
    return { ...record, classifier, decidedBy: 'classifier', verdict: OUTCOME_VERDICTS[outcome] };
  }
  const byHook = await hooked();
  if (byHook !== undefined) return { ...byHook, ...(classifier === undefined ? {} : { classifier }) };
  const answer = await approval.approve(denial, classifier);
  if (answer === 'allow-session' || answer === 'allow-workspace') await keep(answer);
  const allowed = typeof answer === 'string' && answer !== 'reject';
  auto.state = nextAutoState(auto.state, allowed ? 'user-allow' : 'user-reject');
  const comment = typeof answer === 'string' ? {} : { comment: answer.comment };
  return { ...record, ...(classifier === undefined ? {} : { classifier }), decidedBy: 'user', verdict: allowed ? 'allow' : 'deny', ...comment };
}

export function denialText({ mode, rule, command, reason, classifier, decidedBy, message, interrupt, comment }: ApprovalRecord): string {
  if (decidedBy === 'user') return `The user rejected \`${command}\`, so it did not run. ${comment === undefined ? STOP_AND_WAIT : `To tell you how to proceed, the user said:\n${comment}`}`;
  if (decidedBy === 'hook') {
    const why = message === undefined ? '' : `: ${message.replace(/\.$/, '')}`;
    return `denied: \`${command}\` did not run. A PermissionRequest hook answered for the user and refused it${why}. ${interrupt === true ? STOP_AND_WAIT : 'Do not retry it; find another way, or say in your answer what you need the user to allow.'}`;
  }
  if (rule === 'hook-ask') {
    return `denied: \`${command}\` did not run. ${reason} Nobody can answer here, so Geno refused it. ${DONT_ASK}`;
  }
  if (rule === 'workspace-deny') {
    return `denied: \`${command}\` matches ${reason}. Do not retry it; find another way, or say in your answer that the rule stops you.`;
  }
  if (rule === 'workspace-ask') {
    return `denied: \`${command}\` matches ${reason}, and nobody can answer here. ${DONT_ASK}`;
  }
  if (decidedBy === 'classifier' && classifier?.verdict === 'ask') {
    return `denied: Auto mode blocked \`${command}\` without asking the user, because the safety classifier would not allow it: ${classifier.reason}. Do not retry it. Find another way, or say in your answer what you need the user to allow.`;
  }
  if (mode === 'non-interactive' && decidedBy === 'rule') return `denied: \`${command}\` uses ${reason}, which needs the user's approval, and nobody can answer here. ${DONT_ASK}`;
  return `denied: \`${command}\` ${
    decidedBy === 'classifier'
      ? `was refused by the safety classifier: ${classifier?.reason}`
      : MODE_REFUSALS[mode] === undefined
        ? `uses ${reason}, which needs the user's approval`
        : `uses ${reason}. ${MODE_REFUSALS[mode]}`
  }. Do not retry it; find another way.`;
}

/**
 * The error a refused call throws: a user's no, or a hook's deny with `interrupt`, ends the turn, and a rule's, the
 * classifier's or another hook deny lets the model go on. A no with a comment lets the model go on with what it says.
 */
export const refusalOf = (record: ApprovalRecord, text = denialText(record)): ToolError =>
  (record.decidedBy === 'user' && record.comment === undefined) || record.interrupt === true ? new ToolRejected(text, record) : new ToolDenied(text, record);

/**
 * The refusal of a path outside every directory Geno may read, which names them, as Claude Code's does. The user's
 * no names none, since it says to stop.
 */
export const outsideRefusal = (record: ApprovalRecord, readable: readonly string[]): ToolError =>
  refusalOf(
    record,
    record.decidedBy === 'user'
      ? denialText(record)
      : `${denialText(record)} Geno may read only in these directories in this session: ${readable.map((dir) => `'${dir}'`).join(', ')}. If the task needs another one, say so in your answer: the user can add it in gcode.additionalDirectories or allow it for the session.`,
  );

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

/**
 * Every tool under the workspace's rules: refused in every mode while a Claude Code settings file denies it by name,
 * and run with the rules in its context, for the domain and MCP rules and the classifier. A denied tool stays offered,
 * as a mode's tools do, so the cached prefix holds when the file changes.
 */
export function withPermissions<T extends Executors>(executors: T, permissions: ToolPermissions, approval: Approval): T {
  const { deniedTool } = permissions;
  return Object.fromEntries(
    Object.entries(executors).map(([name, tool]) => [
      name,
      {
        ...tool,
        async run(raw, ctx) {
          const denied = await deniedTool?.(name);
          if (denied !== undefined) throw refusalOf({ mode: modeOf(approval), ...ruleDenial('deny', denied.text, denied.source, name), decidedBy: 'rule', verdict: 'deny' });
          return tool.run(raw, { ...ctx, permissions });
        },
      } satisfies Executor,
    ]),
  ) as T;
}

/** The rules a session's tools follow: the store, and Claude Code's bare-tool denies when its settings are read. */
export type ToolPermissions = PermissionStore & Partial<Pick<SessionPermissions, 'deniedTool'>>;

/** The read tools that may reach beyond the workspace, and the field that names where. */
type ReachTool = 'read' | 'grep' | 'glob' | 'list';
const REACH_FIELDS: Readonly<Record<ReachTool, 'path' | 'directory'>> = { read: 'path', grep: 'path', glob: 'directory', list: 'directory' };

const namedPath = (name: ReachTool, raw: unknown): string | undefined => {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)[REACH_FIELDS[name]] : undefined;
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/** Whether a path, as written, may lead out of the workspace; a link inside it that leads out is caught when the call runs. */
const mayLeave = (given: string | undefined): boolean => given !== undefined && (path.isAbsolute(given) || given.split('/').includes('..'));

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
  readonly permissions?: ToolPermissions | undefined;
  /** The directories beyond the workspace the tools and commands may reach, which a yes for the session adds to. */
  readonly directories: WorkingDirectories;
  /** What wakes the session later; undefined where nothing would, as in a command-line run or with auto-wake off. */
  readonly wakes?: SessionWakes | undefined;
  /** The background subagents of the session's run, for task_stop; undefined for a subagent, which starts none. */
  readonly children?: SessionChildren | undefined;
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
  // Read at each call, so a directory allowed for the session holds from the next call on.
  const scope = (): CommandScope => ({ ...tools.scope, directories: tools.directories.readable() });
  const readableDirs = (ctx: ToolContext): readonly string[] => [ctx.workspace, ...tools.directories.readable()];
  const inputOf = (ctx: ToolContext, command: string, denial: Denial): ClassifierInput => {
    const input = classifierInputOf(ctx.events(), command, denial);
    const writable = tools.directories.writable();
    return writable.length === 0 ? input : { ...input, writableDirectories: writable };
  };
  // A command that runs a file the session wrote is judged with that file's text, as Claude Code's monitor judges it.
  const commandInputOf = async (ctx: ToolContext, command: string, denial: Denial): Promise<ClassifierInput> => {
    const input = inputOf(ctx, command, denial);
    const edits = sessionEdits(ctx.events());
    if (edits.length === 0) return input;
    const run: { path: string; text: string }[] = [];
    for (const file of filesRun(command, scope())) {
      const real = (await realOrUndefined(file)) ?? file;
      if (!edits.includes(real)) continue;
      const text = await readFile(real, 'utf8').catch(() => undefined);
      if (text !== undefined) run.push({ path: displayPath(ctx, real), text });
    }
    return run.length === 0 ? input : { ...input, written: { run, edits: edits.map((file) => displayPath(ctx, file)) } };
  };

  // A credentials file opens only with the user's yes or the classifier's, as `cat .env` does.
  const askSecret: SecretGate = async (ctx, shown) => {
    const mode = modeOf(tools.approval);
    const denial = secretReadDenial(shown, mode);
    if (denial === undefined) return undefined;
    const approval = await settle(tools.approval, mode, denial, () => inputOf(ctx, denial.command, denial), ctx);
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

  const edit = editExecutor(reads, async (ctx) => {
    if (!tools.checkAfterEdit) return undefined;
    const denied = await tools.permissions?.deniedTool?.('check');
    if (denied !== undefined) return `The check did not run after the edit: the rule that denies \`${denied.text}\` in ${denied.source} stops every tool that runs a shell command.`;
    return (await runCheck(tools, ctx))?.text;
  });

  // A path rule's question or refusal before a read or an edit. Plan never asks, so there an ask rule refuses.
  const askPathRule = async (tool: PathTool, given: string, ctx: ToolContext): Promise<ApprovalRecord | undefined> => {
    const real = await (tool === 'read' ? resolveInside : resolveWritable)(ctx, given);
    const rule = ctx.pathRule?.(tool, path.resolve(ctx.workspace, given)) ?? ctx.pathRule?.(tool, real);
    if (rule === undefined) return undefined;
    const mode = modeOf(tools.approval);
    const ruled = userRuleDenial(rule, `${tool} ${displayPath(ctx, real)}`);
    const denial = mode === 'plan' ? { ...ruled, verdict: 'deny' as const } : ruled;
    const approval = await settle(tools.approval, mode, denial, () => inputOf(ctx, denial.command, denial), ctx);
    if (approval.verdict === 'deny') throw refusalOf(approval);
    return approval;
  };

  /**
   * A file tool under the workspace's path rules, read at each call so a rule added in Settings holds for the next one:
   * `read` and `edit` ask or refuse on their path, and every file tool leaves out what a `read` rule covers.
   */
  const withPathRules = (tool: PathTool | undefined, inner: Executor): Executor => ({
    ...inner,
    async run(raw, ctx) {
      const rules = (await tools.permissions?.list()) ?? [];
      if (!rules.some(isPathRule)) return inner.run(raw, ctx);
      const ruled: ToolContext = { ...ctx, pathRule: (on, file) => pathRuleFor(on, file, rules, { ...scope(), workspace: ctx.workspace }) };
      const given = (raw as { path?: unknown }).path;
      const approval = tool === undefined || typeof given !== 'string' ? undefined : await askPathRule(tool, given, ruled);
      const reply: ToolReply = await inner.run(raw, ruled);
      if (approval === undefined) return reply;
      return typeof reply === 'string' ? { text: reply, approval } : { approval, ...reply };
    },
  });

  /** Where a read outside every directory it may read lands, and the directory a yes for the session lets it read. */
  type Outside = { readonly target: string; readonly directory: string };

  /** The path `given` reaches when it is outside the workspace and every directory the read tools may read. */
  const outsideOf = async (ctx: ToolContext, name: ReachTool, given: string): Promise<Outside | undefined> => {
    const lexical = path.resolve(ctx.workspace, given);
    const real = await realOrUndefined(lexical);
    // grep takes a glob that names nothing on disk as a filter of the workspace, not as a path.
    if (real === undefined && name === 'grep' && GLOB_CHARS.test(given)) return undefined;
    const target = real ?? lexical;
    const spill = await realOrUndefined(ctx.spillDir);
    if ([ctx.workspace, ctx.spillDir, ...(spill === undefined ? [] : [spill]), ...ctx.readRoots].some((root) => within(root, target))) return undefined;
    const isDirectory = real !== undefined && (await stat(real)).isDirectory();
    return { target, directory: isDirectory ? target : path.dirname(target) };
  };

  /** The question `cat` of the same path meets, which offers the directory for the session; a refusal throws, naming the readable directories. */
  const askOutside = async (name: ReachTool, { target, directory }: Outside, ctx: ToolContext): Promise<ApprovalRecord | undefined> => {
    const mode = modeOf(tools.approval);
    const denial = outsideReadDenial(`${name} ${target}`, target, directory, mode, ctx.credentialPlaces);
    if (denial === undefined) return undefined;
    const keep = (answer: KeptAnswer) => {
      if (answer === 'allow-session' && denial.directory !== undefined) tools.directories.allow(denial.directory);
    };
    const approval = await settle(tools.approval, mode, denial, () => inputOf(ctx, denial.command, denial), ctx, keep);
    if (approval.verdict === 'deny') throw outsideRefusal(approval, readableDirs(ctx));
    return approval;
  };

  /**
   * A read tool that reaches beyond the workspace as Claude Code's working directories do. The added directories and
   * those allowed for the session read as the workspace does, the credentials rule judged below each. A path outside
   * all of them meets the question `cat` of it meets, unless a Read deny refuses it first; after a yes the call reads
   * it, the credentials rule judged on the whole path.
   */
  const withReach = (name: ReachTool, inner: Executor): Executor => ({
    ...inner,
    // A call that may ask runs alone, as a command that may ask does.
    concurrent: (raw) => inner.concurrent?.(raw) === true && !mayLeave(namedPath(name, raw)),
    async run(raw, ctx) {
      const reach: ToolContext = { ...ctx, readRoots: [...ctx.readRoots, ...tools.directories.readable()] };
      const given = namedPath(name, raw);
      const outside = given === undefined ? undefined : await outsideOf(reach, name, given);
      if (outside === undefined) return inner.run(raw, reach);
      const granted: ToolContext = { ...reach, readRoots: [...reach.readRoots, path.parse(outside.target).root] };
      const denied = pathRuleFor('read', outside.target, (await tools.permissions?.list()) ?? [], { ...scope(), workspace: ctx.workspace });
      if (denied?.effect === 'deny') return inner.run(raw, granted);
      const approval = await askOutside(name, outside, reach);
      const reply = await inner.run(raw, granted);
      if (approval === undefined) return reply;
      return typeof reply === 'string' ? { text: reply, approval } : { approval, ...reply };
    },
  });

  /** An edit may also write in the directories the user added as writable. */
  const withWriteRoots = (inner: Executor): Executor => ({
    ...inner,
    run: (raw, ctx) => inner.run(raw, { ...ctx, readRoots: [...ctx.readRoots, ...tools.directories.readable()], writeRoots: tools.directories.writable() }),
  });

  /** The lane check, rules, classifier and approval every command goes through, foreground or background; a refusal throws. */
  const approveCommand = async (command: string, ctx: ToolContext, background: boolean): Promise<ApprovalRecord | undefined> => {
    const mode = modeOf(tools.approval);
    if (background && mode === 'plan') throw new ToolError(`background commands are not available: ${MODE_REFUSALS.plan}. Do not retry it.`);
    const outOfLane = tools.lane === undefined ? undefined : laneCommandDenial(command, ctx.workspace, tools.lane);
    if (outOfLane !== undefined) throw new ToolError(laneDenialText(outOfLane));
    const { permissions } = tools;
    const rules = (await permissions?.list()) ?? [];
    const ruled = ruledDenial(command, scope(), mode, rules, ctx.hookAllowed === true);
    // A run nobody can answer offers no rule to keep, so a PermissionRequest hook reads the one Ask's card would offer.
    const offer = ruled === undefined || mode !== 'non-interactive' || ctx.permissionRequest === undefined ? undefined : ruledDenial(command, scope(), 'ask', rules)?.offer;
    const denial = ruled === undefined || offer === undefined ? ruled : { ...ruled, offer };
    const keep = async () => {
      if (denial?.offer !== undefined) await permissions?.add({ effect: 'allow', pattern: denial.offer as CommandPattern });
    };
    const approval =
      denial === undefined ? undefined : await settle(tools.approval, mode, denial, () => commandInputOf(ctx, command, denial), ctx, keep);
    if (approval?.verdict === 'deny') throw approval.rule === 'path-outside-workspace' ? outsideRefusal(approval, readableDirs(ctx)) : refusalOf(approval);
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
    glob: withReach('glob', withPathRules(undefined, EXECUTORS.glob)),
    grep: withReach('grep', withPathRules(undefined, EXECUTORS.grep)),
    list: withReach('list', withPathRules(undefined, EXECUTORS.list)),
    read: withReach('read', withRuleAttachments(withPathRules('read', read), tools.rules)),
    edit: withWriteRoots(withPathRules('edit', edit)),
    bash,
    ...backgroundExecutors(tools.background),
    ...workExecutors({ background: tools.background, wakes: tools.wakes, children: tools.children }),
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
    skill: skillExecutor(tools.commands, tools.children?.start),
    todo,
    watch_pr: watchPrExecutor(tools.wakes, tools.pr),
  };
  const offered = Object.fromEntries(AGENT_TOOL_NAMES.map((name) => [name, inMode(name, all[name], tools.approval)])) as Record<AgentToolName, Executor>;
  return tools.permissions === undefined ? offered : withPermissions(offered, tools.permissions, tools.approval);
}
