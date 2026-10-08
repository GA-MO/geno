import path from 'node:path';
import {
  flaggingRules,
  flagsOf,
  isHardAsk,
  lineDenial,
  mergedDenial,
  parseCommandLine,
  simpleCommand,
  splitCommand,
  type ApprovalMode,
  type CommandScope,
  type Denial,
  type DenyRuleId,
  type Flag,
  type ParsedCommand,
  type SimpleCommand,
} from './approval.js';

/** `ask` puts the question to the user in Ask and Auto alike, and refuses where nobody can answer. */
export const RULE_EFFECTS = ['allow', 'ask', 'deny'] as const;
export type RuleEffect = (typeof RULE_EFFECTS)[number];

/** The file tools a path rule names, as Claude Code's `Read(...)` and `Edit(...)`. */
export const PATH_TOOLS = ['read', 'edit'] as const;
export type PathTool = (typeof PATH_TOOLS)[number];
/** Geno reads and edits the workspace without asking, so a path rule only asks or denies. */
export const PATH_EFFECTS = ['ask', 'deny'] as const;
export type PathEffect = (typeof PATH_EFFECTS)[number];

/** A program and its fixed leading arguments, quotes removed: `pnpm vitest run` is `['pnpm', 'vitest', 'run']`. */
export type CommandPattern = readonly [string, ...string[]];

/** Where an imported rule lives, such as `.claude/settings.json`; a rule without one is from Settings under Permissions. */
type RuleSource = { readonly source?: string | undefined };

/** A rule the user keeps for one workspace. A command matches it when its words start with the pattern. */
export type CommandRule = RuleSource & {
  readonly id: string;
  readonly effect: RuleEffect;
  readonly pattern: CommandPattern;
  readonly createdAt: string;
};

/**
 * A rule on files, in Claude Code's gitignore syntax: `//abs/path`, `~/path`, `/path` from the workspace root, and
 * `path` or `./path` from the workspace, where a pattern without a slash matches at any depth.
 */
export type PathRule = RuleSource & {
  readonly id: string;
  readonly effect: PathEffect;
  readonly tool: PathTool;
  readonly path: string;
  readonly createdAt: string;
};

export type PermissionRule = CommandRule | PathRule;

/** A rule as the user gives it, before the store names and dates it. */
export type NewRule = Pick<CommandRule, 'effect' | 'pattern'> | Pick<PathRule, 'effect' | 'tool' | 'path'>;

export const isPathRule = <R extends PermissionRule | NewRule>(rule: R): rule is Extract<R, { readonly tool: PathTool }> => 'tool' in rule;
const commandRules = (rules: readonly PermissionRule[]): readonly CommandRule[] => rules.filter((rule): rule is CommandRule => !isPathRule(rule));

/** The store record: one file per workspace under the app home, never in the repository. */
export type PermissionsFile = { readonly version: 1; readonly workspace: string; readonly rules: readonly PermissionRule[] };

/**
 * Which rules each mode honours. Plan stays read-only whatever the rules say. A run with nobody to ask still obeys a
 * deny, but no allow: the user saved that allow while watching a session, not for an unattended run.
 *
 * The decision for a line, in order:
 * 1. Plan: the built-in verdict.
 * 2. A deny rule matches any simple command, or a word names a path a `read` deny rule covers: denied, without asking or classifying.
 * 3. An ask rule matches the same way: the user is asked, in Auto too, and nobody asked refuses it.
 * 4. The line is over 10,000 characters or does not parse: the line rule's verdict, which no allow rule covers.
 * 5. The built-in rules flag nothing: it runs.
 * 6. Allow rules honoured, and every flagged simple command is covered: it runs, unasked and unclassified.
 * 7. Otherwise the built-in verdict, with an allow rule to offer when one simple command needs it.
 *
 * A flagged simple command is covered when it is no hard ask (`isHardAsk`), its words start with an allow rule's
 * pattern, and the pattern on its own earns every rule that flags it. So `pnpm vitest run ../../x` is not covered by
 * `pnpm vitest run`: the outside path flags it, and the pattern alone does not.
 */
export const RULES_IN_MODE: Readonly<Record<ApprovalMode, Readonly<Record<RuleEffect, boolean>>>> = {
  plan: { allow: false, ask: false, deny: false },
  ask: { allow: true, ask: true, deny: true },
  auto: { allow: true, ask: true, deny: true },
  'non-interactive': { allow: false, ask: true, deny: true },
};

const startsWith = (words: readonly string[], pattern: readonly string[]): boolean =>
  pattern.length <= words.length && pattern.every((word, i) => words[i] === word);

const computed = (word: string): boolean => /[$`]/.test(word);

// Claude Code's list of variables that change no code a program loads, so `NODE_ENV=test pnpm test` matches `pnpm test`.
const SAFE_VARIABLES = new Set([
  'GOEXPERIMENT', 'GOOS', 'GOARCH', 'CGO_ENABLED', 'GO111MODULE', 'RUST_BACKTRACE', 'RUST_LOG', 'NODE_ENV',
  'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE', 'PYTEST_DISABLE_PLUGIN_AUTOLOAD', 'PYTEST_DEBUG', 'LANG', 'LANGUAGE',
  'LC_ALL', 'LC_CTYPE', 'LC_TIME', 'CHARSET', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'TZ', 'LS_COLORS',
  'LSCOLORS', 'GREP_COLOR', 'GREP_COLORS', 'GCC_COLORS', 'TIME_STYLE', 'BLOCK_SIZE', 'BLOCKSIZE',
]);
const safeAssignment = (word: string): boolean => {
  const at = word.indexOf('=');
  return at > 0 && SAFE_VARIABLES.has(word.slice(0, at)) && !computed(word.slice(at + 1));
};

const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;
const NICENESS = /^-?\d+$/;
/** How many words a wrapper's options take, or undefined when they are not a form that runs the rest unchanged. */
type WrapperOptions = (args: readonly string[]) => number | undefined;
const bare: WrapperOptions = (args) => (args[0]?.startsWith('-') ? undefined : 0);

/**
 * Claude Code's safe wrappers, which run the command after their own options as it is. `xargs` is not one here: it
 * runs its command with arguments read from input, which no allow rule sees, so Geno keeps it open-ended.
 */
const SAFE_WRAPPERS: ReadonlyMap<string, WrapperOptions> = new Map<string, WrapperOptions>([
  ['nohup', bare],
  ['command', bare],
  ['builtin', bare],
  ['noglob', bare],
  ['time', (args) => (args[0] === '-p' ? 1 : bare(args))],
  ['nice', (args) => {
    if (args[0] === '-n') return NICENESS.test(args[1] ?? '') ? 2 : undefined;
    if (/^-n-?\d+$/.test(args[0] ?? '') || /^--adjustment=-?\d+$/.test(args[0] ?? '') || /^-\d+$/.test(args[0] ?? '')) return 1;
    return bare(args);
  }],
  ['timeout', (args) => {
    let i = 0;
    for (;;) {
      const option = args[i] ?? '';
      if (['--foreground', '--preserve-status', '-v', '--verbose'].includes(option) || /^(?:--kill-after|--signal)=\S+$/.test(option) || /^-[ks]\S+$/.test(option)) i++;
      else if (option === '-k' || option === '-s') i += 2;
      else break;
    }
    return DURATION.test(args[i] ?? '') ? i + 1 : undefined;
  }],
  ['stdbuf', (args) => {
    let i = 0;
    for (;;) {
      const option = args[i] ?? '';
      if (/^-[ioe]\S+$/.test(option) || /^--(?:input|output|error)=\S+$/.test(option)) i++;
      else if (/^-[ioe]$/.test(option)) i += 2;
      else break;
    }
    return i > 0 ? i : undefined;
  }],
]);

/** The words with Claude Code's safe wrappers and safe variable assignments taken off the front, `env` with only those included. */
function unwrap(words: readonly string[]): readonly string[] {
  let i = 0;
  for (;;) {
    const word = words[i];
    if (word === undefined) return words;
    if (safeAssignment(word)) i++;
    else if (word === 'env' && !words[i + 1]?.startsWith('-')) i++;
    else {
      const taken = SAFE_WRAPPERS.get(word)?.(words.slice(i + 1));
      if (taken === undefined) break;
      i += 1 + taken;
    }
  }
  return i === 0 ? words : words.slice(i);
}

/**
 * A deny or an ask looks through wrappers, assignments and a program named by path, and a program word known only at
 * run time, such as `$(echo pnpm)`, stands for any program.
 */
function denies(pattern: CommandPattern, { words, executable, program, args }: SimpleCommand): boolean {
  return [words, unwrap(words), [executable, ...args], [program, ...args]].some(
    (form) => startsWith(form, pattern) || (computed(form[0] ?? '') && startsWith(form.slice(1), pattern.slice(1))),
  );
}

const patternFlags = (pattern: readonly string[], scope: CommandScope, mode: ApprovalMode): ReadonlySet<DenyRuleId> =>
  flaggingRules(simpleCommand(pattern, scope.workspace), scope, mode);

const isHard = (command: ParsedCommand, scope: CommandScope): boolean => command.variants.some((simple) => isHardAsk(simple, scope));

/** The rules that flag a command once its safe wrappers are off, which an allow rule for the wrapped command must earn. */
const unwrappedFlags = (command: ParsedCommand, scope: CommandScope, mode: ApprovalMode): readonly DenyRuleId[] => [
  ...new Set(command.variants.flatMap((simple) => [...flaggingRules(simpleCommand(unwrap(simple.words), simple.cwd), scope, mode)])),
];

function covers(rule: CommandRule, command: ParsedCommand, flagged: readonly DenyRuleId[], scope: CommandScope, mode: ApprovalMode): boolean {
  if (isOpenEnded(rule.pattern)) return false;
  const earned = patternFlags(rule.pattern, scope, mode);
  if (startsWith(command.words, rule.pattern)) return flagged.every((id) => earned.has(id));
  const inner = unwrap(command.words);
  return inner !== command.words && startsWith(inner, rule.pattern) && unwrappedFlags(command, scope, mode).every((id) => earned.has(id));
}

/** The flagged simple commands of a line, each with the built-in rules that flag it. */
function flaggedCommands(flags: readonly Flag[]): ReadonlyMap<number, readonly DenyRuleId[]> {
  const byCommand = new Map<number, DenyRuleId[]>();
  for (const flag of flags) byCommand.set(flag.at, [...(byCommand.get(flag.at) ?? []), flag.rule]);
  return byCommand;
}

// Programs that run whatever their arguments say, so no rule is offered for them and an allow rule may not name them.
const OPEN_ENDED = new Set([
  'sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'eval', 'exec', 'source', '.', 'sudo', 'su', 'doas', 'env', 'xargs',
  'command', 'nohup', 'time', 'nice',
]);
const MAX_OFFER_VERBS = 2;
// An interpreter's flag for code given inline, which makes `python3 -c` as open-ended as a shell.
const INLINE_CODE = /^(?:-c|-e|-p|-E|--eval|--print|--command)$/;
const isOpenEnded = (words: readonly string[]): boolean => OPEN_ENDED.has(words[0] ?? '') || words.slice(1).some((word) => INLINE_CODE.test(word));

/**
 * The allow rule a question offers: the program and up to two subcommand words, grown until the pattern alone earns
 * every rule that flags the command. Undefined when it cannot, or the pattern would be a lone program.
 */
function offerFor(words: readonly string[], flagged: readonly DenyRuleId[], scope: CommandScope, mode: ApprovalMode): CommandPattern | undefined {
  const [program] = words;
  if (program === undefined || program.includes('/') || program.includes('=')) return undefined;
  let verbs = 0;
  while (verbs < MAX_OFFER_VERBS && isVerb(words[1 + verbs])) verbs++;
  for (let length = Math.max(2, 1 + verbs); length <= words.length; length++) {
    const candidate = words.slice(0, length);
    if (candidate.some(computed) || isOpenEnded(candidate)) return undefined;
    const earned = patternFlags(candidate, scope, mode);
    if (flagged.every((id) => earned.has(id))) return candidate as unknown as CommandPattern;
  }
  return undefined;
}

const isVerb = (word: string | undefined): boolean => word !== undefined && !word.startsWith('-') && !computed(word) && !word.includes('=');

/** What a PreToolUse hook's allow never answers: a credentials file, a path outside the workspace, or a hard ask. */
const FIRM_RULES: ReadonlySet<DenyRuleId> = new Set(['secret-path', 'path-outside-workspace']);

/** Where the user keeps a rule, as a refusal names it. */
export const ruleHome = (rule: RuleSource): string => rule.source ?? 'Settings under Permissions';

/** The question or refusal a user rule puts on a call, which names the rule as the user typed it and where it lives. */
export function userRuleDenial(rule: PermissionRule, command: string): Denial {
  return ruleDenial(rule.effect === 'allow' ? 'ask' : rule.effect, ruleText(rule), ruleHome(rule), command);
}

export function ruleDenial(effect: Exclude<RuleEffect, 'allow'>, text: string, home: string, command: string): Denial {
  return effect === 'deny'
    ? { rule: 'workspace-deny', reason: `the workspace rule that denies \`${text}\`, which the user set in ${home}`, command, verdict: 'deny' }
    : { rule: 'workspace-ask', reason: `the workspace rule that asks before \`${text}\`, which the user set in ${home}`, command, verdict: 'ask' };
}

// A word's value as a path from the workspace, an option's `=value` included; the sandbox holds where a cd moved to.
const wordPaths = (word: string, scope: CommandScope): readonly string[] => {
  const values = word.includes('=') ? [word, word.slice(word.indexOf('=') + 1)] : [word];
  return values.filter((value) => value !== '').map((value) => (value === '~' || value.startsWith('~/') ? path.join(scope.home, value.slice(1)) : path.resolve(scope.workspace, value)));
};

/** The first simple command a rule of this effect catches: its pattern, or a word naming a path a `read` rule covers. */
function caughtBy(effect: RuleEffect, parsed: readonly ParsedCommand[], rules: readonly PermissionRule[], scope: CommandScope): Denial | undefined {
  const catches = (rule: PermissionRule, simple: SimpleCommand): boolean =>
    isPathRule(rule)
      ? rule.tool === 'read' && simple.words.some((word) => wordPaths(word, scope).some((file) => pathRuleMatches(rule, file, scope)))
      : denies(rule.pattern, simple);
  for (const rule of rules) {
    if (rule.effect !== effect) continue;
    const hit = parsed.find(({ variants }) => variants.some((simple) => catches(rule, simple)));
    if (hit !== undefined) return userRuleDenial(rule, hit.words.join(' '));
  }
  return undefined;
}

/**
 * The verdict for a line under the workspace's rules; see RULES_IN_MODE for the order. `hookAllows` is a PreToolUse
 * hook's allow, which answers the question and skips the classifier after the deny rules, unless a flagged command is
 * firm (FIRM_RULES, `isHardAsk`).
 */
export function ruledDenial(command: string, scope: CommandScope, mode: ApprovalMode, rules: readonly PermissionRule[], hookAllows = false): Denial | undefined {
  const parsed = parseCommandLine(command, scope);
  const honours = RULES_IN_MODE[mode];
  for (const effect of ['deny', 'ask'] as const) {
    const caught = honours[effect] ? caughtBy(effect, parsed, rules, scope) : undefined;
    if (caught !== undefined) return caught;
  }
  const flags = flagsOf(parsed, scope, mode);
  if (flags.kind === 'deny') return flags.denial;
  const line = lineDenial(command, mode);
  if (line !== undefined && !hookAllows) return line;
  const denial = mergedDenial(command, flags.flags);
  if (denial === undefined || !honours.allow) return denial;
  const flagged = flaggedCommands(flags.flags);
  if (hookAllows && [...flagged].every(([at, ids]) => !isHard(parsed[at]!, scope) && !ids.some((id) => FIRM_RULES.has(id)))) return undefined;
  const allows = commandRules(rules).filter((rule) => rule.effect === 'allow');
  const isCovered = ([at, ids]: readonly [number, readonly DenyRuleId[]]) =>
    !isHard(parsed[at]!, scope) && allows.some((rule) => covers(rule, parsed[at]!, ids, scope, mode));
  if ([...flagged].every(isCovered)) return undefined;
  if (flagged.size !== 1) return denial;
  const [[at, ids]] = [...flagged] as [[number, readonly DenyRuleId[]]];
  if (isHard(parsed[at]!, scope)) return denial;
  const inner = unwrap(parsed[at]!.words);
  const offer = inner === parsed[at]!.words ? offerFor(inner, ids, scope, mode) : offerFor(inner, unwrappedFlags(parsed[at]!, scope, mode), scope, mode);
  return offer === undefined ? denial : { ...denial, offer };
}

/** The compiled form of a path rule: the directory it is anchored at, and the rest as a .gitignore line reads it. */
type PathAnchor = { readonly base: string; readonly rest: string; readonly anyDepth: boolean };

function anchorOf(pattern: string, scope: CommandScope): PathAnchor {
  // `dir/**` covers what is in dir, and so dir itself, which a command such as `grep -r x dir` reads whole.
  const trimmed = pattern.replace(/(?<=.)\/\*\*$/, '').replace(/(?<=.)\/+$/, '');
  if (trimmed.startsWith('//')) return { base: '', rest: trimmed.slice(2), anyDepth: false };
  if (trimmed === '~' || trimmed.startsWith('~/')) return { base: scope.home.replace(/\/+$/, ''), rest: trimmed.slice(2), anyDepth: false };
  if (trimmed.startsWith('/')) return { base: scope.workspace, rest: trimmed.slice(1), anyDepth: false };
  if (trimmed.startsWith('./')) return { base: scope.workspace, rest: trimmed.slice(2), anyDepth: false };
  return { base: scope.workspace, rest: trimmed, anyDepth: !pattern.replace(/\/+$/, '').includes('/') };
}

const escapeRegex = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');

function globRegex(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      out += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else if (ch === '[' && glob.indexOf(']', i + 2) !== -1) {
      const close = glob.indexOf(']', i + 2);
      const body = glob.slice(i + 1, close);
      out += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
      i = close;
    } else out += escapeRegex(ch);
  }
  return out;
}

/** Whether a path rule covers `file`, an absolute path; a rule that names a directory covers everything in it. */
export function pathRuleMatches(rule: Pick<PathRule, 'path'>, file: string, scope: CommandScope): boolean {
  const { base, rest, anyDepth } = anchorOf(rule.path, scope);
  const below = rest === '' ? '' : `/${anyDepth ? '(?:.*/)?' : ''}${globRegex(rest)}`;
  return new RegExp(`^${escapeRegex(base)}${below}(?:/.*)?$`).test(path.normalize(file));
}

/** The path rule that governs `tool` on `file`, a deny before an ask. A `read` deny also stops `edit`, as in Claude Code. */
export function pathRuleFor(tool: PathTool, file: string, rules: readonly PermissionRule[], scope: CommandScope): PathRule | undefined {
  const governing = rules.filter(
    (rule): rule is PathRule => isPathRule(rule) && (rule.tool === tool || (tool === 'edit' && rule.tool === 'read' && rule.effect === 'deny')) && pathRuleMatches(rule, file, scope),
  );
  return governing.find((rule) => rule.effect === 'deny') ?? governing[0];
}

/** The sandbox's globs for a rule, in sandbox-runtime's gitignore-like syntax, each also covering what is under it. */
function sandboxGlobs(rule: PathRule, scope: CommandScope): readonly string[] {
  const { base, rest, anyDepth } = anchorOf(rule.path, scope);
  const tops = rest === '' ? [base === '' ? '/' : base] : anyDepth ? [`${base}/${rest}`, `${base}/**/${rest}`] : [`${base}/${rest}`];
  return tops.flatMap((top) => (top === '/' ? ['/**'] : [top, `${top}/**`]));
}

/**
 * What commands may not read or write under the workspace's deny path rules: a `read` deny hides its files from
 * reading and writing, an `edit` deny from writing. Ask rules have no sandbox form; the command's own check asks.
 */
export function sandboxDenials(rules: readonly PermissionRule[], scope: CommandScope): { readonly denyRead: readonly string[]; readonly denyWrite: readonly string[] } {
  const denied = rules.filter((rule): rule is PathRule => isPathRule(rule) && rule.effect === 'deny');
  const reads = denied.filter((rule) => rule.tool === 'read').flatMap((rule) => sandboxGlobs(rule, scope));
  return { denyRead: reads, denyWrite: [...reads, ...denied.filter((rule) => rule.tool === 'edit').flatMap((rule) => sandboxGlobs(rule, scope))] };
}

const PLAIN_WORD = /^[\w@%+=:,./-]+$/;

/** A pattern as the user reads and types it, a word with spaces or quotes in single quotes. */
export const patternText = (pattern: readonly string[]): string =>
  pattern.map((word) => (PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`)).join(' ');

const OPERATORS = /[;&|<>()$`\n#]/;

const TOOL_LABELS: Readonly<Record<PathTool, string>> = { read: 'Read', edit: 'Edit' };

/** A rule as the user reads and types it: a command's words, or `Read(path)` and `Edit(path)`. */
export const ruleText = (rule: PermissionRule | NewRule): string => (isPathRule(rule) ? `${TOOL_LABELS[rule.tool]}(${rule.path})` : patternText(rule.pattern));

export type ParsedRule = { readonly ok: true; readonly rule: NewRule } | { readonly ok: false; readonly reason: string };

// Claude Code's forms: `Read(path)`, `Edit(path)`, and `Bash(command)`, whose trailing ` *` or `:*` is Geno's prefix match.
const TOOL_FORM = /^(Read|Edit|Bash)\((.*)\)$/s;

/**
 * A rule the user typed. A command is one simple command of plain words, and for an allow nothing that no rule may
 * pre-allow. A path rule asks or denies.
 */
export function parseRule(effect: RuleEffect, text: string, scope: CommandScope): ParsedRule {
  const form = TOOL_FORM.exec(text.trim());
  if (form?.[1] === 'Bash') return parseCommandRule(effect, form[2]!.trim().replace(/(?:\s\*|:\*)$/, ''), scope);
  if (form === null) return parseCommandRule(effect, text, scope);
  const tool = form[1] === 'Read' ? 'read' : 'edit';
  const file = form[2]!.trim();
  if (file === '') return { ok: false, reason: `Name a path, such as ${form[1]}(./secrets/**).` };
  if (effect === 'allow') return { ok: false, reason: `Geno already ${tool === 'read' ? 'reads' : 'edits'} the workspace without asking, so a path rule can only ask or deny.` };
  return { ok: true, rule: { effect, tool, path: file } };
}

function parseCommandRule(effect: RuleEffect, text: string, scope: CommandScope): ParsedRule {
  if (text.trim() === '') return { ok: false, reason: 'Type a command, such as pnpm test.' };
  if (text.includes('*')) return { ok: false, reason: 'A command rule matches the words it starts with, so put * only at the end of Bash(...), or leave it out.' };
  if (OPERATORS.test(text.replace(/'[^']*'/g, ''))) return { ok: false, reason: 'A rule is one command, without operators, redirection or variables.' };
  const commands = splitCommand(text);
  const [words] = commands;
  if (commands.length !== 1 || words === undefined || words.length === 0) return { ok: false, reason: 'A rule is one command.' };
  const [program] = words;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(program!)) return { ok: false, reason: 'Start the rule with the program, not a variable.' };
  if (effect === 'allow' && isOpenEnded(words)) return { ok: false, reason: `${patternText(words)} runs whatever follows it, so Geno does not allow it by rule.` };
  if (effect === 'allow' && isHardAsk(simpleCommand(words, scope.workspace), scope)) {
    return { ok: false, reason: 'Geno always asks before this command, so it cannot be allowed by rule.' };
  }
  return { ok: true, rule: { effect, pattern: words as unknown as CommandPattern } };
}

/** Extension method, sent by the editor: the rules of the workspace a folder belongs to, its main checkout for a lane. */
export const PERMISSIONS_METHOD = '_gcode/permissions';
/** Extension method, sent by the editor: adds a rule typed as text, then answers with the rules. */
export const PERMISSION_ADD_METHOD = '_gcode/permissionAdd';
/** Extension method, sent by the editor: removes one rule, then answers with the rules. */
export const PERMISSION_REMOVE_METHOD = '_gcode/permissionRemove';

export type PermissionsRequest = { readonly cwd: string };
/** `text` is a command, or `Read(path)` or `Edit(path)`. */
export type PermissionAddRequest = { readonly cwd: string; readonly effect: RuleEffect; readonly text: string };
export type PermissionRemoveRequest = { readonly cwd: string; readonly id: string };
export type PermissionsResponse = { readonly workspace: string; readonly rules: readonly PermissionRule[] };
