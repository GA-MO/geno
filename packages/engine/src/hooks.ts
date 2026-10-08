import { homedir, tmpdir } from 'node:os';
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  classifierInputOf,
  claudeToolCall,
  claudeToolResponse,
  genoToolInput,
  handlersFor,
  HOOK_EVENTS,
  HOOK_PERMISSION_MODES,
  hookAskDenial,
  hookLabel,
  hookNoteText,
  hookOutcome,
  MATCHED_FIELD,
  nextSeq,
  permissionRequestDecision,
  permissionSuggestions,
  preToolDecision,
  promptDecision,
  stopDecision,
  toolHookVerdict,
  type ApprovalRecord,
  type CallHookEvent,
  type Denial,
  type HookContextEvent,
  type HookEntry,
  type HookEventInputs,
  type HookEventName,
  type HookResult,
  type LaneRecord,
  type PromptDecision,
  type RunningHookEvent,
  type SessionStartSource,
  type StopDecision,
  type StopEvent,
  type StopInput,
  type ToolHookEvent,
  type ToolHookVerdict,
  type ToolStatus,
} from '@g-code/core';
import type { OpenSession } from './chat.js';
import { childEnv, type Env } from './child-env.js';
import type { Io } from './command.js';
import { loadHookConfig, runnableEntries } from './hook-config.js';
import { claudeDirOf, loadPlugins } from './plugins.js';
import { runWithInput } from './process.js';
import { openSandbox, sandboxPolicy, type Sandbox } from './sandbox.js';
import { appendEvent } from './sessions.js';
import { homeOf, type Store } from './store.js';
import { modeOf, refusalOf, settle, type Approval } from './tools/agent.js';
import type { PermissionAsk, ToolContext } from './tools/context.js';

/** What a project hook runs under: the sandbox a model's command gets, opened for the run and closed after it. */
export type HookSandbox = Pick<Sandbox, 'wrap' | 'close'>;

export type RunnerContext = {
  /** The hooks this session may run, the user's own first. */
  readonly entries: readonly HookEntry[];
  /** The session and its log, which Geno gives as Claude Code's `transcript_path`; a new lane has none yet. */
  readonly session: { readonly id: string; readonly transcriptPath: string } | undefined;
  /** Where the hooks run, which they get as `cwd` and CLAUDE_PROJECT_DIR. */
  readonly workspace: string;
  /** The engine's environment; a hook sees only `childEnv` of it, never an API key. */
  readonly env: Env;
  readonly sandbox: () => Promise<HookSandbox>;
  readonly signal?: AbortSignal | undefined;
};

export type HookRunner = {
  /**
   * Runs every handler that matches, at once, each with the payload on stdin, and waits for all of them. The payload
   * has the session's fields and `permissionMode` only where there is a session.
   */
  run<E extends RunningHookEvent>(event: E, input: HookEventInputs[E], permissionMode?: string): Promise<readonly HookResult[]>;
};

/** Claude Code's variables: the project dir for every hook, the plugin's folder for a plugin's, and the config dir it was read from. */
function hookEnv(ctx: RunnerContext, entry: HookEntry): Record<string, string> {
  const configDir = ctx.env['CLAUDE_CONFIG_DIR'];
  return childEnv(ctx.env, {
    CLAUDE_PROJECT_DIR: ctx.workspace,
    ...(configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: configDir }),
    ...(entry.origin.plugin === undefined ? {} : { CLAUDE_PLUGIN_ROOT: entry.origin.plugin.root }),
  });
}

export function hookRunner(ctx: RunnerContext): HookRunner {
  return {
    async run(event, input, permissionMode) {
      const matched = (MATCHED_FIELD[event] as (input: HookEventInputs[typeof event]) => string | undefined)(input);
      const handlers = handlersFor(ctx.entries, event, matched);
      if (handlers.length === 0) return [];
      const session = ctx.session === undefined ? {} : { session_id: ctx.session.id, transcript_path: ctx.session.transcriptPath };
      const payload = JSON.stringify({ ...session, cwd: ctx.workspace, ...(permissionMode === undefined ? {} : { permission_mode: permissionMode }), hook_event_name: event, ...input });
      const sandbox = handlers.some((entry) => entry.origin.scope === 'project') ? await ctx.sandbox() : undefined;
      try {
        return await Promise.all(
          handlers.map(async (entry): Promise<HookResult> => {
            const timeoutSec = entry.timeoutSec ?? HOOK_EVENTS[event].timeoutSec;
            try {
              const command = entry.origin.scope === 'project' ? await sandbox!.wrap(entry.command) : entry.command;
              const ran = await runWithInput(command, { cwd: ctx.workspace, env: hookEnv(ctx, entry), input: payload, timeoutMs: timeoutSec * 1000, signal: ctx.signal });
              return { entry, outcome: hookOutcome(event, ran, timeoutSec) };
            } catch (error) {
              return { entry, outcome: { kind: 'error', code: null, message: `could not start: ${error instanceof Error ? error.message : String(error)}` } };
            }
          }),
        );
      } finally {
        await sandbox?.close();
      }
    },
  };
}

/** Tells the user what the hooks said for them: each error, and each `systemMessage`. Nothing here reaches the model. */
export function reportHooks(io: Io, label: string, results: readonly HookResult[]): void {
  for (const { entry, outcome } of results) {
    if (outcome.kind === 'error') io.err(`${label} hook error: ${entry.command}: ${outcome.message}`);
    if (outcome.kind === 'ok' && outcome.systemMessage !== undefined) io.err(`${label} hook: ${outcome.systemMessage}`);
  }
}

/**
 * LaneCreated, Geno's own event, once a new lane is set up and before a session runs in it, so that a hook can, for
 * example, install the lane's dependencies. Only the user's own hooks run, as the user, in the lane: a repository's
 * setup for its lanes is `laneSetup`, which the user approves once. A failed hook is reported, and the lane stays.
 */
export async function laneCreated(io: Io, store: Store, repo: { readonly main: string }, lane: LaneRecord): Promise<void> {
  const claudeDir = claudeDirOf(io.env);
  const config = await loadHookConfig({ claudeDir, appHome: homeOf(store), workspace: repo.main, plugins: (await loadPlugins(claudeDir, repo.main)).plugins });
  const entries = runnableEntries(config.entries, false).filter((entry) => entry.event === 'LaneCreated');
  if (entries.length === 0) return;
  const runner = hookRunner({
    entries,
    session: undefined,
    workspace: lane.path,
    env: io.env,
    sandbox: async () => {
      throw new Error('a lane runs no workspace hook');
    },
    signal: io.interrupts(),
  });
  const input = { name: lane.name, worktree_path: lane.path, branch: lane.branch, base_commit: lane.base.commit, main_checkout: repo.main };
  reportHooks(io, 'LaneCreated', await runner.run('LaneCreated', input));
}

/** What SessionStart's hooks told the model, to log; undefined when they said nothing to it. */
export function sessionStartEvent(source: SessionStartSource, results: readonly HookResult[]): HookContextEvent | undefined {
  const notes = results.flatMap(({ outcome }) => (outcome.kind === 'block' ? [] : (outcome.notes ?? [])));
  return notes.length === 0 ? undefined : { kind: 'hook-context', seq: 0, at: new Date().toISOString(), event: 'SessionStart', matched: source, notes };
}

/** Appends `event` to the session's log and returns the session with it, numbered after the last event. */
export async function logged(opened: OpenSession, event: HookContextEvent): Promise<OpenSession> {
  const numbered = { ...event, seq: nextSeq(opened.log.events) };
  await appendEvent(opened.log.file, numbered);
  return { ...opened, log: { ...opened.log, events: [...opened.log.events, numbered] } };
}

export type SessionOpening = {
  readonly io: Io;
  readonly store: Store;
  readonly opened: OpenSession;
  /** Whether VS Code trusts the session's workspace; only then do its project hooks run. */
  readonly trusted: boolean;
  /** Claude Code's name for the run's approval mode, for `permission_mode`. */
  readonly permissionMode: string;
  readonly workspace: string;
  /** The session's scratchpad, the temp dir a project hook may write in, like a model's command. */
  readonly scratchpad: string | undefined;
};

type Active = { readonly io: Io; readonly runner: HookRunner; readonly events: ReadonlySet<HookEventName>; readonly workspace: string; permissionMode: string };

/**
 * What a tool event's hooks said beyond a permission: the text to log for the model, beside a call's result or after
 * a batch's, and the reason to stop the loop before the next model call, when a hook stops it.
 */
export type ToolHookSaid = { readonly context: HookContextEvent | undefined; readonly stop: { readonly by: ToolHookEvent; readonly reason: string } | undefined };

/**
 * A call PreToolUse's hooks let go on, its input as a hook's `updatedInput` left it: as the call's own checks have it,
 * allowed (they skip their question and the classifier), or after the user answers the hook's question. Or the refusal
 * logged in its place, which the model reads as Claude Code's `PreToolUse:<Tool> hook error: <reason>`.
 */
export type PreToolStep = (
  | { readonly kind: 'run'; readonly use: ToolUseBlock; readonly allowed: boolean }
  | { readonly kind: 'ask'; readonly use: ToolUseBlock; readonly question: Denial }
  | { readonly kind: 'refuse'; readonly text: string; readonly approval: ApprovalRecord }
) & { readonly said: ToolHookSaid };

/** A call that has a result, as the after-tool hooks read it: the call as it ran, and its own time. */
export type RanCall = { readonly use: ToolUseBlock; readonly status: ToolStatus; readonly text: string; readonly durationMs: number };

/**
 * The tool events for one run's calls. PreToolUse: each call's verdict, all settled before the first call runs, and a
 * hook's question. PostToolUse or PostToolUseFailure after each call that ran, and PostToolBatch once the turn's calls
 * all have results.
 */
export type ToolHooks = {
  decide(uses: readonly ToolUseBlock[], describe: (use: ToolUseBlock) => string): Promise<readonly PreToolStep[]>;
  /** The user's answer to a hook's question, after which the call runs as allowed; a no throws the call's refusal. */
  confirm(question: Denial, ctx: ToolContext): Promise<ApprovalRecord>;
  /** PostToolUse for a call that ran, PostToolUseFailure for one that failed; nothing for one refused or turned down. */
  after(call: RanCall): Promise<ToolHookSaid>;
  batch(calls: readonly RanCall[]): Promise<ToolHookSaid>;
  /** PermissionRequest for the call as it runs, asked where a card would show; undefined when no such hook runs. */
  permissionAsk(use: ToolUseBlock): PermissionAsk | undefined;
};

/** The subagent whose calls the tool events see, as Claude Code names it in `agent_id` and `agent_type`. */
export type HookAgent = { readonly id: string; readonly type: string };

/** The tool events: a session that runs none of them gives its calls no hooks at all. */
const TOOL_HOOK_EVENTS: readonly HookEventName[] = ['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch'];

/** The hooks that fire as a model ends its turn: Stop for the session's own, SubagentStop for a subagent's. */
export type StopHook = { readonly event: StopEvent; decide(input: StopInput): Promise<StopDecision> };

/** A subagent's own events: SubagentStart's context, to log before its task, and SubagentStop as it ends. */
export type SubagentHooks = {
  start(): Promise<HookContextEvent | undefined>;
  readonly stop: StopHook | undefined;
};

const NOTHING_SAID: ToolHookSaid = { context: undefined, stop: undefined };

function saidOf(verdict: ToolHookVerdict, place: { readonly event: 'PostToolBatch' } | { readonly event: CallHookEvent; readonly matched: string; readonly toolUseId: string }): ToolHookSaid {
  const context: HookContextEvent | undefined = verdict.notes.length === 0 ? undefined : { kind: 'hook-context', seq: 0, at: new Date().toISOString(), ...place, notes: verdict.notes };
  return { context, stop: verdict.stop === undefined ? undefined : { by: place.event, reason: verdict.stop } };
}

const AFTER_TOOL_EVENT: Readonly<Record<ToolStatus, Extract<CallHookEvent, 'PostToolUse' | 'PostToolUseFailure'> | undefined>> = {
  ok: 'PostToolUse',
  error: 'PostToolUseFailure',
  denied: undefined,
  rejected: undefined,
};

/**
 * The hooks of each session this engine process runs. A session's hooks are read once, at its first run in the
 * process, as Claude Code takes a snapshot of its hooks when a session starts; that run fires SessionStart. SessionEnd
 * fires for each of them when the process ends.
 */
export class HookSessions {
  private readonly active = new Map<string, Active>();

  /**
   * The session, with SessionStart's output logged when this is its first run in the process: `startup` for a session
   * the model has not answered yet, `resume` for one it has.
   */
  async open(opening: SessionOpening): Promise<OpenSession> {
    const { io, opened } = opening;
    const sessionId = opened.log.session.id;
    const known = this.active.get(sessionId);
    if (known !== undefined) {
      known.permissionMode = opening.permissionMode;
      return opened;
    }
    const plugins = (await loadPlugins(claudeDirOf(io.env), opening.workspace)).plugins;
    const config = await loadHookConfig({ claudeDir: claudeDirOf(io.env), appHome: homeOf(opening.store), workspace: opening.workspace, plugins });
    for (const problem of config.problems) if (problem.severity === 'warning') io.err(`hooks: ${problem.text}`);
    const home = io.env['HOME'] || homedir();
    const entries = runnableEntries(config.entries, opening.trusted);
    const runner = hookRunner({
      entries,
      session: { id: sessionId, transcriptPath: opened.log.file },
      workspace: opening.workspace,
      env: io.env,
      sandbox: async () =>
        openSandbox(await sandboxPolicy({ store: opening.store, home, workspace: opening.workspace, tempDir: opening.scratchpad ?? tmpdir() })),
    });
    this.active.set(sessionId, { io, runner, events: new Set(entries.map((entry) => entry.event)), workspace: opening.workspace, permissionMode: opening.permissionMode });
    const source: SessionStartSource = opened.log.events.some((event) => event.kind === 'assistant') ? 'resume' : 'startup';
    const event = await this.sessionStart(sessionId, source);
    return event === undefined ? opened : logged(opened, event);
  }

  /** Runs SessionStart for a session open in this process, such as after a compaction; its output to log, if any. */
  async sessionStart(sessionId: string, source: SessionStartSource): Promise<HookContextEvent | undefined> {
    const active = this.active.get(sessionId);
    if (active === undefined) return undefined;
    const results = await active.runner.run('SessionStart', { source }, active.permissionMode);
    reportHooks(active.io, hookLabel('SessionStart', source), results);
    return sessionStartEvent(source, results);
  }

  /** UserPromptSubmit on the prompt the session's run answers: blocked, with why for the user, or sent with the hooks' notes. */
  async userPromptSubmit(sessionId: string, prompt: string): Promise<PromptDecision> {
    const active = this.active.get(sessionId);
    if (active === undefined) return { kind: 'go', notes: [] };
    const results = await active.runner.run('UserPromptSubmit', { prompt }, active.permissionMode);
    reportHooks(active.io, 'UserPromptSubmit', results);
    return promptDecision(results);
  }

  /**
   * The tool events for the calls of `sessionId`'s model, or of a subagent it started, under the approval that asks for
   * that caller. Undefined when the session runs no tool event's hook, so its calls go as they always have.
   */
  toolHooks(sessionId: string, approval: Approval, agent?: HookAgent): ToolHooks | undefined {
    const active = this.active.get(sessionId);
    if (active === undefined || !TOOL_HOOK_EVENTS.some((event) => active.events.has(event))) return undefined;
    const agentFields = agent === undefined ? {} : { agent_id: agent.id, agent_type: agent.type };
    const permissionMode = () => HOOK_PERMISSION_MODES[modeOf(approval)];
    const step = async (use: ToolUseBlock, describe: (use: ToolUseBlock) => string): Promise<PreToolStep> => {
      const mode = modeOf(approval);
      const { tool_name, tool_input } = claudeToolCall(use.name, use.input, active.workspace);
      const results = await active.runner.run('PreToolUse', { tool_name, tool_input, tool_use_id: use.id, ...agentFields }, HOOK_PERMISSION_MODES[mode]);
      const label = hookLabel('PreToolUse', tool_name);
      reportHooks(active.io, label, results);
      const said = saidOf(toolHookVerdict('PreToolUse', results), { event: 'PreToolUse', matched: tool_name, toolUseId: use.id });
      // A continue false stops everything, this call first, as Claude Code's does.
      const decision = said.stop === undefined ? preToolDecision(results) : { kind: 'deny' as const, reason: said.stop.reason };
      if (decision.kind === 'deny') {
        const record: ApprovalRecord = { mode, rule: 'hook-deny', reason: decision.reason, command: describe(use), decidedBy: 'rule', verdict: 'deny' };
        return { kind: 'refuse', text: hookNoteText(label, { how: 'error', text: decision.reason }), approval: record, said };
      }
      const updated = decision.kind === 'none' || decision.input === undefined ? use : { ...use, input: genoToolInput(use.name, decision.input) };
      if (decision.kind === 'ask') return { kind: 'ask', use: updated, question: hookAskDenial(decision, describe(updated)), said };
      return { kind: 'run', use: updated, allowed: decision.kind === 'allow', said };
    };
    return {
      decide: (uses, describe) => Promise.all(uses.map((use) => step(use, describe))),
      async confirm(question, ctx) {
        const record = await settle(approval, modeOf(approval), question, () => classifierInputOf(ctx.events(), question.command, question), ctx);
        if (record.verdict === 'deny') throw refusalOf(record);
        return record;
      },
      async after({ use, status, text, durationMs }) {
        const event = AFTER_TOOL_EVENT[status];
        if (event === undefined) return NOTHING_SAID;
        const call = { ...claudeToolCall(use.name, use.input, active.workspace), tool_use_id: use.id, ...agentFields };
        const results =
          event === 'PostToolUse'
            ? await active.runner.run(event, { ...call, tool_response: claudeToolResponse(use.name, use.input, text, active.workspace), duration_ms: durationMs }, permissionMode())
            : await active.runner.run(event, { ...call, error: text, is_interrupt: false, duration_ms: durationMs }, permissionMode());
        reportHooks(active.io, hookLabel(event, call.tool_name), results);
        return saidOf(toolHookVerdict(event, results), { event, matched: call.tool_name, toolUseId: use.id });
      },
      async batch(calls) {
        const tool_calls = calls.map(({ use, text }) => ({
          ...claudeToolCall(use.name, use.input, active.workspace),
          tool_use_id: use.id,
          tool_response: claudeToolResponse(use.name, use.input, text, active.workspace),
        }));
        const results = await active.runner.run('PostToolBatch', { tool_calls, ...agentFields }, permissionMode());
        reportHooks(active.io, 'PostToolBatch', results);
        return saidOf(toolHookVerdict('PostToolBatch', results), { event: 'PostToolBatch' });
      },
      permissionAsk(use) {
        if (!active.events.has('PermissionRequest')) return undefined;
        return async (denial) => {
          const { tool_name, tool_input } = claudeToolCall(use.name, use.input, active.workspace);
          const suggestions = permissionSuggestions(denial, tool_name);
          const input = { tool_name, tool_input, ...(suggestions.length === 0 ? {} : { permission_suggestions: suggestions }), ...agentFields };
          const results = await active.runner.run('PermissionRequest', input, permissionMode());
          reportHooks(active.io, hookLabel('PermissionRequest', tool_name), results);
          const answer = permissionRequestDecision(results);
          return answer.kind === 'allow' && answer.input !== undefined ? { ...answer, input: genoToolInput(use.name, answer.input) } : answer;
        };
      },
    };
  }

  /** Stop for the session's own model as it ends its turn; undefined when the session runs no Stop hook. */
  stopHook(sessionId: string): StopHook | undefined {
    const active = this.active.get(sessionId);
    if (active === undefined || !active.events.has('Stop')) return undefined;
    return {
      event: 'Stop',
      async decide(input) {
        const results = await active.runner.run('Stop', input, active.permissionMode);
        reportHooks(active.io, 'Stop', results);
        return stopDecision(results);
      },
    };
  }

  /**
   * SubagentStart and SubagentStop for a subagent of `sessionId`, whose log is `transcript`, under the approval that
   * asks for it. The payload's `session_id` and `transcript_path` stay the parent's, as in Claude Code.
   */
  subagentHooks(sessionId: string, agent: HookAgent, transcript: string, approval: Approval): SubagentHooks | undefined {
    const active = this.active.get(sessionId);
    if (active === undefined || !(active.events.has('SubagentStart') || active.events.has('SubagentStop'))) return undefined;
    const fields = { agent_id: agent.id, agent_type: agent.type };
    const permissionMode = () => HOOK_PERMISSION_MODES[modeOf(approval)];
    return {
      async start() {
        if (!active.events.has('SubagentStart')) return undefined;
        const results = await active.runner.run('SubagentStart', fields, permissionMode());
        reportHooks(active.io, hookLabel('SubagentStart', agent.type), results);
        const notes = results.flatMap(({ outcome }) => (outcome.kind === 'block' ? [] : (outcome.notes ?? [])));
        return notes.length === 0 ? undefined : { kind: 'hook-context', seq: 0, at: new Date().toISOString(), event: 'SubagentStart', notes };
      },
      stop: !active.events.has('SubagentStop')
        ? undefined
        : {
            event: 'SubagentStop',
            async decide(input) {
              const results = await active.runner.run('SubagentStop', { ...fields, ...input, agent_transcript_path: transcript }, permissionMode());
              reportHooks(active.io, hookLabel('SubagentStop', agent.type), results);
              return stopDecision(results);
            },
          },
    };
  }

  /** Fires SessionEnd for every session this process ran, once, and forgets them. */
  async endAll(): Promise<void> {
    const ending = [...this.active.values()];
    this.active.clear();
    await Promise.all(
      ending.map(async ({ io, runner, permissionMode }) => reportHooks(io, hookLabel('SessionEnd', 'other'), await runner.run('SessionEnd', { reason: 'other' }, permissionMode))),
    );
  }
}
