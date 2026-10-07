import type { SessionMode } from './approval.js';
import { GENO_NOTE, neutralize } from './fence.js';

/**
 * User hooks in Claude Code's format: commands the harness runs at loop events, configured as
 * `hooks.<Event>[{ matcher, hooks: [{ type: 'command', command, timeout }] }]` in settings files and plugins. Geno reads
 * the same files, so a Claude Code or pstack hook runs unchanged. This module is the contract: which events exist and
 * which Geno fires, how a matcher picks a handler, and what a handler's exit code and output mean.
 */

/** Whether Geno fires an event now, which plan unit adds it, or never: Geno has no trigger for it, or another event covers it. */
export type HookSupport = 'runs' | 'P14' | 'P15' | 'P16' | 'never';

type EventSpec = {
  readonly support: HookSupport;
  /** Exit 2 blocks what the event is about, such as a tool call or a prompt. */
  readonly blocks: boolean;
  /** Seconds before the handler is killed, unless it sets its own `timeout`. */
  readonly timeoutSec: number;
  /** Whether a group's matcher filters this event; an event without one runs every group. */
  readonly matcher: boolean;
  /** Whether plain stdout of exit 0 reaches the model as context. */
  readonly stdoutIsContext: boolean;
};

const spec = (support: HookSupport, opts: Partial<Omit<EventSpec, 'support'>> = {}): EventSpec => ({
  support,
  blocks: false,
  timeoutSec: 600,
  matcher: false,
  stdoutIsContext: false,
  ...opts,
});

/** Every event Claude Code fires (research/claude-code-harness/05-hooks.md, spec/03-runtime.md §3). */
export const HOOK_EVENTS = {
  SessionStart: spec('runs', { matcher: true, stdoutIsContext: true }),
  SessionEnd: spec('runs', { matcher: true }),
  UserPromptSubmit: spec('P14', { blocks: true, timeoutSec: 30, stdoutIsContext: true }),
  PreToolUse: spec('P14', { blocks: true, matcher: true }),
  PostToolUse: spec('P15', { matcher: true }),
  PostToolUseFailure: spec('P15', { matcher: true }),
  PostToolBatch: spec('P15', { blocks: true }),
  Stop: spec('P15', { blocks: true }),
  PermissionRequest: spec('P16', { matcher: true }),
  SubagentStart: spec('P16', { matcher: true }),
  SubagentStop: spec('P16', { blocks: true, matcher: true }),
  WorktreeCreate: spec('P16', { blocks: true }),
  WorktreeRemove: spec('P16'),
  Setup: spec('never'),
  UserPromptExpansion: spec('never', { blocks: true }),
  PermissionDenied: spec('never', { matcher: true }),
  Notification: spec('never', { matcher: true }),
  MessageDisplay: spec('never', { timeoutSec: 10 }),
  TaskCreated: spec('never', { blocks: true }),
  TaskCompleted: spec('never', { blocks: true }),
  StopFailure: spec('never'),
  TeammateIdle: spec('never', { blocks: true }),
  InstructionsLoaded: spec('never'),
  ConfigChange: spec('never', { blocks: true }),
  CwdChanged: spec('never'),
  DirectoryAdded: spec('never'),
  FileChanged: spec('never'),
  PreCompact: spec('never', { blocks: true, matcher: true }),
  PostCompact: spec('never', { matcher: true }),
  PreModelSwitch: spec('never', { blocks: true }),
  PostModelSwitch: spec('never'),
  Elicitation: spec('never', { blocks: true }),
  ElicitationResult: spec('never', { blocks: true }),
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
  KillShell: 'bash_stop',
  Read: 'read',
  Edit: 'edit',
  Write: 'edit',
  MultiEdit: 'edit',
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

/** Text a hook gives the model: plain stdout ("hook success") or a JSON `additionalContext`. */
export type HookNote = { readonly how: 'success' | 'additional-context'; readonly text: string };

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

const HOW_WORDS: Readonly<Record<HookNote['how'], string>> = { success: 'hook success', 'additional-context': 'hook additional context' };

/**
 * A hook's text as the model reads it: Claude Code's `<label> hook success: <stdout>` (or `hook additional context`)
 * under Geno's note mark, its text unable to pose as Geno.
 */
export function hookNoteText(label: string, note: HookNote): string {
  const cut = note.text.length > HOOK_NOTE_LIMIT;
  const text = neutralize(cut ? note.text.slice(0, HOOK_NOTE_LIMIT) : note.text);
  return `${GENO_NOTE} ${label} ${HOW_WORDS[note.how]}: ${text}${cut ? `\n${GENO_NOTE} The hook's output was cut to 10,000 characters.` : ''}`;
}

/** SessionStart's sources. Geno has no `/clear`, so `clear` never fires. */
export type SessionStartSource = 'startup' | 'resume' | 'compact';

/** SessionEnd's reason: Geno ends a session only when its process does. */
export type SessionEndReason = 'other';

/**
 * Hook output the model reads, logged so a resumed session sends the same bytes. `matched` is what the matcher saw,
 * such as SessionStart's source. A startup's output opens the first message; any other joins the next one.
 */
export type HookContextEvent = {
  readonly kind: 'hook-context';
  readonly seq: number;
  readonly at: string;
  readonly event: 'SessionStart';
  readonly matched: SessionStartSource;
  readonly notes: readonly HookNote[];
};

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

/** Each running event's own fields. P14 to P16 add their events here. */
export type HookEventInputs = {
  readonly SessionStart: { readonly source: SessionStartSource };
  readonly SessionEnd: { readonly reason: SessionEndReason };
};

export type RunningHookEvent = keyof HookEventInputs;

/** The value an event's matcher is tested against. */
export const MATCHED_FIELD: { readonly [E in RunningHookEvent]: (input: HookEventInputs[E]) => string } = {
  SessionStart: (input) => input.source,
  SessionEnd: (input) => input.reason,
};

/**
 * Sent by an editor at initialize: whether it trusts its workspace, as VS Code's workspace trust says. Only then do the
 * workspace's own hooks run; a client that does not send it, such as the command line, runs the user's hooks only.
 */
export const WORKSPACE_TRUST_CAPABILITY = 'gcode/workspaceTrusted';

/** Settings' Hooks section: every hook found for a folder, whether each runs, and what is wrong with the files. */
export const HOOKS_METHOD = '_gcode/hooks';

export type HooksRequest = { readonly cwd: string };

/** `untrusted` is a workspace hook in a workspace the editor does not trust; P14 to P16 and `never` are events Geno does not fire. */
export type HookStatus = 'runs' | 'untrusted' | Exclude<HookSupport, 'runs'>;

export type HookRow = {
  readonly event: HookEventName;
  readonly matcher: string | undefined;
  readonly command: string;
  readonly file: string;
  readonly scope: HookScope;
  readonly plugin: string | undefined;
  readonly status: HookStatus;
};

export type HooksResponse = { readonly workspace: string; readonly trusted: boolean; readonly hooks: readonly HookRow[]; readonly problems: readonly HookProblem[] };

export function hookStatus(entry: HookEntry, trusted: boolean): HookStatus {
  const support = HOOK_EVENTS[entry.event].support;
  if (support !== 'runs') return support;
  return entry.origin.scope === 'project' && !trusted ? 'untrusted' : 'runs';
}

export const hookRows = (entries: readonly HookEntry[], trusted: boolean): HookRow[] =>
  entries.map((entry) => ({
    event: entry.event,
    matcher: entry.matcher,
    command: entry.command,
    file: entry.origin.file,
    scope: entry.origin.scope,
    plugin: entry.origin.plugin?.name,
    status: hookStatus(entry, trusted),
  }));
