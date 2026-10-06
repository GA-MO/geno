import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  AGENT_MODE_SYSTEM_PROMPTS,
  AGENT_TOOL,
  APPROVAL_MODES,
  AGENT_MODE_TOOL_DEFINITIONS,
  approvalQuestion,
  describeServerState,
  editorActionToolDefinitions,
  isSessionMode,
  MESSAGE_AGENT_TOOL,
  MESSAGE_AGENT_TOOL_DEFINITION,
  pstackNote,
  renderMemory,
  sessionModeOf,
  userToolDefinitions,
  WIDGET_TOOL,
  widgetToolDefinitions,
  type AssistantTurn,
  type EffortPolicy,
  type SessionMode,
  type TurnEvent,
  TELLS_MODEL,
  type Waiter,
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
import { drive, openForPrompt, positiveNumber, terminalSurface, workspaceDir, type DriveResult, type Limits, type Surface } from './drive.js';
import { Steers } from './steer.js';
import { bindSession, laneAt } from './lanes.js';
import { openMcpHub, type McpToolset } from './mcp/hub.js';
import { openSandbox, sandboxPolicy } from './sandbox.js';
import { memoryStore } from './memory.js';
import { permissionStore } from './permissions.js';
import { logMode } from './sessions.js';
import { isMissing, StoreError, type Store } from './store.js';
import { ruleAttacher } from './tools/rules.js';
import { agentExecutors, freshAuto, modeOf, type Approval, type Approver, type Diagnostics } from './tools/agent.js';
import { shownUserTools, userExecutors, type UserChannel } from './tools/user.js';
import { editorActionExecutors, type Editor } from './tools/editor.js';
import { showWidget } from './tools/widget.js';
import { loadAgents, mentionedCall, subagents, terminalChildHost, type SubagentHost, type Subagents } from './subagents.js';
import { DISK_FILES } from './files.js';
import type { ExternalAgents, KeyOf } from './external.js';
import { BackgroundJobs } from './background.js';
import type { Wakes } from './wakes.js';

/** `agentTool` lists the modes whose model may start subagents itself; `@` mentions work in every mode. */
const workspaceConfigSchema = z.looseObject({ check: z.string().min(1).optional(), agentTool: z.array(z.enum(APPROVAL_MODES)).optional() });

type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;

export async function workspaceConfig(workspace: string): Promise<WorkspaceConfig> {
  const file = path.join(workspace, '.gcode.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return {};
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
  return parsed.data;
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
  /** The editor that opens files, diffs and Explorer items for the model; a non-interactive run ignores it. */
  readonly editor?: Editor | undefined;
  /** Whether the editor draws widgets; a non-interactive run ignores it, having nobody to show them to. */
  readonly widgets?: boolean | undefined;
  /** Undefined uses the default policy. */
  readonly effortPolicy?: EffortPolicy | undefined;
  /** Where subagents show; undefined prints them on the terminal. */
  readonly childHost?: SubagentHost | undefined;
  /** Lets a non-interactive run start subagents that may change files. */
  readonly allowWorker?: boolean | undefined;
  /** A subagent call the caller issues as the user's own, as an `@` mention would; the Arena's review is one. */
  readonly issued?: AssistantTurn | undefined;
  /** The engine's external agents, which a child on an external backend runs in. */
  readonly externals?: ExternalAgents | undefined;
  readonly keyOf?: KeyOf | undefined;
  /**
   * What outlives this run in the engine process: its background commands, and the steers of it and its children,
   * which arrive in one inbox with the commands' ends. Undefined keeps both to this run, and its commands are killed
   * when it ends, as a CLI run's process ends with it.
   */
  readonly engine?: RunEngine | undefined;
};

export type RunEngine = { readonly jobs: BackgroundJobs; readonly steers: Steers; readonly wakes?: RunWakes | undefined };

/** What wakes the session after its turn ends: present only in the engine process, with auto-wake on. */
export type RunWakes = { readonly registry: Wakes; readonly waiter: Waiter; readonly secondMs: number };

/** Background commands and steers that live as long as one run, what arrives from them delivered to its loop. */
function runEngine(): RunEngine {
  const steers = new Steers();
  const jobs = new BackgroundJobs({
    changed: () => {},
    ended(end, job) {
      if (TELLS_MODEL(end.job.state)) steers.inbox.put(job.sessionId, end);
    },
  });
  return { jobs, steers };
}

export const askOnTerminal =
  (io: Io): Approver =>
  async (denial, classifier, asker) =>
    (await io.confirm(`${asker === undefined ? '' : `[${asker.name}] `}${approvalQuestion(denial, classifier)}`)) ? 'allow' : 'reject';

function modeFlag(raw: string | undefined): SessionMode | undefined {
  if (raw === undefined || isSessionMode(raw)) return raw;
  throw new UsageError('--mode must be ask or auto, or plan to plan without changing anything');
}

export async function runAgent(io: Io, store: Store, opened: OpenSession, prompt: string, options: AgentOptions): Promise<DriveResult> {
  const { session } = opened.log;
  const workspace = await workspaceDir(io.cwd, session.workspace);
  const tempDir = await mkdtemp(path.join(tmpdir(), 'gcode-agent-'));
  const home = io.env['HOME'] || homedir();
  const lane = await laneAt(workspace, home);
  if (lane !== undefined) await bindSession(lane, session.id);
  const sandbox = await openSandbox(await sandboxPolicy({ store, home, workspace, tempDir, ...(lane === undefined ? {} : { writable: lane.gitWritable }) }));
  let children: Subagents | undefined;
  const { jobs, steers, wakes } = options.engine ?? runEngine();
  const inbox = steers.open(session.id, undefined);
  let result: DriveResult | undefined;
  try {
    const { plugins } = await pluginLoader(io)(workspace);
    const homes = homesOf(store, io.env);
    const commands = () => loadCommands(workspace, homes, plugins);
    const skillRoots = await globalSkillRoots(homes, claudeDirOf(io.env));
    const pstack = (await commands()).some((c) => c.kind === 'skill' && c.name.startsWith('pstack:'));
    const genoTools = pstack ? await writeGenoTools(homeOf(store)) : undefined;
    const config = await workspaceConfig(workspace);
    const check = await checkCommand(options.check ?? config.check, workspace, homeOf(store));
    const permissions = permissionStore(homeOf(store), lane?.repo.main ?? workspace);
    const executorsFor = (approval: Approval, own = false) =>
      agentExecutors({
        sandbox,
        env: childEnv(io.env),
        scope: { workspace, tempDir, home },
        check,
        checkAfterEdit: options.checkAfterEdit,
        approval,
        diagnostics: options.diagnostics,
        rules: ruleAttacher(opened.log.events),
        commands,
        lane: lane?.bounds,
        background: own ? { jobs, sessionId: session.id } : undefined,
        permissions,
        wakes: own && wakes !== undefined ? { ...wakes, sessionId: session.id } : undefined,
      });
    const executors = executorsFor(options.approval, true);
    const repo = shadowRepoFor(store, session.workspace);
    const mcp = options.mcp;
    // The run offers the tools and prompt of the mode it starts in; a switch mid-run applies from the next run.
    // MCP tools are offered in every mode, and their rules decide what each mode lets them do.
    const startMode = options.approval.kind === 'interactive' ? options.approval.mode() : 'non-interactive';
    const memory = memoryStore(homeOf(store), workspace);
    const channel = options.approval.kind === 'interactive' ? (options.user ?? {}) : {};
    const user = userExecutors({ channel, mode: () => modeOf(options.approval), memory, sessionId: session.id });
    const widgets = options.approval.kind === 'interactive' && options.widgets === true;
    const editor = options.approval.kind === 'interactive' ? options.editor : undefined;
    const own = [
      ...AGENT_MODE_TOOL_DEFINITIONS[startMode],
      ...userToolDefinitions(startMode, shownUserTools(channel)),
      ...widgetToolDefinitions(startMode, widgets),
      ...editorActionToolDefinitions(startMode, editor !== undefined),
    ];
    const notes = renderMemory(await memory.list());
    const readRoots = [...plugins.map((plugin) => plugin.root), ...skillRoots, ...(genoTools === undefined ? [] : [genoTools])];
    const system = [AGENT_MODE_SYSTEM_PROMPTS[startMode], ...(genoTools === undefined ? [] : [pstackNote(genoTools)]), ...(notes === undefined ? [] : [notes])].join('\n\n');
    const scan = await loadAgents(workspace, homes, plugins);
    for (const problem of scan.problems) io.err(`agents: ${problem}`);
    // A prompt logged before the run, with its attachments, is the newest event.
    const logged = opened.log.events.at(-1);
    const asked = prompt !== '' ? prompt : logged?.kind === 'user' ? logged.content : '';
    const issued = options.issued ?? (await mentionedCall(asked, scan.agents, session));
    const agentTool = config.agentTool?.includes(startMode) === true;
    let tools = mcp === undefined ? own : [...own, ...mcp.tools];
    children = subagents({
      io,
      store,
      parent: opened,
      agents: scan.agents,
      limits: options.limits,
      approval: options.approval,
      allowWriters: options.allowWorker === true,
      files: options.surface?.files ?? DISK_FILES,
      host: options.childHost ?? terminalChildHost(io),
      executors: executorsFor,
      parentMode: () => ({ tools, system }),
      readRoots,
      externals: options.externals,
      keyOf: options.keyOf,
      steers,
      waits: wakes?.registry,
    });
    if (agentTool) tools = [...tools, children.tool, MESSAGE_AGENT_TOOL_DEFINITION];
    const mode = {
      tools,
      executors: {
        ...mcp?.executors,
        ...user,
        ...(widgets ? { [WIDGET_TOOL]: showWidget } : {}),
        ...(editor === undefined ? {} : editorActionExecutors(editor, repo)),
        ...(agentTool || issued !== undefined ? { [AGENT_TOOL]: children.executor } : {}),
        ...(agentTool ? { [MESSAGE_AGENT_TOOL]: children.message } : {}),
        ...executors,
      },
      system,
      readRoots,
      beforeCall: (events: readonly TurnEvent[]) => takeCheckpoint(repo, session.id, events),
      arrivals: () => steers.inbox.take(session.id),
      ...(options.effortPolicy === undefined ? {} : { effortPolicy: options.effortPolicy }),
      ...(issued === undefined ? {} : { issued }),
    };
    result = await drive(io, store, opened, prompt, options.limits, mode, { ...(options.surface ?? terminalSurface(io)), steers: inbox, wakeLater: wakes !== undefined });
    return result;
  } finally {
    steers.release(session.id, inbox);
    // A turn the model ended leaves its background children running to wake the session; any other end has nobody
    // left to take their reports.
    const wakeLater = wakes !== undefined && result?.reason === 'end_turn';
    if (wakeLater) children?.detach();
    else children?.stopBackground();
    const cleanUp = async () => {
      await children?.settled();
      if (options.engine === undefined) await jobs.kill('engine-exit', { sessionId: session.id });
      await sandbox.close();
      await rm(tempDir, { recursive: true, force: true });
    };
    if (wakeLater) void cleanUp().catch((error: unknown) => io.err(`could not clean up after ${session.id}'s background children: ${String(error)}`));
    else await cleanUp();
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
      'allow-worker': { type: 'boolean', default: false },
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
    : { kind: 'interactive', mode: () => mode, approve: askOnTerminal(io), classify: commandClassifier(io.env, io.fetch), auto: freshAuto() };
  const options = { limits, check: values.check, checkAfterEdit: values['check-after-edit'], approval, allowWorker: values['allow-worker'] };
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
