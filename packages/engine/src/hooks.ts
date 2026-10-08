import { homedir, tmpdir } from 'node:os';
import type { ToolUseBlock } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  classifierInputOf,
  claudeToolCall,
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
  preToolDecision,
  promptDecision,
  type ApprovalRecord,
  type Denial,
  type HookContextEvent,
  type HookEntry,
  type HookEventInputs,
  type HookEventName,
  type HookResult,
  type PromptDecision,
  type RunningHookEvent,
  type SessionStartSource,
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
import type { ToolContext } from './tools/context.js';

/** What a project hook runs under: the sandbox a model's command gets, opened for the run and closed after it. */
export type HookSandbox = Pick<Sandbox, 'wrap' | 'close'>;

export type RunnerContext = {
  /** The hooks this session may run, the user's own first. */
  readonly entries: readonly HookEntry[];
  readonly sessionId: string;
  /** The session log, which Geno gives as Claude Code's `transcript_path`. */
  readonly transcriptPath: string;
  readonly workspace: string;
  /** The engine's environment; a hook sees only `childEnv` of it, never an API key. */
  readonly env: Env;
  readonly sandbox: () => Promise<HookSandbox>;
  readonly signal?: AbortSignal | undefined;
};

export type HookRunner = {
  /** Runs every handler that matches, at once, each with the payload on stdin, and waits for all of them. */
  run<E extends RunningHookEvent>(event: E, input: HookEventInputs[E], permissionMode: string): Promise<readonly HookResult[]>;
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
      const payload = JSON.stringify({ session_id: ctx.sessionId, transcript_path: ctx.transcriptPath, cwd: ctx.workspace, permission_mode: permissionMode, hook_event_name: event, ...input });
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
 * A call PreToolUse's hooks let go on, its input as a hook's `updatedInput` left it: as the call's own checks have it,
 * allowed (they skip their question and the classifier), or after the user answers the hook's question. Or the refusal
 * logged in its place, which the model reads as Claude Code's `PreToolUse:<Tool> hook error: <reason>`.
 */
export type PreToolStep =
  | { readonly kind: 'run'; readonly use: ToolUseBlock; readonly allowed: boolean }
  | { readonly kind: 'ask'; readonly use: ToolUseBlock; readonly question: Denial }
  | { readonly kind: 'refuse'; readonly text: string; readonly approval: ApprovalRecord };

/** PreToolUse for one run's calls: each call's verdict, all settled before the first call runs, and a hook's question. */
export type PreToolHooks = {
  decide(uses: readonly ToolUseBlock[], describe: (use: ToolUseBlock) => string): Promise<readonly PreToolStep[]>;
  /** The user's answer to a hook's question, after which the call runs as allowed; a no throws the call's refusal. */
  confirm(question: Denial, ctx: ToolContext): Promise<ApprovalRecord>;
};

/** The subagent whose calls PreToolUse sees, as Claude Code names it in `agent_id` and `agent_type`. */
export type HookAgent = { readonly id: string; readonly type: string };

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
      sessionId,
      transcriptPath: opened.log.file,
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
   * PreToolUse for the calls of `sessionId`'s model, or of a subagent it started, under the approval that asks for that
   * caller. Undefined when the session runs no PreToolUse hook, so its calls go as they always have.
   */
  preToolHooks(sessionId: string, approval: Approval, agent?: HookAgent): PreToolHooks | undefined {
    const active = this.active.get(sessionId);
    if (active === undefined || !active.events.has('PreToolUse')) return undefined;
    const agentFields = agent === undefined ? {} : { agent_id: agent.id, agent_type: agent.type };
    const step = async (use: ToolUseBlock, describe: (use: ToolUseBlock) => string): Promise<PreToolStep> => {
      const mode = modeOf(approval);
      const { tool_name, tool_input } = claudeToolCall(use.name, use.input, active.workspace);
      const results = await active.runner.run('PreToolUse', { tool_name, tool_input, tool_use_id: use.id, ...agentFields }, HOOK_PERMISSION_MODES[mode]);
      const label = hookLabel('PreToolUse', tool_name);
      reportHooks(active.io, label, results);
      const decision = preToolDecision(results);
      if (decision.kind === 'deny') {
        const record: ApprovalRecord = { mode, rule: 'hook-deny', reason: decision.reason, command: describe(use), decidedBy: 'rule', verdict: 'deny' };
        return { kind: 'refuse', text: hookNoteText(label, { how: 'error', text: decision.reason }), approval: record };
      }
      const updated = decision.kind === 'none' || decision.input === undefined ? use : { ...use, input: genoToolInput(use.name, decision.input) };
      if (decision.kind === 'ask') return { kind: 'ask', use: updated, question: hookAskDenial(decision, describe(updated)) };
      return { kind: 'run', use: updated, allowed: decision.kind === 'allow' };
    };
    return {
      decide: (uses, describe) => Promise.all(uses.map((use) => step(use, describe))),
      async confirm(question, ctx) {
        const record = await settle(approval, modeOf(approval), question, () => classifierInputOf(ctx.events(), question.command, question), ctx.signal);
        if (record.verdict === 'deny') throw refusalOf(record);
        return record;
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
