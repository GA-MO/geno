import {
  flaggingRules,
  flagsOf,
  isHardAsk,
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

export const RULE_EFFECTS = ['allow', 'deny'] as const;
export type RuleEffect = (typeof RULE_EFFECTS)[number];

/** A program and its fixed leading arguments, quotes removed: `pnpm vitest run` is `['pnpm', 'vitest', 'run']`. */
export type CommandPattern = readonly [string, ...string[]];

/** A rule the user keeps for one workspace. A command matches it when its words start with the pattern. */
export type PermissionRule = {
  readonly id: string;
  readonly effect: RuleEffect;
  readonly pattern: CommandPattern;
  readonly createdAt: string;
};

/** The store record: one file per workspace under the app home, never in the repository. */
export type PermissionsFile = { readonly version: 1; readonly workspace: string; readonly rules: readonly PermissionRule[] };

/**
 * Which rules each mode honours. Plan stays read-only whatever the rules say. A run with nobody to ask still obeys a
 * deny, but no allow: the user saved that allow while watching a session, not for an unattended run.
 *
 * The decision for a line, in order:
 * 1. Plan: the built-in verdict.
 * 2. A deny rule matches any simple command: denied, without asking or classifying.
 * 3. The built-in rules flag nothing: it runs.
 * 4. Allow rules honoured, and every flagged simple command is covered: it runs, unasked and unclassified.
 * 5. Otherwise the built-in verdict, with an allow rule to offer when one simple command needs it.
 *
 * A flagged simple command is covered when it is no hard ask (`isHardAsk`), its words start with an allow rule's
 * pattern, and the pattern on its own earns every rule that flags it. So `pnpm vitest run ../../x` is not covered by
 * `pnpm vitest run`: the outside path flags it, and the pattern alone does not.
 */
export const RULES_IN_MODE: Readonly<Record<ApprovalMode, Readonly<Record<RuleEffect, boolean>>>> = {
  plan: { allow: false, deny: false },
  ask: { allow: true, deny: true },
  auto: { allow: true, deny: true },
  'non-interactive': { allow: false, deny: true },
};

const startsWith = (words: readonly string[], pattern: readonly string[]): boolean =>
  pattern.length <= words.length && pattern.every((word, i) => words[i] === word);

const computed = (word: string): boolean => /[$`]/.test(word);

/**
 * A deny looks through wrappers, assignments and a program named by path, and a program word known only at run time,
 * such as `$(echo pnpm)`, stands for any program.
 */
function denies(pattern: CommandPattern, { words, executable, program, args }: SimpleCommand): boolean {
  return [words, [executable, ...args], [program, ...args]].some(
    (form) => startsWith(form, pattern) || (computed(form[0] ?? '') && startsWith(form.slice(1), pattern.slice(1))),
  );
}

const patternFlags = (pattern: readonly string[], scope: CommandScope, mode: ApprovalMode): ReadonlySet<DenyRuleId> =>
  flaggingRules(simpleCommand(pattern, scope.workspace), scope, mode);

const isHard = (command: ParsedCommand, scope: CommandScope): boolean => command.variants.some((simple) => isHardAsk(simple, scope));

function covers(rule: PermissionRule, command: ParsedCommand, flagged: readonly DenyRuleId[], scope: CommandScope, mode: ApprovalMode): boolean {
  if (!startsWith(command.words, rule.pattern) || isOpenEnded(rule.pattern)) return false;
  const earned = patternFlags(rule.pattern, scope, mode);
  return flagged.every((id) => earned.has(id));
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

/** The verdict for a line under the workspace's rules; see RULES_IN_MODE for the order. */
export function ruledDenial(command: string, scope: CommandScope, mode: ApprovalMode, rules: readonly PermissionRule[]): Denial | undefined {
  const parsed = parseCommandLine(command, scope);
  const honours = RULES_IN_MODE[mode];
  if (honours.deny) {
    for (const rule of rules) {
      if (rule.effect !== 'deny') continue;
      const hit = parsed.find(({ variants }) => variants.some((simple) => denies(rule.pattern, simple)));
      if (hit !== undefined) {
        return { rule: 'workspace-deny', reason: `the workspace rule that denies \`${patternText(rule.pattern)}\``, command: hit.words.join(' '), verdict: 'deny' };
      }
    }
  }
  const flags = flagsOf(parsed, scope, mode);
  if (flags.kind === 'deny') return flags.denial;
  const denial = mergedDenial(command, flags.flags);
  if (denial === undefined || !honours.allow) return denial;
  const flagged = flaggedCommands(flags.flags);
  const allows = rules.filter((rule) => rule.effect === 'allow');
  const isCovered = ([at, ids]: readonly [number, readonly DenyRuleId[]]) =>
    !isHard(parsed[at]!, scope) && allows.some((rule) => covers(rule, parsed[at]!, ids, scope, mode));
  if ([...flagged].every(isCovered)) return undefined;
  if (flagged.size !== 1) return denial;
  const [[at, ids]] = [...flagged] as [[number, readonly DenyRuleId[]]];
  if (isHard(parsed[at]!, scope)) return denial;
  const offer = offerFor(parsed[at]!.words, ids, scope, mode);
  return offer === undefined ? denial : { ...denial, offer };
}

const PLAIN_WORD = /^[\w@%+=:,./-]+$/;

/** A pattern as the user reads and types it, a word with spaces or quotes in single quotes. */
export const patternText = (pattern: readonly string[]): string =>
  pattern.map((word) => (PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`)).join(' ');

const OPERATORS = /[;&|<>()$`\n#]/;

export type ParsedRule = { readonly ok: true; readonly pattern: CommandPattern } | { readonly ok: false; readonly reason: string };

/** A rule the user typed: one simple command of plain words, and for an allow nothing that no rule may pre-allow. */
export function parseRule(effect: RuleEffect, text: string, scope: CommandScope): ParsedRule {
  if (text.trim() === '') return { ok: false, reason: 'Type a command, such as pnpm test.' };
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
  return { ok: true, pattern: words as unknown as CommandPattern };
}

/** Extension method, sent by the editor: the rules of the workspace a folder belongs to, its main checkout for a lane. */
export const PERMISSIONS_METHOD = '_gcode/permissions';
/** Extension method, sent by the editor: adds a rule typed as text, then answers with the rules. */
export const PERMISSION_ADD_METHOD = '_gcode/permissionAdd';
/** Extension method, sent by the editor: removes one rule, then answers with the rules. */
export const PERMISSION_REMOVE_METHOD = '_gcode/permissionRemove';

export type PermissionsRequest = { readonly cwd: string };
export type PermissionAddRequest = { readonly cwd: string; readonly effect: RuleEffect; readonly text: string };
export type PermissionRemoveRequest = { readonly cwd: string; readonly id: string };
export type PermissionsResponse = { readonly workspace: string; readonly rules: readonly PermissionRule[] };
