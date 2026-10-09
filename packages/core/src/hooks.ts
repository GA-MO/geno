import path from 'node:path';
import { BROWSER_RULES, DENY_RULES, isMcpRule, LINE_RULES, MCP_RULES, WEB_RULES, type ApprovalMode, type ApprovalRuleId, type Denial, type SessionMode, type Verdicts } from './approval.js';
import { EXTERNAL_RULES } from './backend-permissions.js';
import { GENO_NOTE, neutralize } from './fence.js';
import { patternText } from './permission-rules.js';

/**
 * User hooks in Claude Code's format: commands the harness runs at loop events, configured as
 * `hooks.<Event>[{ matcher, hooks: [{ type: 'command', command, timeout }] }]` in settings files and plugins. Geno reads
 * the same files, so a Claude Code or pstack hook runs unchanged. This module is the contract: which events exist and
 * which Geno fires, how a matcher picks a handler, and what a handler's exit code and output mean.
 */

/** Whether Geno fires an event: `runs`, or `never`, because Geno has no trigger for it or another event covers it. */
export type HookSupport = 'runs' | 'never';

type EventSpec = {
  readonly support: HookSupport;
  /** Why Geno never fires the event, as Settings shows it. */
  readonly why?: string;
  /**
   * Exit 2 decides, with stderr as the reason, whatever stdout says: it blocks what the event is about, such as a tool
   * call or a prompt, or, after a call that already ran, gives the model the reason beside its result.
   */
  readonly blocks: boolean;
  /** Seconds before the handler is killed, unless it sets its own `timeout`. */
  readonly timeoutSec: number;
  /** Whether a group's matcher filters this event; an event without one runs every group. */
  readonly matcher: boolean;
  /** Whether plain stdout of exit 0 reaches the model as context. */
  readonly stdoutIsContext: boolean;
};

type Opts = Partial<Omit<EventSpec, 'support' | 'why'>>;

const runs = (opts: Opts = {}): EventSpec => ({ support: 'runs', blocks: false, timeoutSec: 600, matcher: false, stdoutIsContext: false, ...opts });
const never = (why: string, opts: Opts = {}): EventSpec => ({ ...runs(opts), support: 'never', why });

/**
 * Every event Claude Code fires (research/claude-code-harness/05-hooks.md, spec/03-runtime.md §3), and Geno's own
 * LaneCreated, which Claude Code does not have.
 */
export const HOOK_EVENTS = {
  SessionStart: runs({ matcher: true, stdoutIsContext: true }),
  SessionEnd: runs({ matcher: true }),
  UserPromptSubmit: runs({ blocks: true, timeoutSec: 30, stdoutIsContext: true }),
  PreToolUse: runs({ blocks: true, matcher: true }),
  // Exit 2 is not honored: only the decision object answers a card.
  PermissionRequest: runs({ matcher: true }),
  PostToolUse: runs({ blocks: true, matcher: true }),
  PostToolUseFailure: runs({ blocks: true, matcher: true }),
  PostToolBatch: runs({ blocks: true }),
  Stop: runs({ blocks: true }),
  SubagentStart: runs({ matcher: true }),
  SubagentStop: runs({ blocks: true, matcher: true }),
  LaneCreated: runs(),
  WorktreeCreate: never('Its hook replaces creating the worktree and prints the new path, but a lane must be a git worktree on its own branch. Use LaneCreated to set up a new lane.', { blocks: true }),
  WorktreeRemove: never('It removes what a WorktreeCreate hook made, and Geno runs no WorktreeCreate hook.'),
  Setup: never('Geno has no --init or --maintenance run.'),
  UserPromptExpansion: never('Geno has no hook on expanding a slash command; UserPromptSubmit sees the prompt.', { blocks: true }),
  PermissionDenied: never("Auto's classifier refuses a call without a card, and the model reads why in the call's result.", { matcher: true }),
  Notification: never('Geno shows its cards and notices in the editor. PermissionRequest and Stop fire at the same moments.', { matcher: true }),
  MessageDisplay: never('Geno has no hook on the text it shows.', { timeoutSec: 10 }),
  TaskCreated: never('Geno has a todo list, not a task list.', { blocks: true }),
  TaskCompleted: never('Geno has a todo list, not a task list.', { blocks: true }),
  StopFailure: never('A failed model call ends the turn with the error, which Geno shows.'),
  TeammateIdle: never('Geno has no agent teams.', { blocks: true }),
  InstructionsLoaded: never('Geno loads instruction files when a session starts, which SessionStart covers.'),
  ConfigChange: never('Geno reads hooks once per session and does not watch the settings files.', { blocks: true }),
  CwdChanged: never('A Geno session keeps its workspace.'),
  DirectoryAdded: never('Geno has no /add-dir.'),
  FileChanged: never('Geno tells the model itself about files that changed on disk, before each model call.'),
  PreCompact: never('SessionStart with the source compact runs after a compaction.', { blocks: true, matcher: true }),
  PostCompact: never('SessionStart with the source compact runs after a compaction.', { matcher: true }),
  PreModelSwitch: never('Geno has no hook on a model switch.', { blocks: true }),
  PostModelSwitch: never('Geno has no hook on a model switch.'),
  Elicitation: never('Geno answers no MCP elicitation.', { blocks: true }),
  ElicitationResult: never('Geno answers no MCP elicitation.', { blocks: true }),
} as const satisfies Readonly<Record<string, EventSpec>>;

export type HookEventName = keyof typeof HOOK_EVENTS;

export const isHookEventName = (name: string): name is HookEventName => Object.hasOwn(HOOK_EVENTS, name);

/**
 * Claude Code's tool names, as matchers name them, and the Geno tool each maps to. A matcher matches a Geno tool when
 * it matches the Geno name or any Claude Code name that maps to it, so `Edit|Write` fires on `edit`.
 */
export const CLAUDE_TOOL_NAMES: Readonly<Record<string, string>> = {
  Bash: 'bash',
  BashOutput: 'bash_output',
  KillShell: 'task_stop',
  TaskStop: 'task_stop',
  ListAgents: 'list_agents',
  Read: 'read',
  Edit: 'edit',
  Write: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'notebook_edit',
  Grep: 'grep',
  Glob: 'glob',
  LS: 'list',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
  Agent: 'agent',
  Task: 'agent',
  SendMessage: 'message_agent',
  Skill: 'skill',
  TodoWrite: 'todo',
  TaskCreate: 'todo',
  TaskUpdate: 'todo',
  ToolSearch: 'tool_search',
  AskUserQuestion: 'ask_user',
  Monitor: 'monitor',
  ScheduleWakeup: 'schedule_wakeup',
};

const claudeNamesOf = (genoTool: string): string[] => Object.keys(CLAUDE_TOOL_NAMES).filter((name) => CLAUDE_TOOL_NAMES[name] === genoTool);

const TOOL_EVENTS: ReadonlySet<HookEventName> = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']);

/** Who wrote a hook. A user hook runs as the user; a project hook only in a trusted workspace, inside the sandbox. */
export type HookScope = 'user' | 'project';

/** The file a hook came from; a plugin's hook runs with CLAUDE_PLUGIN_ROOT set to the plugin's folder. */
export type HookOrigin = { readonly file: string; readonly scope: HookScope; readonly plugin?: { readonly name: string; readonly root: string } | undefined };

/** One command handler, flattened from its group. */
export type HookEntry = {
  readonly event: HookEventName;
  readonly matcher: string | undefined;
  readonly command: string;
  /** Seconds; undefined takes the event's default. */
  readonly timeoutSec: number | undefined;
  readonly origin: HookOrigin;
};

/** A warning is a mistake to fix, such as a misspelled event; info says what Geno does with a valid setting. */
export type HookProblem = { readonly severity: 'warning' | 'info'; readonly text: string };

export type ParsedHooks = { readonly entries: readonly HookEntry[]; readonly problems: readonly HookProblem[] };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

// A matcher of only these characters is a name or a `|` list; anything else is a regex (spec/03-runtime.md §3.1).
const PLAIN_MATCHER = /^[A-Za-z0-9_\- |,]*$/;

function matcherProblem(matcher: string): string | undefined {
  if (PLAIN_MATCHER.test(matcher)) return undefined;
  try {
    new RegExp(matcher);
    return undefined;
  } catch {
    return `matcher ${matcher} is not a valid pattern`;
  }
}

/** The `hooks` of one settings file or plugin `hooks.json`. Whatever cannot be read is reported and skipped, never thrown. */
export function parseHookSettings(raw: unknown, origin: HookOrigin): ParsedHooks {
  const hooks = isRecord(raw) ? raw['hooks'] : undefined;
  if (hooks === undefined) return { entries: [], problems: [] };
  const at = origin.file;
  if (!isRecord(hooks)) return { entries: [], problems: [{ severity: 'warning', text: `${at}: hooks must be an object of events` }] };
  const entries: HookEntry[] = [];
  const problems: HookProblem[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!isHookEventName(event)) {
      problems.push({ severity: 'warning', text: `${at}: ${event} is not a hook event, so its hooks never run. Check the spelling against Claude Code's event names.` });
      continue;
    }
    if (!Array.isArray(groups)) {
      problems.push({ severity: 'warning', text: `${at}: ${event} must be a list of matcher groups` });
      continue;
    }
    for (const group of groups) {
      const matcher = isRecord(group) && typeof group['matcher'] === 'string' ? group['matcher'] : undefined;
      const handlers = isRecord(group) ? group['hooks'] : undefined;
      if (!Array.isArray(handlers)) {
        problems.push({ severity: 'warning', text: `${at}: a ${event} group has no hooks list` });
        continue;
      }
      const bad = matcher === undefined ? undefined : matcherProblem(matcher);
      if (bad !== undefined) {
        problems.push({ severity: 'warning', text: `${at}: ${event} ${bad}, so its group is skipped` });
        continue;
      }
      for (const handler of handlers) {
        const type = isRecord(handler) ? handler['type'] : undefined;
        if (type !== 'command') {
          problems.push({ severity: 'info', text: `${at}: a ${String(type)} hook on ${event} is skipped; Geno runs command hooks only` });
          continue;
        }
        const command = handler['command'];
        const timeout = handler['timeout'];
        if (typeof command !== 'string' || command.trim() === '') {
          problems.push({ severity: 'warning', text: `${at}: a command hook on ${event} has no command` });
          continue;
        }
        const timeoutSec = typeof timeout === 'number' && timeout > 0 ? timeout : undefined;
        entries.push({ event, matcher, command, timeoutSec, origin });
      }
    }
  }
  return { entries, problems };
}

const MATCH_ALL = new Set(['', '*']);

/**
 * Whether a group's matcher picks `value`: the source of SessionStart, the reason of SessionEnd, or a Geno tool name.
 * A plain matcher is a name or a `|` list; any other is a regex that must match the whole value.
 */
export function matcherMatches(matcher: string | undefined, event: HookEventName, value: string | undefined): boolean {
  if (matcher === undefined || MATCH_ALL.has(matcher.trim()) || !HOOK_EVENTS[event].matcher) return true;
  if (value === undefined) return false;
  const candidates = TOOL_EVENTS.has(event) ? [value, ...claudeNamesOf(value)] : [value];
  if (PLAIN_MATCHER.test(matcher)) {
    const names = matcher.split(/[|,]/).map((name) => name.trim());
    return candidates.some((candidate) => names.includes(candidate));
  }
  const pattern = new RegExp(`^(?:${matcher})$`);
  return candidates.some((candidate) => pattern.test(candidate));
}

/**
 * The handlers to run for `event` on `value`, in the order given. An identical handler, the same command with the same
 * plugin root, runs once, as the first entry that names it: the loader lists the user's own files first.
 */
export function handlersFor(entries: readonly HookEntry[], event: HookEventName, value: string | undefined): HookEntry[] {
  const seen = new Set<string>();
  const picked: HookEntry[] = [];
  for (const entry of entries) {
    if (entry.event !== event || !matcherMatches(entry.matcher, event, value)) continue;
    const key = JSON.stringify([entry.command, entry.origin.plugin?.root ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(entry);
  }
  return picked;
}

/** How a handler's process ended. `code` is null when it was killed. */
export type HookRan = { readonly code: number | null; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean };

/** The JSON a hook may print on stdout, as Claude Code reads it. Fields this module does not act on are kept for the events that do. */
export type HookOutput = {
  readonly continue?: boolean;
  readonly stopReason?: string;
  readonly suppressOutput?: boolean;
  readonly systemMessage?: string;
  readonly decision?: string;
  readonly reason?: string;
  readonly hookSpecificOutput?: Readonly<Record<string, unknown>> & { readonly additionalContext?: string };
};

/**
 * Text a hook gives the model: plain stdout ("hook success"), a JSON `additionalContext`, or the reason of a block
 * ("hook blocking error"), such as a Stop hook's that keeps the turn going.
 */
export type HookNote = { readonly how: 'success' | 'additional-context' | 'blocking'; readonly text: string };

/**
 * What one handler's run means. `ok` is exit 0. `block` is exit 2 on an event that can block, whatever stdout says.
 * `error` is anything else, never blocking: another exit code, exit 2 where nothing can be blocked, a timeout, or JSON
 * that does not parse. Valid JSON still counts on another non-zero exit (spec/03-runtime.md §3.3).
 */
export type HookOutcome =
  | { readonly kind: 'ok'; readonly code: 0; readonly notes: readonly HookNote[]; readonly output?: HookOutput; readonly systemMessage?: string }
  | { readonly kind: 'block'; readonly code: 2; readonly reason: string }
  | { readonly kind: 'error'; readonly code: number | null; readonly message: string; readonly notes?: readonly HookNote[]; readonly output?: HookOutput };

type Stdout = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'json'; readonly output: HookOutput } | { readonly kind: 'broken'; readonly message: string };

function readStdout(stdout: string): Stdout {
  const text = stdout.trim();
  if (!text.startsWith('{')) return { kind: 'text', text };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { kind: 'broken', message: `printed JSON that does not parse: ${(error as Error).message}` };
  }
  return isRecord(value) ? { kind: 'json', output: value as HookOutput } : { kind: 'broken', message: 'printed JSON that is not an object' };
}

const notesOf = (output: HookOutput): HookNote[] => {
  const context = output.hookSpecificOutput?.additionalContext;
  return typeof context === 'string' && context.trim() !== '' ? [{ how: 'additional-context', text: context.trim() }] : [];
};

const withDetail = (head: string, stderr: string): string => (stderr.trim() === '' ? head : `${head}: ${stderr.trim()}`);

/** What `ran` means for `event`. `timeoutSec` is the limit it was killed at, for the message. */
export function hookOutcome(event: HookEventName, ran: HookRan, timeoutSec = HOOK_EVENTS[event].timeoutSec): HookOutcome {
  if (ran.timedOut) return { kind: 'error', code: ran.code, message: `timed out after ${timeoutSec} s and was killed` };
  if (ran.code === 2 && HOOK_EVENTS[event].blocks) return { kind: 'block', code: 2, reason: ran.stderr.trim() || `${event} hook blocked this` };
  const stdout = readStdout(ran.stdout);
  if (ran.code !== 0) {
    const message = withDetail(`exit code ${ran.code ?? 'unknown'}`, ran.stderr);
    // Exit 2 where nothing can be blocked shows only stderr, as Claude Code does.
    return stdout.kind === 'json' && ran.code !== 2 ? { kind: 'error', code: ran.code, message, notes: notesOf(stdout.output), output: stdout.output } : { kind: 'error', code: ran.code, message };
  }
  if (stdout.kind === 'broken') return { kind: 'error', code: 0, message: stdout.message };
  if (stdout.kind === 'text') {
    const notes: HookNote[] = HOOK_EVENTS[event].stdoutIsContext && stdout.text !== '' ? [{ how: 'success', text: stdout.text }] : [];
    return { kind: 'ok', code: 0, notes };
  }
  const { output } = stdout;
  return { kind: 'ok', code: 0, notes: notesOf(output), output, ...(typeof output.systemMessage === 'string' ? { systemMessage: output.systemMessage } : {}) };
}

/** Geno's cap on one hook's text in the conversation, so a hook that prints a whole file does not fill the context. */
export const HOOK_NOTE_LIMIT = 10_000;

const HOW_WORDS: Readonly<Record<HookNote['how'] | 'error', string>> = {
  success: 'hook success',
  'additional-context': 'hook additional context',
  blocking: 'hook blocking error',
  error: 'hook error',
};

/**
 * A hook's text as the model reads it: Claude Code's `<label> hook success: <stdout>` (or `hook additional context`,
 * or `hook error` for a refused call) under Geno's note mark, its text unable to pose as Geno.
 */
export function hookNoteText(label: string, note: HookNote | { readonly how: 'error'; readonly text: string }): string {
  const cut = note.text.length > HOOK_NOTE_LIMIT;
  const text = neutralize(cut ? note.text.slice(0, HOOK_NOTE_LIMIT) : note.text);
  return `${GENO_NOTE} ${label} ${HOW_WORDS[note.how]}: ${text}${cut ? `\n${GENO_NOTE} The hook's output was cut to 10,000 characters.` : ''}`;
}

/** One handler's run, with where it came from. */
export type HookResult = { readonly entry: HookEntry; readonly outcome: HookOutcome };

/**
 * The JSON a handler printed that counts: on exit 0, and on another exit that is not 2, where Claude Code ignores the
 * code and lets valid JSON decide (hooks reference, "Other exit codes"). A timeout or a failure without JSON says nothing.
 */
const outputOf = ({ outcome }: HookResult): HookOutput | undefined => (outcome.kind === 'block' ? undefined : outcome.output);

/** Where a hook came from, as Claude Code labels a hook's question: `[settings]` or `[plugin:<name>]`. */
const sourceOf = ({ entry }: HookResult): string => (entry.origin.plugin === undefined ? 'settings' : `plugin:${entry.origin.plugin.name}`);

/**
 * What one call's PreToolUse hooks decided. `input` is a hook's `updatedInput`, in Claude Code's shape, which replaces
 * the call's whole input. `from` names the hook that asks.
 */
export type PreToolDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'allow'; readonly input?: Readonly<Record<string, unknown>> }
  | { readonly kind: 'ask'; readonly reason: string | undefined; readonly from: string; readonly input?: Readonly<Record<string, unknown>> }
  | { readonly kind: 'deny'; readonly reason: string };

type Permission = 'allow' | 'ask' | 'defer' | 'deny';
// Claude Code's precedence when hooks disagree: deny, then defer, then ask, then allow.
const STRICTNESS: Readonly<Record<Permission, number>> = { allow: 0, ask: 1, defer: 2, deny: 3 };
// The top-level decision PreToolUse hooks used before permissionDecision.
const LEGACY_PERMISSIONS: Readonly<Record<string, Permission>> = { approve: 'allow', block: 'deny' };

const isPermission = (value: unknown): value is Permission => typeof value === 'string' && Object.hasOwn(STRICTNESS, value);
const textOf = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

type Said = { readonly permission: Permission; readonly reason: string | undefined; readonly input: Readonly<Record<string, unknown>> | undefined; readonly result: HookResult };

function permissionOf(result: HookResult): Said | undefined {
  if (result.outcome.kind === 'block') return { permission: 'deny', reason: result.outcome.reason, input: undefined, result };
  const output = outputOf(result);
  const specific = output?.hookSpecificOutput;
  const legacy = typeof output?.decision === 'string' ? LEGACY_PERMISSIONS[output.decision] : undefined;
  const permission = isPermission(specific?.['permissionDecision']) ? specific['permissionDecision'] : legacy;
  if (permission === undefined) return undefined;
  const updated = specific?.['updatedInput'];
  return {
    permission,
    reason: textOf(specific?.['permissionDecisionReason']) ?? (legacy === undefined ? undefined : textOf(output?.reason)),
    input: isRecord(updated) ? updated : undefined,
    result,
  };
}

/** The strictest decision of a call's PreToolUse hooks; a `defer` leaves the call to Geno's own checks. */
export function preToolDecision(results: readonly HookResult[]): PreToolDecision {
  const said = results.flatMap((result) => permissionOf(result) ?? []);
  const strictest = said.reduce<Said | undefined>((best, next) => (best === undefined || STRICTNESS[next.permission] > STRICTNESS[best.permission] ? next : best), undefined);
  if (strictest === undefined || strictest.permission === 'defer') return { kind: 'none' };
  if (strictest.permission === 'deny') return { kind: 'deny', reason: strictest.reason ?? 'a PreToolUse hook denied this call' };
  const input = strictest.input === undefined ? {} : { input: strictest.input };
  return strictest.permission === 'allow' ? { kind: 'allow', ...input } : { kind: 'ask', reason: strictest.reason, from: sourceOf(strictest.result), ...input };
}

/**
 * What a card's PermissionRequest hooks decided, standing in for the user's answer. `input` is an allow's
 * `updatedInput`, in Claude Code's shape. A deny's `message` is for the model, and `interrupt` ends the turn as the
 * user's no does.
 */
export type PermissionHookAnswer =
  | { readonly kind: 'none' }
  | { readonly kind: 'allow'; readonly input?: Readonly<Record<string, unknown>> }
  | { readonly kind: 'deny'; readonly message: string | undefined; readonly interrupt: boolean };

function answerOf(result: HookResult): PermissionHookAnswer {
  const decision = outputOf(result)?.hookSpecificOutput?.['decision'];
  if (!isRecord(decision)) return { kind: 'none' };
  if (decision['behavior'] === 'deny') return { kind: 'deny', message: textOf(decision['message']), interrupt: decision['interrupt'] === true };
  if (decision['behavior'] !== 'allow') return { kind: 'none' };
  const updated = decision['updatedInput'];
  return isRecord(updated) ? { kind: 'allow', input: updated } : { kind: 'allow' };
}

/** Only the decision object answers, as in Claude Code: exit 2 leaves the card as it was. A deny outranks an allow. */
export function permissionRequestDecision(results: readonly HookResult[]): PermissionHookAnswer {
  const answers = results.map(answerOf);
  return answers.find((answer) => answer.kind === 'deny') ?? answers.find((answer) => answer.kind === 'allow') ?? { kind: 'none' };
}

/** Claude Code's permission update entry, as `permission_suggestions` carries one. */
export type PermissionSuggestion = {
  readonly type: 'addRules';
  readonly rules: readonly { readonly toolName: string; readonly ruleContent?: string }[];
  readonly behavior: 'allow';
  readonly destination: 'localSettings' | 'session';
};

/**
 * What the card offers to keep, as Claude Code's suggestions: a command's offered allow rule, which Geno saves for the
 * workspace, or an MCP tool for the rest of the session. Every other card offers only a yes for this call.
 */
export function permissionSuggestions(denial: Denial, toolName: string): PermissionSuggestion[] {
  if (denial.offer !== undefined) return [{ type: 'addRules', rules: [{ toolName, ruleContent: patternText(denial.offer) }], behavior: 'allow', destination: 'localSettings' }];
  if (isMcpRule(denial.rule)) return [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }];
  return [];
}

const ruleTables: readonly Readonly<Record<string, { readonly verdicts: Verdicts }>>[] = [DENY_RULES, MCP_RULES, BROWSER_RULES, WEB_RULES, LINE_RULES];

/** Whether a rule asks the user in Ask mode; the rules no table holds are a workspace's deny and a hook's. */
function asksInAsk(rule: ApprovalRuleId): boolean {
  if (rule === 'hook-ask') return true;
  const verdicts = ruleTables.find((table) => Object.hasOwn(table, rule))?.[rule]?.verdicts ?? Object.values(EXTERNAL_RULES).find((one) => one.rule === rule)?.verdicts;
  return verdicts?.ask === 'ask';
}

/**
 * Whether a PermissionRequest hook may answer `denial`: where a card shows, or where a run nobody can answer refuses
 * only because nobody can. A refusal that holds whoever answers, such as a deny rule's or Plan's, is never asked.
 */
export const hookMayAnswer = (denial: Denial, mode: ApprovalMode): boolean =>
  denial.verdict !== 'deny' || (mode === 'non-interactive' && asksInAsk(denial.rule));

/** What a prompt's UserPromptSubmit hooks decided: block it, with the reason for the user, or send it with their notes. */
export type PromptDecision = { readonly kind: 'block'; readonly reason: string } | { readonly kind: 'go'; readonly notes: readonly HookNote[] };

function blockOf(result: HookResult): string | undefined {
  if (result.outcome.kind === 'block') return result.outcome.reason;
  const output = outputOf(result);
  if (output?.continue === false) return textOf(output.stopReason) ?? 'a UserPromptSubmit hook stopped it';
  return output?.decision === 'block' ? (textOf(output.reason) ?? 'a UserPromptSubmit hook blocked it') : undefined;
}

/** Any hook's block stops the prompt, and only then do the reasons go to the user; the model sees neither. */
export function promptDecision(results: readonly HookResult[]): PromptDecision {
  const reasons = results.flatMap((result) => blockOf(result) ?? []);
  if (reasons.length > 0) return { kind: 'block', reason: reasons.join('\n') };
  return { kind: 'go', notes: results.flatMap(({ outcome }) => (outcome.kind === 'block' ? [] : (outcome.notes ?? []))) };
}

/** The events whose hooks speak about tool calls: one call's, before or after it runs, or a whole batch's. */
export type ToolHookEvent = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'PostToolBatch';

/**
 * What a call's or a batch's hooks said beyond PreToolUse's permission: text the model reads beside the results, and
 * the reason to stop the loop before the next model call, if a hook stops it.
 */
export type ToolHookVerdict = { readonly notes: readonly HookNote[]; readonly stop: string | undefined };

/** The hook's notes and stop: `continue: false` stops any event; a block stops a batch and speaks after a call. */
function toolHookSaid(event: ToolHookEvent, result: HookResult): ToolHookVerdict {
  const { outcome } = result;
  if (outcome.kind === 'block') {
    if (event === 'PreToolUse') return { notes: [], stop: undefined };
    return { notes: [{ how: 'blocking', text: outcome.reason }], stop: event === 'PostToolBatch' ? outcome.reason : undefined };
  }
  const output = outputOf(result);
  if (output?.continue === false) {
    const reason = textOf(output.stopReason) ?? `a ${event} hook stopped the turn`;
    // PreToolUse refuses its call with the reason, which the model reads as the call's result.
    return { notes: event === 'PreToolUse' ? [] : [{ how: 'blocking', text: reason }], stop: reason };
  }
  // A PreToolUse decision of block is the older deny, which preToolDecision reads; a deferring hook's text is dropped.
  if (event === 'PreToolUse') return { notes: output?.hookSpecificOutput?.['permissionDecision'] === 'defer' ? [] : (outcome.notes ?? []), stop: undefined };
  const block = output?.decision === 'block' ? (textOf(output.reason) ?? `a ${event} hook blocked this`) : undefined;
  const notes: HookNote[] = [...(block === undefined ? [] : [{ how: 'blocking' as const, text: block }]), ...(outcome.notes ?? [])];
  return { notes, stop: event === 'PostToolBatch' ? block : undefined };
}

export function toolHookVerdict(event: ToolHookEvent, results: readonly HookResult[]): ToolHookVerdict {
  const said = results.map((result) => toolHookSaid(event, result));
  return { notes: said.flatMap((one) => one.notes), stop: said.find((one) => one.stop !== undefined)?.stop };
}

/**
 * What the Stop hooks decided when the model ended its turn: end it, with a `stopReason` for the user, or go on, the
 * model reading the reasons. A `continue: false` outranks any block.
 */
export type StopDecision = { readonly kind: 'end'; readonly reason: string | undefined } | { readonly kind: 'continue'; readonly notes: readonly HookNote[] };

export function stopDecision(results: readonly HookResult[]): StopDecision {
  const stopped = results.find((result) => outputOf(result)?.continue === false);
  if (stopped !== undefined) return { kind: 'end', reason: textOf(outputOf(stopped)?.stopReason) };
  const notes = results.flatMap((result): HookNote[] => {
    const { outcome } = result;
    if (outcome.kind === 'block') return [{ how: 'blocking', text: outcome.reason }];
    const output = outputOf(result);
    const block = output?.decision === 'block' ? [{ how: 'blocking' as const, text: textOf(output.reason) ?? 'a Stop hook blocked the end of the turn' }] : [];
    return [...block, ...(outcome.notes ?? [])];
  });
  return notes.length === 0 ? { kind: 'end', reason: undefined } : { kind: 'continue', notes };
}

type Input = Readonly<Record<string, unknown>>;

const defined = (fields: Readonly<Record<string, unknown>>): Record<string, unknown> => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
const numberOf = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

type ClaudeShape = {
  readonly claude: (input: Input, workspace: string) => { readonly name: string; readonly input: Input };
  readonly geno: (input: Input) => Input;
  /** The `tool_response` an after-tool hook reads, from Claude Code's input and the result text; the text without it. */
  readonly response?: (claude: { readonly name: string; readonly input: Input }, text: string) => unknown;
};

/**
 * Geno's tools whose input differs from the Claude Code tool's: what a hook reads in `tool_input`, and how a hook's
 * `updatedInput` reads back. A hook written for Claude Code finds `file_path` and `command` where it looks for them.
 */
const CLAUDE_SHAPES: Readonly<Record<string, ClaudeShape>> = {
  bash: {
    // Geno's command output is one stream, stdout and stderr as they came, so it all goes in stdout.
    response: (_claude, text) => ({ stdout: text, stderr: '', interrupted: false, isImage: false, noOutputExpected: false }),
    claude: ({ command, description, timeout_seconds, run_in_background }) => ({
      name: 'Bash',
      input: defined({ command, description, timeout: numberOf(timeout_seconds) === undefined ? undefined : (timeout_seconds as number) * 1000, run_in_background }),
    }),
    geno: ({ command, description, timeout, run_in_background }) =>
      defined({ command, description, timeout_seconds: numberOf(timeout) === undefined ? undefined : Math.ceil((timeout as number) / 1000), run_in_background }),
  },
  read: {
    claude: ({ path: file, start_line, end_line, pages, cells }, workspace) => {
      const start = numberOf(start_line);
      const end = numberOf(end_line);
      return {
        name: 'Read',
        input: defined({ file_path: typeof file === 'string' ? path.resolve(workspace, file) : file, offset: start, limit: end === undefined ? undefined : end - (start ?? 1) + 1, pages, cells }),
      };
    },
    geno: ({ file_path, offset, limit, pages, cells }) => {
      const start = numberOf(offset) ?? (numberOf(limit) === undefined ? undefined : 1);
      return defined({ path: file_path, start_line: start, end_line: numberOf(limit) === undefined ? undefined : start! + (limit as number) - 1, pages, cells });
    },
  },
  edit: {
    response: ({ name, input }) =>
      name === 'Write'
        ? { type: 'create', filePath: input['file_path'], content: input['content'] }
        : { filePath: input['file_path'], oldString: input['old_string'], newString: input['new_string'], replaceAll: input['replace_all'] === true },
    claude: ({ path: file, old_str, new_str, replace_all, create }, workspace) => {
      const file_path = typeof file === 'string' ? path.resolve(workspace, file) : file;
      return create === true
        ? { name: 'Write', input: { file_path, content: new_str } }
        : { name: 'Edit', input: defined({ file_path, old_string: old_str, new_string: new_str, replace_all }) };
    },
    geno: ({ file_path, old_string, new_string, replace_all, content }) =>
      content !== undefined ? { path: file_path, new_str: content, create: true } : defined({ path: file_path, old_str: old_string, new_str: new_string, replace_all }),
  },
  // Claude Code's own fields, but its notebook_path is always absolute.
  notebook_edit: {
    claude: (input, workspace) => ({ name: 'NotebookEdit', input: { ...input, notebook_path: typeof input['notebook_path'] === 'string' ? path.resolve(workspace, input['notebook_path']) : input['notebook_path'] } }),
    geno: (input) => input,
  },
};

/** A Geno call as a tool event's hook reads it: Claude Code's tool name where one maps to the tool, and its input. */
export function claudeToolCall(name: string, input: unknown, workspace: string): { readonly tool_name: string; readonly tool_input: unknown } {
  const shape = Object.hasOwn(CLAUDE_SHAPES, name) && isRecord(input) ? CLAUDE_SHAPES[name]!.claude(input, workspace) : undefined;
  if (shape !== undefined) return { tool_name: shape.name, tool_input: shape.input };
  return { tool_name: claudeNamesOf(name)[0] ?? name, tool_input: input };
}

/** A call's result as an after-tool hook reads it in `tool_response`: Claude Code's object for Bash, Write and Edit, the result text otherwise. */
export function claudeToolResponse(name: string, input: unknown, text: string, workspace: string): unknown {
  const shape = Object.hasOwn(CLAUDE_SHAPES, name) && isRecord(input) ? CLAUDE_SHAPES[name]! : undefined;
  return shape?.response === undefined ? text : shape.response(shape.claude(input as Input, workspace), text);
}

/** A hook's `updatedInput`, written in Claude Code's shape, as the input of Geno's tool. */
export const genoToolInput = (name: string, input: Input): Input => (Object.hasOwn(CLAUDE_SHAPES, name) ? CLAUDE_SHAPES[name]!.geno(input) : input);

/** SessionStart's sources. Geno has no `/clear`, so `clear` never fires. */
export type SessionStartSource = 'startup' | 'resume' | 'compact';

/** SessionEnd's reason: Geno ends a session only when its process does. */
export type SessionEndReason = 'other';

/** The events whose output joins one call's result. */
export type CallHookEvent = Exclude<ToolHookEvent, 'PostToolBatch'>;

/**
 * Hook output the model reads, logged so a resumed session sends the same bytes. `matched` is what the matcher saw,
 * such as SessionStart's source, or the call's Claude Code tool name. A startup's output opens the first message and
 * any other SessionStart's joins the next one; UserPromptSubmit's follows the prompt it was about. A call's hooks
 * append to the result of `toolUseId`, and PostToolBatch's follows the batch's results. Stop's, or a subagent's
 * SubagentStop's, is the message that keeps the turn going after the model ended it. SubagentStart's opens the
 * subagent's next request, before its task.
 */
export type HookContextEvent = {
  readonly kind: 'hook-context';
  readonly seq: number;
  readonly at: string;
  readonly notes: readonly HookNote[];
} & (
  | { readonly event: 'SessionStart'; readonly matched: SessionStartSource }
  | { readonly event: 'UserPromptSubmit' | 'PostToolBatch' | 'SubagentStart'; readonly matched?: undefined }
  | { readonly event: StopEvent; readonly matched?: undefined }
  | { readonly event: CallHookEvent; readonly matched: string; readonly toolUseId: string }
);

/** Claude Code's label for a hook: `SessionStart:startup`, `PostToolUse:Bash`, or the bare event. */
export const hookLabel = (event: HookEventName, matched: string | undefined): string => (matched === undefined ? event : `${event}:${matched}`);

export const hookContextTexts = (event: HookContextEvent): string[] => event.notes.map((note) => hookNoteText(hookLabel(event.event, event.matched), note));

/** Claude Code's `permission_mode` for each of Geno's modes; a non-interactive run denies what it would ask, like dontAsk. */
export const HOOK_PERMISSION_MODES: Readonly<Record<SessionMode | 'non-interactive', string>> = {
  ask: 'default',
  auto: 'auto',
  plan: 'plan',
  'non-interactive': 'dontAsk',
};

/** The fields every hook gets on stdin. `transcript_path` is the Geno session log, one JSON event per line. */
export type HookCommonInput = {
  readonly session_id: string;
  readonly transcript_path: string;
  readonly cwd: string;
  readonly permission_mode: string;
  readonly hook_event_name: HookEventName;
};

/**
 * A tool call as PreToolUse's hooks read it. `agent_id` and `agent_type` name the subagent that makes the call, as
 * Claude Code's do; a call of the session's own model has neither.
 */
export type PreToolUseInput = {
  readonly tool_name: string;
  readonly tool_input: unknown;
  readonly tool_use_id: string;
  readonly agent_id?: string;
  readonly agent_type?: string;
};

/** A call that ran, as PostToolBatch lists it. */
export type BatchCall = { readonly tool_name: string; readonly tool_input: unknown; readonly tool_use_id: string; readonly tool_response: unknown };

/** The subagent a hook fires for, as Claude Code names it; a hook of the session's own model has neither field. */
type AgentFields = { readonly agent_id?: string; readonly agent_type?: string };

/** The subagent a subagent event is about: its own session, and its agent's name, which the matcher reads. */
type Subagent = { readonly agent_id: string; readonly agent_type: string };

/** The fields Stop and SubagentStop share. Geno sends no `background_tasks` or `session_crons`. */
export type StopInput = { readonly stop_hook_active: boolean; readonly last_assistant_message: string };

/** The events that fire as a model ends its turn: the session's own, or a subagent's. */
export type StopEvent = 'Stop' | 'SubagentStop';

/** Each running event's own fields. */
export type HookEventInputs = {
  readonly SessionStart: { readonly source: SessionStartSource };
  readonly SessionEnd: { readonly reason: SessionEndReason };
  readonly UserPromptSubmit: { readonly prompt: string };
  readonly PreToolUse: PreToolUseInput;
  /** `duration_ms` runs from the call's start to its result: after its PreToolUse hooks, with any question to the user. */
  readonly PostToolUse: PreToolUseInput & { readonly tool_response: unknown; readonly duration_ms: number };
  /** `error` is the result the model reads, `Exit code 1` and the output for a command. Geno runs no hook for a call the user stopped. */
  readonly PostToolUseFailure: PreToolUseInput & { readonly error: string; readonly is_interrupt: false; readonly duration_ms: number };
  readonly PostToolBatch: AgentFields & { readonly tool_calls: readonly BatchCall[] };
  readonly Stop: StopInput;
  /** Like PreToolUse's call, without `tool_use_id`. `permission_suggestions` is what the card offers to keep. */
  readonly PermissionRequest: AgentFields & { readonly tool_name: string; readonly tool_input: unknown; readonly permission_suggestions?: readonly PermissionSuggestion[] };
  readonly SubagentStart: Subagent;
  /** `agent_transcript_path` is the subagent's own session log; `transcript_path` stays the parent's. */
  readonly SubagentStop: Subagent & StopInput & { readonly agent_transcript_path: string };
  /**
   * Geno's own event, after a new lane is set up and before a session runs in it. A lane has no session yet, so the
   * payload has no `session_id`, `transcript_path` or `permission_mode`. `cwd` is the lane.
   */
  readonly LaneCreated: { readonly name: string; readonly worktree_path: string; readonly branch: string; readonly base_commit: string; readonly main_checkout: string };
};

export type RunningHookEvent = keyof HookEventInputs;

const toolMatched = (input: { readonly tool_name: string }): string => CLAUDE_TOOL_NAMES[input.tool_name] ?? input.tool_name;

/**
 * The value an event's matcher is tested against: Geno's tool name for a tool event, which a matcher may also name by
 * Claude Code's (`matcherMatches`). The subagent events match the agent's name. UserPromptSubmit, PostToolBatch, Stop
 * and LaneCreated have no matcher.
 */
export const MATCHED_FIELD: { readonly [E in RunningHookEvent]: (input: HookEventInputs[E]) => string | undefined } = {
  SessionStart: (input) => input.source,
  SessionEnd: (input) => input.reason,
  UserPromptSubmit: () => undefined,
  PreToolUse: toolMatched,
  PostToolUse: toolMatched,
  PostToolUseFailure: toolMatched,
  PostToolBatch: () => undefined,
  Stop: () => undefined,
  PermissionRequest: toolMatched,
  SubagentStart: (input) => input.agent_type,
  SubagentStop: (input) => input.agent_type,
  LaneCreated: () => undefined,
};

/**
 * Sent by an editor at initialize: whether it trusts its workspace, as VS Code's workspace trust says. Only then do the
 * workspace's own hooks run; a client that does not send it, such as the command line, runs the user's hooks only.
 */
export const WORKSPACE_TRUST_CAPABILITY = 'gcode/workspaceTrusted';

/** Settings' Hooks section: every hook found for a folder, whether each runs, and what is wrong with the files. */
export const HOOKS_METHOD = '_gcode/hooks';

export type HooksRequest = { readonly cwd: string };

/** `untrusted` is a workspace hook in a workspace the editor does not trust; `never` is an event Geno does not fire. */
export type HookStatus = 'runs' | 'untrusted' | Exclude<HookSupport, 'runs'>;

export type HookRow = {
  readonly event: HookEventName;
  readonly matcher: string | undefined;
  readonly command: string;
  readonly file: string;
  readonly scope: HookScope;
  readonly plugin: string | undefined;
  readonly status: HookStatus;
  /** Why Geno never fires the hook's event. */
  readonly why?: string;
};

export type HooksResponse = { readonly workspace: string; readonly trusted: boolean; readonly hooks: readonly HookRow[]; readonly problems: readonly HookProblem[] };

/** A workspace's own LaneCreated hook never runs: a repository's setup for its lanes is `laneSetup`, which the user approves once. */
const WORKSPACE_LANE_WHY = "A workspace's LaneCreated hook never runs. Put the repository's lane setup in laneSetup in .g-code/settings.json, which you approve once, or the hook in your own settings.";

const whyNever = (entry: HookEntry): string | undefined =>
  entry.event === 'LaneCreated' && entry.origin.scope === 'project' ? WORKSPACE_LANE_WHY : HOOK_EVENTS[entry.event].why;

export function hookStatus(entry: HookEntry, trusted: boolean): HookStatus {
  if (whyNever(entry) !== undefined) return 'never';
  return entry.origin.scope === 'project' && !trusted ? 'untrusted' : 'runs';
}

export const hookRows = (entries: readonly HookEntry[], trusted: boolean): HookRow[] =>
  entries.map((entry) => {
    const why = whyNever(entry);
    return {
      event: entry.event,
      matcher: entry.matcher,
      command: entry.command,
      file: entry.origin.file,
      scope: entry.origin.scope,
      plugin: entry.origin.plugin?.name,
      status: hookStatus(entry, trusted),
      ...(why === undefined ? {} : { why }),
    };
  });
