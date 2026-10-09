import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  AGENT_PROMPTS,
  AGENT_TOOL,
  AGENT_TOOL_DEFINITIONS,
  approvalQuestion,
  capabilitiesOf,
  fileToolNoter,
  toolResultText,
  DEFERRED_TOOLS_NOTE,
  describeServerState,
  editorActionToolDefinitions,
  SPINOFF_MODES,
  SPINOFF_NOTE,
  CHAPTER_MODES,
  CHAPTER_NOTE,
  chaptersOf,
  chapterToolDefinitions,
  MARK_CHAPTER_TOOL,
  spinoffsOf,
  spinoffToolDefinitions,
  isSessionMode,
  MESSAGE_AGENT_TOOL,
  MESSAGE_AGENT_TOOL_DEFINITION,
  noticeFor,
  offersToolSearch,
  HOOK_PERMISSION_MODES,
  pstackNote,
  READ_TERMINAL_TOOL,
  readTerminalToolDefinitions,
  RECALL_SEARCH,
  toolRoster,
  searchConfigOf,
  sessionModeOf,
  userToolDefinitions,
  WIDGET_TOOL,
  webToolDefinitions,
  widgetToolDefinitions,
  type AssistantTurn,
  type EffortPolicy,
  type LaneBounds,
  type PromptTier,
  type SessionMode,
  type SessionScope,
  type TurnEvent,
  TELLS_MODEL,
  type Waiter,
  sandboxDenials,
  SCHEDULE_TASK_TOOL,
  SCHEDULED_RUN_NOTE,
  scheduleToolDefinitions,
  WORKFLOW_TOOL,
  workflowToolDefinitions,
  subagentModelsOf,
  claudeDirOf,
} from '@g-code/core';
import { openSessionLog, type OpenSession } from './chat.js';
import { takeCheckpoint, shadowRepoFor } from './checkpoints.js';
import { checkCommand, type CheckCommand } from './check-command.js';
import { childEnv } from './child-env.js';
import { globalSkillRoots, homeOf, homesOf, loadCommands, pluginLoader } from './commands.js';
import { workspaceDir } from './workspace.js';
import { commandClassifier } from './classifier.js';
import { addedDirectories, settingDirectories, workingDirectories } from './directories.js';
import { UsageError, type Command, type Io } from './command.js';
import { EngineError } from './errors.js';
import { pstackMap, writeGenoTools } from './geno-tools.js';
import { drive, issuedOnce, openForPrompt, positiveNumber, terminalSurface, type Director, type DriveResult, type Limits, type Mode, type Surface } from './drive.js';
import { Steers } from './steer.js';
import { laneFor } from './lane-hooks.js';
import { bindSession, findLane, laneAt, laneRepoOf } from './lanes.js';
import { openMcpHub, type McpTools } from './mcp/hub.js';
import { openSandbox, sandboxPolicy, type Sandbox } from './sandbox.js';
import { memoryStore } from './memory.js';
import { layeredPermissions, permissionStore } from './permissions.js';
import { genoSettings } from './settings.js';
import { logMode } from './sessions.js';
import { sessionIndex } from './session-index.js';
import type { Store } from './store.js';
import { ruleAttacher } from './tools/rules.js';
import type { ToolContext } from './tools/context.js';
import { agentExecutors, freshAuto, modeOf, withPermissions, type Approval, type Approver, type Diagnostics } from './tools/agent.js';
import { shownUserTools, userExecutors, type UserChannel } from './tools/user.js';
import { editorActionExecutors, type Editor } from './tools/editor.js';
import { readTerminalExecutor, type TerminalReader } from './tools/terminal.js';
import { spinoffExecutors } from './tools/spinoff.js';
import { scheduleExecutor, type ScheduleTools } from './tools/schedule.js';
import { workflowExecutor, type WorkflowTools } from './tools/workflow.js';
import { workflowCommandCall } from './workflows.js';
import { chapterExecutor } from './tools/chapters.js';
import { showWidget } from './tools/widget.js';
import { rosterExecutors } from './tools/tool-search.js';
import { webExecutors, type WebDeps } from './tools/web.js';
import { loadAgents, mentionedCall, resumeCall, subagents, terminalChildHost, type OpenChildLane, type SubagentHost, type Subagents } from './subagents.js';
import { DISK_FILES } from './files.js';
import type { ExternalAgents, KeyOf } from './external.js';
import { BackgroundJobs } from './background.js';
import type { Wakes } from './wakes.js';
import { ghCli, githubRemote } from './gh.js';
import { HookSessions } from './hooks.js';

export type AgentOptions = {
  readonly limits: Limits;
  /** From --check; undefined falls back to the `check` setting. */
  readonly check: string | undefined;
  readonly checkAfterEdit: boolean;
  readonly approval: Approval;
  /** Undefined runs on disk and prints to the terminal. */
  readonly surface?: Surface;
  readonly diagnostics?: Diagnostics | undefined;
  /**
   * The session's MCP tools, deferred behind tool_search, and what the model is told of its servers at the safe point:
   * the run takes those ready as it starts, and each subagent those ready as it starts. Undefined for a run without MCP.
   */
  readonly mcp?: McpTools | undefined;
  /** The cards the editor can show the user; a non-interactive run ignores it, having nobody to ask. */
  readonly user?: UserChannel | undefined;
  /** The editor that opens files, diffs and Explorer items for the model; a non-interactive run ignores it. */
  readonly editor?: Editor | undefined;
  /** The editor whose terminals read_terminal reads; a non-interactive run ignores it. */
  readonly terminal?: TerminalReader | undefined;
  /** Whether the editor draws widgets; a non-interactive run ignores it, having nobody to show them to. */
  readonly widgets?: boolean | undefined;
  /** Whether the editor shows suggested tasks and starts them; a non-interactive run ignores it. */
  readonly spinoffs?: boolean | undefined;
  /** The workspace's scheduled tasks, for schedule_task; a non-interactive run ignores it. */
  readonly schedules?: ScheduleTools | undefined;
  /** The run is a scheduled task's, which nobody watches; its prompt says so. */
  readonly scheduled?: boolean | undefined;
  /** Whether the editor draws chapters; a non-interactive run ignores it. */
  readonly chapters?: boolean | undefined;
  /** Undefined uses the default policy. */
  readonly effortPolicy?: EffortPolicy | undefined;
  /** Replaces the model's prompt tier; for the eval that compares them. */
  readonly promptTier?: PromptTier | undefined;
  /** Replaces the `agentTool` setting for this run; for the eval that compares a run with and without it. */
  readonly agentTool?: boolean | undefined;
  /** From --append-system-prompt; undefined falls back to the `appendSystemPrompt` setting. It ends the system prompt. */
  readonly appendSystemPrompt?: string | undefined;
  /** Where subagents show; undefined prints them on the terminal. */
  readonly childHost?: SubagentHost | undefined;
  /** Lets a non-interactive run start subagents that may change files. */
  readonly allowWorker?: boolean | undefined;
  /**
   * Calls the caller issues as the user's own, in place of the model: the Arena's review, or a workflow's rounds. Such
   * calls may set a subagent's model and caps.
   */
  readonly director?: Director | undefined;
  /** The workspace's workflows, for the workflow tool and `/workflow`; a non-interactive run ignores it. */
  readonly workflows?: WorkflowTools | undefined;
  /** The engine's external agents, which a child on an external backend runs in. */
  readonly externals?: ExternalAgents | undefined;
  readonly keyOf?: KeyOf | undefined;
  /**
   * What outlives this run in the engine process: its background commands, and the steers of it and its children,
   * which arrive in one inbox with the commands' ends. Undefined keeps both to this run, and its commands are killed
   * when it ends, as a CLI run's process ends with it.
   */
  readonly engine?: RunEngine | undefined;
  /** Replaces how web_fetch resolves hosts and web_search reaches its provider, and hears each helper call; for tests and smokes. */
  readonly web?: Pick<WebDeps, 'resolve' | 'searchFetch' | 'onRead'> | undefined;
  /**
   * The user's hooks, for the command line and the editor; undefined runs none, as an eval or the Arena's ranking must
   * not depend on the machine's hooks. The session's first run in the process fires SessionStart.
   */
  readonly hooks?: HookSessions | undefined;
  /** Whether the editor trusts the workspace, which lets its own hooks run. */
  readonly trustedWorkspace?: boolean | undefined;
  /**
   * The directories the user allowed the session to read from a card, kept by the engine across the session's runs;
   * undefined keeps them to this run.
   */
  readonly sessionDirectories?: Set<string> | undefined;
  /** A subagent of the session to resume with the prompt as its message, as the user's own `message_agent` call. */
  readonly resumeAgent?: string | undefined;
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
  const head = opened.log.events[0];
  // The scratchpad the session's environment names, which outlives the run; a log from before sessions had one gets a
  // temp dir for this run only.
  const scratchpad = head?.kind === 'session-start' ? head.environment?.scratchpad : undefined;
  if (scratchpad !== undefined) await mkdir(scratchpad, { recursive: true, mode: 0o700 });
  const tempDir = scratchpad ?? (await mkdtemp(path.join(tmpdir(), 'gcode-agent-')));
  const home = io.env['HOME'] || homedir();
  const lane = await laneAt(workspace, home);
  if (lane !== undefined) await bindSession(lane, session.id);
  const permissions = layeredPermissions(
    permissionStore(homeOf(store), lane?.repo.main ?? workspace),
    { homes: homesOf(store, io.env), trusted: options.trustedWorkspace === true },
    { workspace, tempDir, home },
    io.err,
  );
  const ruledPaths = (root: string) => async () => sandboxDenials(await permissions.list(), { workspace: root, tempDir, home });
  const setting = settingDirectories(io.env);
  if (setting.problem !== undefined) io.err(`directories: ${setting.problem}`);
  const directories = workingDirectories(
    await addedDirectories([...setting.entries, ...(await permissions.directories())], lane?.repo.main ?? workspace, home, io.err),
    options.sessionDirectories ?? new Set(),
  );
  const writable = (more: readonly string[]) => [...more, ...directories.writable()];
  const sandbox = await openSandbox(await sandboxPolicy({ store, home, workspace, tempDir, writable: writable(lane?.gitWritable ?? []) }), ruledPaths(workspace));
  let children: Subagents | undefined;
  const { jobs, steers, wakes } = options.engine ?? runEngine();
  const inbox = steers.open(session.id, undefined);
  let result: DriveResult | undefined;
  try {
    const { plugins } = await pluginLoader(io)(workspace);
    const homes = homesOf(store, io.env);
    const commands = async () => (await loadCommands(workspace, homes, plugins)).commands;
    const skillRoots = await globalSkillRoots(homes, claudeDirOf(io.env));
    const pstack = (await commands()).some((c) => c.kind === 'skill' && c.name.startsWith('pstack:'));
    const settings = await genoSettings(homes, workspace);
    for (const note of settings.notes) io.err(`settings: ${note}`);
    const check = await checkCommand(options.check ?? settings.geno.check?.value, workspace, homeOf(store));
    const project: SessionScope = { kind: 'project', workspace: lane?.repo.main ?? session.workspace };
    const forkSource = head?.kind === 'session-start' ? head.fork?.sessionId : undefined;
    // The session, its forks and the session it was forked from all hold turns the model already has in context.
    const exclude = forkSource === undefined ? [session.id] : [session.id, forkSource];
    const recall = (query: string) => sessionIndex(store).search(query, project, { ...RECALL_SEARCH, exclude }, io.err);
    const prTools = { gh: ghCli(io.env), githubRemote };
    // Where the tools work: the session's workspace, or a subagent's lane with a sandbox of its own and no editor.
    type Place = {
      readonly sandbox: Sandbox;
      readonly workspace: string;
      readonly lane: LaneBounds | undefined;
      readonly check: CheckCommand | undefined;
      readonly diagnostics: Diagnostics | undefined;
    };
    const here: Place = { sandbox, workspace, lane: lane?.bounds, check, diagnostics: options.diagnostics };
    const fileNotes = fileToolNoter(opened.log.events.flatMap((e) => (e.kind === 'tool-result' ? [toolResultText(e)] : [])));
    const executorsFor = (approval: Approval, own = false, place: Place = here) =>
      agentExecutors({
        sandbox: place.sandbox,
        env: childEnv(io.env),
        scope: { workspace: place.workspace, tempDir, home },
        check: place.check,
        checkAfterEdit: options.checkAfterEdit,
        approval,
        diagnostics: place.diagnostics,
        rules: ruleAttacher(opened.log.events),
        fileNotes: own ? fileNotes : undefined,
        commands,
        // Read at each call: the mapping's file is written once the run's tools are known.
        skillNote: (name: string) => (genoTools !== undefined && name.startsWith('pstack:') ? pstackMap(genoTools, { subagents: own && agentTool }) : undefined),
        lane: place.lane,
        background: own ? { jobs, sessionId: session.id } : undefined,
        permissions,
        directories,
        wakes: own && wakes !== undefined ? { ...wakes, sessionId: session.id } : undefined,
        // Read at each call: the run's subagents start after its tools are built.
        children: own
          ? {
              stop: (childId: string) => children?.stop(childId),
              start: (agent: string, task: string, ctx: ToolContext) => children!.executor.run({ agent, task }, ctx),
            }
          : undefined,
        recall: own ? recall : undefined,
        pr: own ? prTools : undefined,
      });
    const executors = executorsFor(options.approval, true);
    const childLane: OpenChildLane = async (name, child) => {
      const repo = await laneRepoOf(workspace);
      const record = (await findLane(repo, name)) ?? (await laneFor(repo, '', store, io, name));
      const bound = await laneAt(record.path, home);
      if (bound === undefined) throw new EngineError(`lane ${name} at ${record.path} is not a lane checkout`);
      await bindSession(bound, child);
      const laneCheck = await checkCommand(options.check ?? settings.geno.check?.value, record.path, homeOf(store));
      const laneSandbox = await openSandbox(await sandboxPolicy({ store, home, workspace: record.path, tempDir, writable: writable(bound.gitWritable) }), ruledPaths(record.path));
      const place: Place = { sandbox: laneSandbox, workspace: record.path, lane: bound.bounds, check: laneCheck, diagnostics: undefined };
      return { lane: bound, executors: (approval) => executorsFor(approval, false, place), close: () => laneSandbox.close() };
    };
    const repo = shadowRepoFor(store, session.workspace);
    const mcp = await options.mcp?.(options.approval);
    // Every mode is offered the same tools and the same system prompt, so a switch keeps the cached prefix. The model is
    // told of a switch at the next safe point, and the new mode refuses the tools it leaves out. MCP tools are offered
    // in every mode, and their rules decide what each mode lets them do.
    const startMode = options.approval.kind === 'interactive' ? options.approval.mode() : 'non-interactive';
    const memory = memoryStore(homeOf(store), workspace);
    const channel = options.approval.kind === 'interactive' ? (options.user ?? {}) : {};
    const user = userExecutors({ channel, mode: () => modeOf(options.approval), memory, sessionId: session.id });
    const widgets = options.approval.kind === 'interactive' && options.widgets === true;
    const editor = options.approval.kind === 'interactive' ? options.editor : undefined;
    const terminal = options.approval.kind === 'interactive' ? options.terminal : undefined;
    const spinoffs = options.approval.kind === 'interactive' && options.spinoffs === true;
    const schedules = options.approval.kind === 'interactive' ? options.schedules : undefined;
    const workflows = options.approval.kind === 'interactive' ? options.workflows : undefined;
    const chapters = options.approval.kind === 'interactive' && options.chapters === true;
    const search = searchConfigOf(io.env);
    const web = webExecutors({ approval: options.approval, env: io.env, session, modelFetch: io.fetch, search, ...options.web });
    const own = [
      ...AGENT_TOOL_DEFINITIONS,
      ...userToolDefinitions(shownUserTools(channel)),
      ...widgetToolDefinitions(startMode, widgets),
      ...editorActionToolDefinitions(startMode, editor !== undefined),
      ...readTerminalToolDefinitions(startMode, terminal !== undefined),
      ...spinoffToolDefinitions(startMode, spinoffs),
      ...scheduleToolDefinitions(startMode, schedules !== undefined),
      ...workflowToolDefinitions(startMode, workflows !== undefined),
      ...chapterToolDefinitions(startMode, chapters),
      ...webToolDefinitions(search !== undefined),
    ];
    // `agentTool` lists the modes whose model may start subagents itself; `@` mentions work in every mode.
    const agentTool = options.agentTool ?? settings.geno.agentTool?.value.includes(startMode) === true;
    const genoTools = pstack ? await writeGenoTools(homeOf(store), { subagents: agentTool }) : undefined;
    const readRoots = [...plugins.map((plugin) => plugin.root), ...skillRoots, ...(genoTools === undefined ? [] : [genoTools])];
    const scan = await loadAgents(workspace, homes, plugins, subagentModelsOf(io.env));
    for (const problem of scan.problems) io.err(`agents: ${problem}`);
    // A prompt logged before the run, with its attachments, is the newest event.
    const logged = opened.log.events.at(-1);
    const asked = prompt !== '' ? prompt : logged?.kind === 'user' ? logged.content : '';
    const typed =
      options.resumeAgent !== undefined
        ? resumeCall(options.resumeAgent, asked, session)
        : ((await mentionedCall(asked, scan.agents, session)) ?? (workflows === undefined ? undefined : workflowCommandCall(logged, session)));
    const director = options.director ?? (typed === undefined ? undefined : issuedOnce(typed));
    let tools: readonly Tool[] = own;
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
      mcp:
        options.mcp === undefined
          ? undefined
          : async (approval, grant) => {
              const toolset = await options.mcp!(approval, grant);
              return toolset === undefined ? undefined : { ...toolset, executors: withPermissions(toolset.executors, permissions, approval) };
            },
      parentMode: () => ({ tools: mode.tools, system: mode.system }),
      readRoots,
      externals: options.externals,
      keyOf: options.keyOf,
      steers,
      waits: wakes?.registry,
      steps: options.director !== undefined,
      waiter: options.surface?.waiter,
      // A subagent's calls meet the user's tool hooks too, as in Claude Code, named by agent_id and agent_type.
      toolHooks: options.hooks === undefined ? undefined : (approval, agent) => options.hooks!.toolHooks(session.id, approval, agent),
      subagentHooks: options.hooks === undefined ? undefined : (agent, transcript, approval) => options.hooks!.subagentHooks(session.id, agent, transcript, approval),
      lanes: childLane,
    });
    if (agentTool) tools = [...tools, children.tool, MESSAGE_AGENT_TOOL_DEFINITION];
    const roster = toolRoster(tools, mcp?.tools);
    const appended = options.appendSystemPrompt ?? settings.geno.appendSystemPrompt?.value;
    const system = [
      AGENT_PROMPTS[options.promptTier ?? capabilitiesOf(session.provider, session.model).promptTier],
      ...(offersToolSearch(roster) ? [DEFERRED_TOOLS_NOTE] : []),
      ...(spinoffs && SPINOFF_MODES[startMode] ? [SPINOFF_NOTE] : []),
      ...(options.scheduled === true ? [SCHEDULED_RUN_NOTE] : []),
      ...(chapters && CHAPTER_MODES[startMode] ? [CHAPTER_NOTE] : []),
      ...(genoTools === undefined ? [] : [pstackNote(genoTools)]),
      ...(appended === undefined ? [] : [appended]),
    ].join('\n\n');
    const mode = {
      tools: roster.offered,
      executors: rosterExecutors(roster, {
        ...withPermissions({
          ...mcp?.executors,
          ...user,
          ...(widgets ? { [WIDGET_TOOL]: showWidget } : {}),
          ...(editor === undefined ? {} : editorActionExecutors(editor, repo)),
          ...(terminal === undefined ? {} : { [READ_TERMINAL_TOOL]: readTerminalExecutor(terminal) }),
          ...(spinoffs ? spinoffExecutors(async () => spinoffsOf((await openSessionLog(store, session.id, io)).events)) : {}),
          ...(schedules === undefined ? {} : { [SCHEDULE_TASK_TOOL]: scheduleExecutor(schedules) }),
          ...(chapters ? { [MARK_CHAPTER_TOOL]: chapterExecutor(async () => chaptersOf((await openSessionLog(store, session.id, io)).events)) } : {}),
          ...web,
          ...(workflows === undefined ? {} : { [WORKFLOW_TOOL]: workflowExecutor(workflows) }),
          ...(agentTool || director !== undefined ? { [AGENT_TOOL]: children.executor } : {}),
          ...(agentTool || options.resumeAgent !== undefined ? { [MESSAGE_AGENT_TOOL]: children.message } : {}),
        }, permissions, options.approval),
        ...executors,
      }),
      system,
      readRoots,
      beforeCall: (events: readonly TurnEvent[]) => takeCheckpoint(repo, session.id, events),
      arrivals: () => steers.inbox.take(session.id),
      notice: async (events: readonly TurnEvent[]) =>
        noticeFor(events, { mode: options.approval.kind === 'interactive' ? options.approval.mode() : undefined, memory: await memory.list(), mcp: mcp?.briefing }),
      ...(options.effortPolicy === undefined ? {} : { effortPolicy: options.effortPolicy }),
      ...(director === undefined ? {} : { director }),
    };
    const hooks = options.hooks;
    const started =
      hooks === undefined
        ? opened
        : await hooks.open({ io, store, opened, trusted: options.trustedWorkspace === true, permissionMode: HOOK_PERMISSION_MODES[startMode], workspace, scratchpad });
    const hooked: Mode =
      hooks === undefined
        ? mode
        : {
            ...mode,
            afterCompact: () => hooks.sessionStart(session.id, 'compact'),
            promptSubmitted: (prompt) => hooks.userPromptSubmit(session.id, prompt),
            toolHooks: hooks.toolHooks(session.id, options.approval),
            stop: hooks.stopHook(session.id),
          };
    result = await drive(io, store, started, prompt, options.limits, hooked, { ...(options.surface ?? terminalSurface(io)), steers: inbox, wakeLater: wakes !== undefined });
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
      if (scratchpad === undefined) await rm(tempDir, { recursive: true, force: true });
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
      'append-system-prompt': { type: 'string' },
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
  const appendSystemPrompt = values['append-system-prompt'];
  if (appendSystemPrompt?.trim() === '') throw new UsageError('--append-system-prompt needs text');
  // The command line runs the user's own hooks and no workspace's: no editor vouches that the user trusts the folder.
  const hooks = new HookSessions();
  const options = { limits, check: values.check, checkAfterEdit: values['check-after-edit'], approval, allowWorker: values['allow-worker'], hooks, appendSystemPrompt };
  try {
    // MCP is on for a user at the terminal unless --no-mcp, and off in a non-interactive run unless --mcp.
    if (!(values['non-interactive'] ? values.mcp === true : values.mcp !== false)) return (await runAgent(io, store, { ...opened, log }, task, options)).exitCode;
    const hub = await openMcpHub({ store, env: io.env, workspace: await workspaceDir(io.cwd, log.session.workspace), acp: [] });
    try {
      // A one-shot run has only this turn, so it waits for its servers.
      await hub.start();
      const mcp: McpTools = (approval, grant) => hub.toolset(approval, grant);
      for (const problem of hub.problems) io.err(`mcp: ${problem}`);
      for (const view of hub.views()) if (view.state.status === 'untrusted' || view.state.status === 'failed') io.err(`mcp: ${view.name} is ${describeServerState(view.state)}`);
      return (await runAgent(io, store, { ...opened, log }, task, { ...options, mcp })).exitCode;
    } finally {
      await hub.stop();
    }
  } finally {
    // The session ends with the process, as a `claude -p` run does.
    await hooks.endAll();
  }
};
