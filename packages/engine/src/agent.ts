import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  AGENT_MODE_SYSTEM_PROMPTS,
  AGENT_MODE_TOOL_DEFINITIONS,
  approvalQuestion,
  describeServerState,
  isSessionMode,
  pstackNote,
  renderMemory,
  sessionModeOf,
  userToolDefinitions,
  WIDGET_TOOL,
  widgetToolDefinitions,
  type EffortPolicy,
  type SessionMode,
  type TurnEvent,
} from '@g-code/core';
import type { OpenSession } from './chat.js';
import { takeCheckpoint, shadowRepoFor } from './checkpoints.js';
import { checkCommand } from './check-command.js';
import { childEnv } from './child-env.js';
import { globalSkillRoots, homeOf, homesOf, loadCommands, pluginLoader } from './commands.js';
import { claudeDirOf } from './plugins.js';
import { commandClassifier } from './classifier.js';
import { UsageError, type Command, type Io } from './command.js';
import { writeGenoTools } from './geno-tools.js';
import { drive, openForPrompt, positiveNumber, workspaceDir, type DriveResult, type Limits, type Surface } from './drive.js';
import { openMcpHub, type McpToolset } from './mcp/hub.js';
import { openSandbox, sandboxPolicy } from './sandbox.js';
import { memoryStore } from './memory.js';
import { logMode } from './sessions.js';
import { isMissing, StoreError, type Store } from './store.js';
import { ruleAttacher } from './tools/rules.js';
import { agentExecutors, modeOf, type Approval, type Approver, type Diagnostics } from './tools/agent.js';
import { shownUserTools, userExecutors, type UserChannel } from './tools/user.js';
import { showWidget } from './tools/widget.js';

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
  readonly approval: Approval;
  /** Undefined runs on disk and prints to the terminal. */
  readonly surface?: Surface;
  readonly diagnostics?: Diagnostics | undefined;
  /** The session's MCP tools for this turn, after the built-in ones. */
  readonly mcp?: McpToolset | undefined;
  /** The cards the editor can show the user; a non-interactive run ignores it, having nobody to ask. */
  readonly user?: UserChannel | undefined;
  /** Whether the editor draws widgets; a non-interactive run ignores it, having nobody to show them to. */
  readonly widgets?: boolean | undefined;
  /** Undefined uses the default policy. */
  readonly effortPolicy?: EffortPolicy | undefined;
};

export const askOnTerminal =
  (io: Io): Approver =>
  async (denial, classifier) =>
    (await io.confirm(approvalQuestion(denial, classifier))) ? 'allow' : 'reject';

function modeFlag(raw: string | undefined): SessionMode | undefined {
  if (raw === undefined || isSessionMode(raw)) return raw;
  throw new UsageError('--mode must be ask or auto, or plan to plan without changing anything');
}

export async function runAgent(io: Io, store: Store, opened: OpenSession, prompt: string, options: AgentOptions): Promise<DriveResult> {
  const { session } = opened.log;
  const workspace = await workspaceDir(io.cwd, session.workspace);
  const tempDir = await mkdtemp(path.join(tmpdir(), 'gcode-agent-'));
  const home = io.env['HOME'] || homedir();
  const sandbox = await openSandbox(await sandboxPolicy({ store, home, workspace, tempDir }));
  try {
    const { plugins } = await pluginLoader(io)(workspace);
    const homes = homesOf(store, io.env);
    const commands = () => loadCommands(workspace, homes, plugins);
    const skillRoots = await globalSkillRoots(homes, claudeDirOf(io.env));
    const pstack = (await commands()).some((c) => c.kind === 'skill' && c.name.startsWith('pstack:'));
    const genoTools = pstack ? await writeGenoTools(homeOf(store)) : undefined;
    const executors = agentExecutors({
      sandbox,
      env: childEnv(io.env),
      scope: { workspace, tempDir, home },
      check: await checkCommand(options.check ?? (await configuredCheck(workspace)), workspace, homeOf(store)),
      checkAfterEdit: options.checkAfterEdit,
      approval: options.approval,
      diagnostics: options.diagnostics,
      rules: ruleAttacher(opened.log.events),
      commands,
    });
    const repo = shadowRepoFor(store, session.workspace);
    const mcp = options.mcp;
    // The run offers the tools and prompt of the mode it starts in; a switch mid-run applies from the next run.
    // MCP tools are offered in every mode, and their rules decide what each mode lets them do.
    const startMode = options.approval.kind === 'interactive' ? options.approval.mode() : 'non-interactive';
    const memory = memoryStore(homeOf(store), workspace);
    const channel = options.approval.kind === 'interactive' ? (options.user ?? {}) : {};
    const user = userExecutors({ channel, mode: () => modeOf(options.approval), memory, sessionId: session.id });
    const widgets = options.approval.kind === 'interactive' && options.widgets === true;
    const own = [...AGENT_MODE_TOOL_DEFINITIONS[startMode], ...userToolDefinitions(startMode, shownUserTools(channel)), ...widgetToolDefinitions(startMode, widgets)];
    const notes = renderMemory(await memory.list());
    const mode = {
      tools: mcp === undefined ? own : [...own, ...mcp.tools],
      executors: { ...mcp?.executors, ...user, ...(widgets ? { [WIDGET_TOOL]: showWidget } : {}), ...executors },
      system: [AGENT_MODE_SYSTEM_PROMPTS[startMode], ...(genoTools === undefined ? [] : [pstackNote(genoTools)]), ...(notes === undefined ? [] : [notes])].join('\n\n'),
      readRoots: [...plugins.map((plugin) => plugin.root), ...skillRoots, ...(genoTools === undefined ? [] : [genoTools])],
      beforeCall: (events: readonly TurnEvent[]) => takeCheckpoint(repo, session.id, events),
      ...(options.effortPolicy === undefined ? {} : { effortPolicy: options.effortPolicy }),
    };
    return await drive(io, store, opened, prompt, options.limits, mode, options.surface);
  } finally {
    await sandbox.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

/** The per-run limit flags of every command that runs the agent. */
export const LIMIT_FLAGS = {
  'max-turns': { type: 'string', default: '40' },
  'max-cost': { type: 'string', default: '0.40' },
} as const;

export const limitsOf = (values: { readonly 'max-turns': string; readonly 'max-cost': string }): Limits => ({
  maxTurns: positiveNumber('max-turns', values['max-turns'], true),
  maxCostUsd: positiveNumber('max-cost', values['max-cost'], false),
});

export const agent: Command = async (args, { io, store }) => {
  const { values, positionals } = parseArgs({
    args,
    strict: true,
    allowPositionals: true,
    allowNegative: true,
    options: {
      session: { type: 'string' },
      workspace: { type: 'string' },
      ...LIMIT_FLAGS,
      check: { type: 'string' },
      'check-after-edit': { type: 'boolean', default: true },
      'non-interactive': { type: 'boolean', default: false },
      mode: { type: 'string' },
      mcp: { type: 'boolean' },
    },
  });
  const task = positionals.join(' ').trim();
  const limits = limitsOf(values);
  const chosen = modeFlag(values.mode);
  if (chosen !== undefined && values['non-interactive']) throw new UsageError('--mode is for a user at the terminal; drop it with --non-interactive');
  const opened = await openForPrompt(io, store, values, task, 'task');
  const log = chosen === undefined ? opened.log : await logMode(opened.log, chosen);
  const mode = sessionModeOf(log.events);
  const approval: Approval = values['non-interactive']
    ? { kind: 'non-interactive', mcp: values.mcp === true }
    : { kind: 'interactive', mode: () => mode, approve: askOnTerminal(io), classify: commandClassifier(io.env, io.fetch) };
  const options = { limits, check: values.check, checkAfterEdit: values['check-after-edit'], approval };
  // MCP is on for a user at the terminal unless --no-mcp, and off in a non-interactive run unless --mcp.
  if (!(values['non-interactive'] ? values.mcp === true : values.mcp !== false)) return (await runAgent(io, store, { ...opened, log }, task, options)).exitCode;
  const hub = await openMcpHub({ store, env: io.env, workspace: await workspaceDir(io.cwd, log.session.workspace), acp: [] });
  try {
    // A one-shot run has only this turn, so it waits for its servers.
    await hub.start();
    const mcp = await hub.toolset(approval);
    for (const problem of hub.problems) io.err(`mcp: ${problem}`);
    for (const view of hub.views()) if (view.state.status === 'untrusted' || view.state.status === 'failed') io.err(`mcp: ${view.name} is ${describeServerState(view.state)}`);
    return (await runAgent(io, store, { ...opened, log }, task, { ...options, mcp })).exitCode;
  } finally {
    await hub.stop();
  }
};
