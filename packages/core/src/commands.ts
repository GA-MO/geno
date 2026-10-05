// Portions ported from Pi (https://github.com/earendil-works/pi) at b2b5c42, Copyright (c) 2025 Mario Zechner, MIT License.

import type { ContextItem } from './context.js';

/**
 * Slash commands: the built-ins, prompt templates from `commands/*.md` files, and skills invoked by name. Files and
 * skills are repository or user text, so an expansion is the user's message (the user chose to send it), while a
 * skill's SKILL.md travels as an attached context item, data beside the message.
 */

/** Who runs a built-in: the editor, before it ever sends a prompt, or the engine, without a model call. */
export type BuiltinRunner = 'client' | 'engine';

type BuiltinSpec = { readonly description: string; readonly hint?: string; readonly runs: BuiltinRunner };

export const BUILTIN_COMMANDS = {
  new: { description: 'Start a new chat', runs: 'client' },
  history: { description: 'Open a past chat', runs: 'client' },
  mode: { description: 'Switch the approval mode', hint: 'plan | ask | auto', runs: 'engine' },
  model: { description: 'Choose the model', runs: 'client' },
  clear: { description: 'Clear the chat and start fresh', runs: 'client' },
  rules: { description: 'Show the project rules', runs: 'engine' },
  memory: { description: 'Show what Geno remembers', runs: 'engine' },
  init: { description: 'Create or update AGENTS.md for this project', runs: 'engine' },
} as const satisfies Record<string, BuiltinSpec>;

export type BuiltinName = keyof typeof BUILTIN_COMMANDS;
export type EngineBuiltin = { [K in BuiltinName]: (typeof BUILTIN_COMMANDS)[K]['runs'] extends 'engine' ? K : never }[BuiltinName];

/** Where a file command or skill came from; a workspace one shadows a global one of the same name. */
export type CommandSource = 'workspace' | 'global';

/** Skills also come from installed Claude Code plugins, read in place and named `<plugin>:<skill>`. */
export type SkillSource = CommandSource | 'plugin';

type Listed = { readonly name: string; readonly description: string; readonly hint: string | undefined };

export type SlashCommand =
  | (Listed & { readonly kind: 'builtin'; readonly name: BuiltinName; readonly runs: BuiltinRunner })
  /** `path` is relative to the workspace for a workspace file, else absolute. */
  | (Listed & { readonly kind: 'prompt'; readonly scope: CommandSource; readonly path: string; readonly template: string })
  /**
   * `text` is the whole SKILL.md, frontmatter included. `userInvocable` is false for a skill whose frontmatter says
   * `user-invocable: false`: the model may load it, but the slash list does not offer it.
   */
  | (Listed & { readonly kind: 'skill'; readonly scope: SkillSource; readonly path: string; readonly text: string; readonly userInvocable: boolean });

/** Key in an ACP available command's `_meta`: `{ kind, runs? }`, so the editor knows which built-ins it runs itself. */
export const COMMAND_META = 'gcode/command';

export type CommandMeta = { readonly kind: SlashCommand['kind']; readonly runs?: BuiltinRunner };

/** What a user event records of the command that produced it: the name and the raw text after it. */
export type Invocation = { readonly name: string; readonly args: string };

export const builtinCommands = (): SlashCommand[] =>
  Object.entries(BUILTIN_COMMANDS).map(([name, spec]: [string, BuiltinSpec]) => ({
    kind: 'builtin',
    name: name as BuiltinName,
    description: spec.description,
    hint: spec.hint,
    runs: spec.runs,
  }));

/** What the slash list offers the user: everything but the skills only the model loads. */
export const listedCommands = (commands: readonly SlashCommand[]): SlashCommand[] => commands.filter((c) => c.kind !== 'skill' || c.userInvocable);

/** Groups in precedence order; the first command of each name wins. */
export function mergeCommands(groups: readonly (readonly SlashCommand[])[]): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  for (const command of groups.flat()) if (!byName.has(command.name)) byName.set(command.name, command);
  return [...byName.values()];
}

export function parseInvocation(text: string): Invocation | undefined {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  return match === null ? undefined : { name: match[1]!, args: (match[2] ?? '').trim() };
}

/** Arguments split on whitespace, with single- or double-quoted runs kept whole. */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote: string | null = null;
  for (const char of argsString) {
    if (inQuote !== null) {
      if (char === inQuote) inQuote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (/\s/.test(char)) {
      if (current !== '') args.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current !== '') args.push(current);
  return args;
}

const PLACEHOLDER = /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g;

/**
 * `$1`, `$2`, `$@`, `$ARGUMENTS`, `${N:-default}`, `${@:-default}`, `${@:N}` and `${@:N:L}`, as in bash. Only the
 * template is scanned, so a placeholder inside an argument stays as typed.
 */
export function substituteArgs(content: string, args: readonly string[]): string {
  const all = args.join(' ');
  return content.replace(PLACEHOLDER, (_match, defaultTarget?: string, defaultValue?: string, sliceStart?: string, sliceLength?: string, simple?: string) => {
    if (defaultTarget !== undefined) {
      const value = defaultTarget === '@' || defaultTarget === 'ARGUMENTS' ? all : args[Number(defaultTarget) - 1];
      return value || (defaultValue ?? '');
    }
    if (sliceStart !== undefined) {
      const start = Math.max(Number(sliceStart) - 1, 0);
      return (sliceLength === undefined ? args.slice(start) : args.slice(start, start + Number(sliceLength))).join(' ');
    }
    if (simple === 'ARGUMENTS' || simple === '@') return all;
    return args[Number(simple) - 1] ?? '';
  });
}

/** A template that never mentions its arguments still gets them, as Claude Code does, so nothing the user typed is lost. */
function expandTemplate(template: string, args: string): string {
  const hasPlaceholder = new RegExp(PLACEHOLDER.source).test(template);
  if (hasPlaceholder) return substituteArgs(template, parseCommandArgs(args));
  return args === '' ? template : `${template}\n\nARGUMENTS: ${args}`;
}

export type Expansion =
  | { readonly kind: 'builtin'; readonly name: BuiltinName; readonly runs: BuiltinRunner; readonly args: string }
  | { readonly kind: 'message'; readonly content: string; readonly command: Invocation; readonly context: readonly ContextItem[] };

const EXPAND: { readonly [K in SlashCommand['kind']]: (command: Extract<SlashCommand, { kind: K }>, text: string, args: string) => Expansion } = {
  builtin: ({ name, runs }, _text, args) => ({ kind: 'builtin', name, runs, args }),
  prompt: ({ name, template }, _text, args) => ({ kind: 'message', content: expandTemplate(template, args), command: { name, args }, context: [] }),
  skill: ({ name, path, text: skill }, text, args) => ({
    kind: 'message',
    content: text,
    command: { name, args },
    context: [{ kind: 'skill', name, path, text: skill }],
  }),
};

/** What a prompt that names a command becomes; undefined when it names none, so it is sent as typed. */
export function expandInvocation(commands: readonly SlashCommand[], text: string): Expansion | undefined {
  const invocation = parseInvocation(text);
  const command = invocation === undefined ? undefined : commands.find((c) => c.name === invocation.name);
  if (invocation === undefined || command === undefined) return undefined;
  return (EXPAND[command.kind] as (c: SlashCommand, text: string, args: string) => Expansion)(command, text, invocation.args);
}
