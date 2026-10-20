import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  AGENT_EDIT_FORMAT,
  baseOf,
  CELL_EDIT_MODES,
  CELL_TYPES,
  changeOf,
  changesDirectory,
  checkHeadline,
  commandLineOf,
  classifierInputOf,
  commandFailureLine,
  commandStatusLine,
  cwdResetLine,
  DEFAULT_BASH_TIMEOUT_SECONDS,
  fileStepRefusal,
  formatDiagnostics,
  hashText,
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
  outsideReadDenial,
  filesRun,
  sessionEdits,
  isSecretPath,
  pathRuleFor,
  SHOW_FILES_TOOL,
  restoreHidden,
  STOP_AND_WAIT,
  DONT_ASK,
  ruledDenial,
  secretReadDenial,
  serverRefusal,
  serverStartOf,
  sleepRefusal,
  staleBaseDetail,
  trackedFiles,
  trustedDomains,
  ruleDenial,
  unsandboxedDenial,
  userRuleDenial,
  type AgentToolName,
  type ApprovalMode,
  type ApprovalRecord,
  type BaseRead,
  type ClassifierInput,
  type ClassifierRun,
  type CommandPattern,
  type CommandScope,
  type Denial,
  type EditorDiagnostic,
  type LaneBounds,
  type PathTool,
  type Scripts,
  type SessionMode,
  type SlashCommand,
} from '@g-code/core';
import type { JobStart } from '../background.js';
import type { CheckCommand } from '../check-command.js';
import type { Classify } from '../classifier.js';
import type { WorkingDirectories } from '../directories.js';
import { diskStat, stampOf, type DiskStat } from '../file-tracker.js';
import { applyEditToFile, type Files } from '../files.js';
import { laneRecords, laneRepoOf } from '../lanes.js';
import { readLaunchConfigs } from '../preview.js';
import { membersOf, tail } from '../process.js';
import type { PermissionStore, SessionPermissions } from '../permissions.js';
import type { Sandbox } from '../sandbox.js';
import {
  displayPath,
  executor,
  isSecret,
  missingPath,
  pathRuleRefusal,
  secretRefusal,
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
import { GLOB_CHARS, grepExecutor } from './grep.js';
import { editNotebook, NotebookError, type CellEdit, type CellEdited } from './notebook.js';
import { EXECUTORS, type Executors } from './index.js';
import { readTool, type SecretGate } from './read.js';
import { withRuleAttachments, type RuleAttacher } from './rules.js';
import { recallExecutor, type Recall } from './recall.js';
import { showFilesExecutor, type ShowGate } from './show-files.js';
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
    };

export const NON_INTERACTIVE: Approval = { kind: 'non-interactive' };

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
 * In Auto the classifier's allow runs the command and its deny refuses it; its ask, or a failed call, puts the card
 * to the user. `keep` runs, and is awaited, when the user's yes outlives the call. Where the card would show, or where
 * a run nobody can answer would refuse only for that, the call's PermissionRequest hooks answer first; a refusal that
 * holds whoever answers never reaches them.
 */
export async function settle(
  approval: Approval,
  mode: ApprovalMode,
  denial: Denial,
  input: () => ClassifierInput | Promise<ClassifierInput>,
  call: CallScope,
  keep: (answer: KeptAnswer) => void | Promise<void> = () => {},
): Promise<ApprovalRecord> {
  const record = { mode, rule: denial.rule, reason: denial.reason, command: denial.command, ...(denial.line === undefined ? {} : { line: denial.line }) };
  const refused: ApprovalRecord = { ...record, decidedBy: 'rule', verdict: 'deny' };
  const hooked = async (): Promise<ApprovalRecord | undefined> => {
    const answer = call.permissionRequest === undefined || !hookMayAnswer(denial, mode) ? undefined : await call.permissionRequest(denial);
    if (answer === undefined || answer.kind === 'none') return undefined;
    if (answer.kind === 'deny') return { ...record, decidedBy: 'hook', verdict: 'deny', ...(answer.message === undefined ? {} : { message: answer.message }), ...(answer.interrupt ? { interrupt: true } : {}) };
    if (answer.input !== undefined) throw new PermissionRerun(answer.input);
    return { ...record, decidedBy: 'hook', verdict: 'allow' };
  };
  if (approval.kind === 'non-interactive' || denial.verdict === 'deny') return (await hooked()) ?? refused;
  const classifier = denial.verdict === 'classify' ? await approval.classify(await withTrustedDomains(input(), call), call.signal) : undefined;
  if (classifier !== undefined && classifier.verdict !== 'ask') return { ...record, classifier, decidedBy: 'classifier', verdict: classifier.verdict };
  const byHook = await hooked();
  if (byHook !== undefined) return { ...byHook, ...(classifier === undefined ? {} : { classifier }) };
  const answer = await approval.approve(denial, classifier);
  if (answer === 'allow-session' || answer === 'allow-workspace') await keep(answer);
  const allowed = typeof answer === 'string' && answer !== 'reject';
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
  if (rule === 'unsandboxed' && decidedBy === 'rule') {
    return mode === 'non-interactive'
      ? `denied: \`${command}\` would run outside the sandbox, which only the user can approve, and nobody can answer here. ${DONT_ASK}`
      : `denied: \`${command}\` would run outside the sandbox. ${MODE_REFUSALS[mode] ?? 'Only the user can approve that'}. Do not retry it; find another way.`;
  }
  if (rule === 'workspace-deny') {
    return `denied: \`${command}\` matches ${reason}. Do not retry it; find another way, or say in your answer that the rule stops you.`;
  }
  if (rule === 'workspace-ask') {
    return `denied: \`${command}\` matches ${reason}, and nobody can answer here. ${DONT_ASK}`;
  }
  // A path the user must allow is not a tool-specific block, so it gets no invitation to try another tool on it.
  if (mode === 'non-interactive' && decidedBy === 'rule' && rule === 'path-outside-workspace') {
    return `denied: \`${command}\` uses ${reason}, which needs the user's approval, and nobody can answer here. Do not reach that path another way; say in your answer what you need to read.`;
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
      : `${denialText(record)} Geno may read only in these directories in this session: ${readable.map((dir) => `'${dir}'`).join(', ')}. If the task needs another one, say so in your answer: the user can add it to permissions.additionalDirectories in .g-code/settings.json, or to the gcode.additionalDirectories setting in the editor.${JOB_OUTPUT.test(record.command) ? JOB_OUTPUT_HINT : ''}`,
  );

const JOB_OUTPUT = /\/background\/bg-\d+\.log\b/;
const JOB_OUTPUT_HINT = " That looks like another session's background output file: read this session's background commands with bash_output and their bg-N id.";

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

/** The scripts of the workspace's package.json; none when it has no readable one. */
async function scriptsOf(workspace: string): Promise<Scripts> {
  try {
    const { scripts } = JSON.parse(await readFile(path.join(workspace, 'package.json'), 'utf8')) as { scripts?: unknown };
    return typeof scripts === 'object' && scripts !== null ? (Object.fromEntries(Object.entries(scripts).filter(([, body]) => typeof body === 'string')) as Scripts) : {};
  } catch {
    return {};
  }
}

const UNSANDBOXED_BACKGROUND = 'dangerouslyDisableSandbox runs a command in the foreground only, not with run_in_background. Run it in the foreground, or in the background without the flag.';
const UNSANDBOXED_IN_LANE = 'dangerouslyDisableSandbox is not available in a lane: its sandbox is what keeps commands out of the main checkout. Run the command in the sandbox, or say in your answer what it needs.';
const LINGERING = '[Geno] A process this command started is still running. Geno stops it when this run ends.';
// The sandbox lets a command signal only processes of its own call, so a kill of a background job fails.
const SIGNAL_REFUSED = /not permitted|No such process/;
const SIGNAL_NOTE = '[Geno] The sandbox lets a command signal only what the same call started.';
const LINGERING_ADVICE = 'For a server or a watcher, use run_in_background instead: read it with bash_output and stop it with task_stop.';

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
  /** What the skill tool adds after a skill's body, such as the tool mapping for a pstack skill. */
  readonly skillNote?: ((name: string) => string | undefined) | undefined;
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

/**
 * What the model last saw of a file: this engine's own record, or else the log's last stamp of it, so a session resumed
 * in a new engine keeps the reads it made before (ISSUES.md G-05). The edit still refuses when the disk moved since.
 */
function lastSeen(reads: ReadonlyMap<string, BaseRead>, ctx: ToolContext, file: string): BaseRead | undefined {
  const known = reads.get(file);
  if (known !== undefined) return known;
  const stamped = trackedFiles(ctx.events()).get(file);
  return stamped === undefined ? undefined : { hash: stamped.hash, mtimeMs: null };
}

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
      const base = current.hash === null ? current : lastSeen(reads, ctx, file);
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

const notebookInput = z.strictObject({
  notebook_path: z.string().min(1),
  cell_id: optional(z.string().min(1)),
  new_source: optional(z.string()),
  cell_type: optional(z.enum(CELL_TYPES)),
  edit_mode: optional(z.enum(CELL_EDIT_MODES)),
});
type NotebookInput = z.infer<typeof notebookInput>;

function cellEditOf({ cell_id, new_source, cell_type, edit_mode = 'replace' }: NotebookInput): CellEdit {
  if (edit_mode === 'delete') {
    if (cell_id === undefined) throw new ToolError('cell_id is required to delete a cell');
    return { mode: 'delete', cellId: cell_id };
  }
  if (new_source === undefined) throw new ToolError(`new_source is required to ${edit_mode === 'insert' ? 'insert' : 'replace'} a cell`);
  if (edit_mode === 'insert') {
    if (cell_type === undefined) throw new ToolError('cell_type is required with edit_mode insert: code or markdown');
    return { mode: 'insert', after: cell_id, source: restoreHidden(new_source), cellType: cell_type };
  }
  if (cell_id === undefined) throw new ToolError('cell_id is required to replace a cell');
  return { mode: 'replace', cellId: cell_id, source: restoreHidden(new_source), cellType: cell_type };
}

function notebookEditedText(shown: string, edit: CellEdit, done: CellEdited): string {
  const place = `cell ${done.index + 1} of ${done.cells}`;
  const firstMoved = edit.mode === 'insert' ? done.index + 1 : done.index;
  const moved = done.byPlace && edit.mode !== 'replace' && firstMoved < done.cells ? ' Its cells have no ids, so the cells after it now show ids counted from their new places.' : '';
  const said =
    edit.mode === 'replace' ? `Replaced cell ${done.id} of ${shown}, now ${place}: ${done.cellType}${done.cellType === 'code' ? ', with its outputs cleared' : ''}.`
    : edit.mode === 'insert' ? `Inserted a ${done.cellType} cell with id ${done.id} in ${shown}, ${place}.`
    : `Deleted cell ${done.id} from ${shown}, which has ${done.cells} cell${done.cells === 1 ? '' : 's'} now.`;
  return `${said}${moved} The file state is current in your context; no need to read it back.`;
}

/**
 * The notebook_edit tool, under the guard edit has: the notebook must have been read, as `reads` holds it, and still
 * hold the text that read saw.
 */
export function notebookEditExecutor(reads: Map<string, BaseRead>, newId?: (taken: ReadonlySet<string>) => string): Executor {
  return executor({
    input: notebookInput,
    describe: ({ notebook_path, cell_id, edit_mode = 'replace' }) => `notebook_edit ${notebook_path} ${edit_mode}${cell_id === undefined ? '' : ` ${cell_id}`}`,
    async run(input, ctx) {
      const shown = input.notebook_path;
      if (path.extname(shown).toLowerCase() !== '.ipynb') throw new ToolError(`notebook_edit edits Jupyter notebooks (.ipynb); ${shown} is not one, so use edit`);
      const edit = cellEditOf(input);
      const file = await resolveWritable(ctx, shown);
      const current = await ctx.files.read(file);
      if (current === null) throw missingPath(ctx, shown);
      const base = lastSeen(reads, ctx, file);
      if (base === undefined) throw new ToolError(`read ${shown} before editing it`);
      if (hashText(current) !== base.hash) throw new ToolError(staleBaseDetail(shown));
      let done: CellEdited;
      try {
        done = editNotebook(current, edit, newId);
      } catch (error) {
        if (error instanceof NotebookError) throw new ToolError(`${shown} ${error.message}`);
        throw error;
      }
      if ((await ctx.files.write(file, done.text, hashText(current))) === 'stale-base') throw new ToolError(staleBaseDetail(shown));
      // The stat goes first, so a change on disk after it is seen as one.
      const disk = await diskStat(file);
      const written = await ctx.files.read(file);
      reads.set(file, baseOf(written, null));
      return { text: notebookEditedText(shown, edit, done), change: changeOf(file, current, done.text), file: stampOf(file, written, disk) };
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

  /**
   * Files the model saw lines of through grep: an edit may start from their text on disk now, as after a read. A path
   * read could not read, or a credentials file, stays unseen.
   */
  const sawFiles = async (given: readonly string[], ctx: ToolContext): Promise<void> => {
    await ctx.earlierCalls();
    const reach: ToolContext = { ...ctx, readRoots: [...ctx.readRoots, ...tools.directories.readable()] };
    for (const one of given) {
      const real = await resolveInside(reach, one).catch((error: unknown) => {
        if (error instanceof ToolError) return undefined;
        throw error;
      });
      if (real === undefined || isSecret(reach, real) || !(await stat(real)).isFile()) continue;
      const text = await ctx.files.read(real);
      if (text !== null) reads.set(real, baseOf(text, null));
    }
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
  const withPathRules = (tool: PathTool | undefined, inner: Executor, field: 'path' | 'notebook_path' = 'path'): Executor => ({
    ...inner,
    async run(raw, ctx) {
      const rules = (await tools.permissions?.list()) ?? [];
      if (!rules.some(isPathRule)) return inner.run(raw, ctx);
      const ruled: ToolContext = { ...ctx, pathRule: (on, file) => pathRuleFor(on, file, rules, { ...scope(), workspace: ctx.workspace }) };
      const given = (raw as Readonly<Record<string, unknown>>)[field];
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
  const askOutside = async (name: ReachTool | typeof SHOW_FILES_TOOL, { target, directory }: Outside, ctx: ToolContext): Promise<ApprovalRecord | undefined> => {
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

  /** The lanes this session's subagents worked in, where their screenshots and reports are; none outside a git checkout. */
  const childLanes = async (ctx: ToolContext): Promise<string[]> => {
    const children = new Set<string>(ctx.events().flatMap((event) => (event.kind === 'child-start' ? [event.child] : [])));
    if (children.size === 0) return [];
    const repo = await laneRepoOf(ctx.workspace).catch(() => undefined);
    if (repo === undefined) return [];
    return (await laneRecords(repo)).flatMap((record) => (record.session !== null && children.has(record.session) ? [record.path] : []));
  };

  /**
   * show_files: the workspace, the directories the read tools reach, the session's scratchpad and spill folder and its
   * subagents' lanes show unasked; any other path meets the question a read outside meets. A credentials file and a
   * Read deny refuse the file, and a Read ask rule asks first.
   */
  const showGate: ShowGate = async (ctx, given) => {
    const lexical = path.resolve(ctx.workspace, given);
    const real = await realOrUndefined(lexical);
    if (real === undefined) throw missingPath(ctx, given);
    const spill = await realOrUndefined(ctx.spillDir);
    const scratch = await realOrUndefined(tools.scope.tempDir);
    const own = [...(spill === undefined ? [] : [spill]), ...(scratch === undefined ? [] : [scratch]), ...tools.directories.readable(), ...(await childLanes(ctx))];
    const reach: ToolContext = { ...ctx, readRoots: [...ctx.readRoots, ...own] };
    const inside = [ctx.workspace, ctx.spillDir, ...reach.readRoots].some((root) => within(root, real));
    if (isSecret(reach, lexical) || isSecret(reach, real) || (!inside && isSecretPath(real))) throw new ToolError(secretRefusal(SHOW_FILES_TOOL, given));
    const rules = (await tools.permissions?.list()) ?? [];
    const rule = pathRuleFor('read', lexical, rules, { ...scope(), workspace: ctx.workspace }) ?? pathRuleFor('read', real, rules, { ...scope(), workspace: ctx.workspace });
    if (rule?.effect === 'deny') throw new ToolError(pathRuleRefusal(SHOW_FILES_TOOL, given, rule));
    const ruled = rule === undefined ? undefined : await askPathRule('read', given, { ...reach, readRoots: [...reach.readRoots, path.dirname(real)], pathRule: () => rule });
    if (inside) return { real, approval: ruled };
    return { real, approval: ruled ?? (await askOutside(SHOW_FILES_TOOL, { target: real, directory: path.dirname(real) }, reach)) };
  };

  /** An edit may also write in the directories the user added as writable. */
  const withWriteRoots = (inner: Executor): Executor => ({
    ...inner,
    run: (raw, ctx) => inner.run(raw, { ...ctx, readRoots: [...ctx.readRoots, ...tools.directories.readable()], writeRoots: tools.directories.writable() }),
  });

  // The process groups of commands that left something running, which a kill may stop as the background jobs' may.
  const leftRunning = new Set<number>();
  const ownProcesses = (): Promise<ReadonlySet<number>> => {
    const jobs = tools.background === undefined ? [] : tools.background.jobs.jobs(tools.background.sessionId).filter((job) => job.state.status === 'running');
    return membersOf(new Set([...leftRunning, ...jobs.map((job) => job.pid)]));
  };
  /** The scope a command line is judged in: the session's spill folder, where its jobs' output goes, reads as the workspace does. */
  const commandScope = async (command: string, ctx: ToolContext): Promise<CommandScope> => {
    const base = scope();
    const spill = await realOrUndefined(ctx.spillDir);
    const directories = [...(base.directories ?? []), ctx.spillDir, ...(spill === undefined ? [] : [spill])];
    return { ...base, directories, ...(/\bkill\b/.test(command) ? { processes: await ownProcesses() } : {}) };
  };
  /** A refused kill names task_stop, which stops a background command without reaching anything else. */
  const killHint = (): string => {
    if (tools.background === undefined) return '';
    const jobs = tools.background.jobs.running(tools.background.sessionId);
    return jobs.length === 0
      ? ' To stop a background command Geno started, call task_stop with its bg-N id; list_agents lists them.'
      : ` To stop a background command Geno started, call task_stop with its id: ${jobs.map((job) => `${job.id} (\`${job.command}\`)`).join(', ')}.`;
  };

  /**
   * The lane check, rules, classifier and approval every command goes through, foreground or background; a refusal
   * throws. A command to run `unsandboxed` always waits for the user's yes, whatever the rules allow.
   */
  const approveCommand = async (command: string, ctx: ToolContext, background: boolean, unsandboxed = false): Promise<ApprovalRecord | undefined> => {
    const mode = modeOf(tools.approval);
    if (background && mode === 'plan') throw new ToolError(`background commands are not available: ${MODE_REFUSALS.plan}. Do not retry it.`);
    const outOfLane = tools.lane === undefined ? undefined : laneCommandDenial(command, ctx.workspace, tools.lane);
    if (outOfLane !== undefined) throw new ToolError(laneDenialText(outOfLane));
    const { permissions } = tools;
    const rules = (await permissions?.list()) ?? [];
    const judged = await commandScope(command, ctx);
    const ruled = ruledDenial(command, judged, mode, rules, ctx.hookAllowed === true);
    // A run nobody can answer offers no rule to keep, so a PermissionRequest hook reads the one Ask's card would offer.
    const offer = ruled === undefined || mode !== 'non-interactive' || ctx.permissionRequest === undefined ? undefined : ruledDenial(command, judged, 'ask', rules)?.offer;
    const denial = unsandboxed ? unsandboxedDenial(command, mode, ruled) : ruled === undefined || offer === undefined ? ruled : { ...ruled, offer };
    const keep = async () => {
      if (denial?.offer !== undefined) await permissions?.add({ effect: 'allow', pattern: denial.offer as CommandPattern });
    };
    const approval =
      denial === undefined ? undefined : await settle(tools.approval, mode, denial, () => commandInputOf(ctx, command, denial), ctx, keep);
    if (approval?.verdict === 'deny') {
      if (approval.rule === 'path-outside-workspace') throw outsideRefusal(approval, readableDirs(ctx));
      throw approval.rule === 'process-kill' && approval.decidedBy !== 'user' ? refusalOf(approval, `${denialText(approval)}${killHint()}`) : refusalOf(approval);
    }
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
      dangerouslyDisableSandbox: optional(z.boolean()),
    }),
    describe: ({ command }) => `bash ${command}`,
    async run({ command, description, timeout_seconds = DEFAULT_BASH_TIMEOUT_SECONDS, run_in_background = false, dangerouslyDisableSandbox: outside = false }, ctx) {
      if (outside && run_in_background) throw new ToolError(UNSANDBOXED_BACKGROUND);
      // A lane's sandbox is what keeps its commands out of the main checkout.
      if (outside && tools.lane !== undefined) throw new ToolError(UNSANDBOXED_IN_LANE);
      const background = run_in_background ? tools.background : undefined;
      if (run_in_background && background === undefined) throw new ToolError(NO_BACKGROUND);
      // Only where run_in_background and monitor exist to wait with instead; a subagent may still sleep.
      const sleep = run_in_background || tools.background === undefined ? undefined : leadingSleep(command);
      if (sleep !== undefined) throw new ToolError(sleepRefusal(sleep));
      const server = run_in_background || tools.background === undefined ? undefined : serverStartOf(command, await scriptsOf(ctx.workspace));
      if (server !== undefined) {
        const launchFile = (await readLaunchConfigs(ctx.workspace)).configs[0]?.file;
        throw new ToolError(serverRefusal(server, { monitor: tools.wakes !== undefined, launchFile }));
      }
      // Before the approval, so a line that runs nothing asks nobody.
      const fileSteps = fileStepRefusal(command, ctx.workspace);
      if (fileSteps !== undefined) throw new ToolError(fileSteps);
      const approval = await approveCommand(command, ctx, background !== undefined, outside);
      if (background !== undefined) {
        const { text } = await startInBackground(background, command, description, ctx);
        return approval === undefined ? text : { text, approval };
      }
      const result = await tools.sandbox.run(command, {
        cwd: ctx.workspace,
        env: tools.env,
        timeoutMs: timeout_seconds * 1000,
        signal: ctx.signal,
        ...(outside ? { outside: true } : {}),
      });
      if (result.lingering !== undefined) leftRunning.add(result.lingering);
      const killedAfter = result.timedOut ? timeout_seconds : undefined;
      const failure = commandFailureLine(result.code, killedAfter);
      const truncated = result.truncated ? '[earlier output dropped]\n' : '';
      const output = `${neutralizeNoticeLines(result.output)}${result.output === '' || result.output.endsWith('\n') ? '' : '\n'}`;
      const reset = changesDirectory(command) ? `${cwdResetLine(ctx.workspace)}\n` : '';
      const notes = [
        ...(result.lingering === undefined ? [] : [tools.background === undefined ? LINGERING : `${LINGERING} ${LINGERING_ADVICE}`]),
        ...(failure !== undefined && tools.background !== undefined && /\bkill\b/.test(command) && SIGNAL_REFUSED.test(result.output) ? [`${SIGNAL_NOTE}${killHint()}`] : []),
      ];
      const text = `${failure === undefined ? '' : `${failure}\n`}${truncated}${output}${reset}${commandStatusLine(result.code, killedAfter)}${notes.map((note) => `\n${note}`).join('')}`;
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
    grep: withReach('grep', withPathRules(undefined, grepExecutor(sawFiles))),
    list: withReach('list', withPathRules(undefined, EXECUTORS.list)),
    read: withReach('read', withRuleAttachments(withPathRules('read', read), tools.rules)),
    edit: withWriteRoots(withPathRules('edit', edit)),
    notebook_edit: withWriteRoots(withPathRules('edit', notebookEditExecutor(reads), 'notebook_path')),
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
    show_files: showFilesExecutor(showGate),
    skill: skillExecutor(tools.commands, tools.children?.start, tools.skillNote),
    todo,
    watch_pr: watchPrExecutor(tools.wakes, tools.pr),
  };
  const offered = Object.fromEntries(AGENT_TOOL_NAMES.map((name) => [name, inMode(name, all[name], tools.approval)])) as Record<AgentToolName, Executor>;
  return tools.permissions === undefined ? offered : withPermissions(offered, tools.permissions, tools.approval);
}
