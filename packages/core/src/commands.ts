// Portions ported from Pi (https://github.com/earendil-works/pi) at b2b5c42, Copyright (c) 2025 Mario Zechner, MIT License.

import type { ContextItem } from './context.js';

/**
 * Slash commands: the built-ins, prompt templates from `commands/*.md` files, and skills invoked by name. Files and
 * skills are repository or user text, so an expansion is the user's message (the user chose to send it), while a
 * skill's SKILL.md travels as an attached context item, data beside the message.
 */

/** Who runs a built-in: the editor, before it ever sends a prompt, or the engine, without a model call. */
export type BuiltinRunner = 'client' | 'engine';

/** `turn` makes an engine built-in run one agent turn on that fixed prompt, instead of answering without the model. */
type BuiltinSpec = { readonly description: string; readonly hint?: string; readonly runs: BuiltinRunner; readonly turn?: (args: string) => string };

/** /init's turn. Written for Geno; the idea, an agent that surveys the project and writes AGENTS.md, is OpenCode's. */
const initPrompt = (args: string): string =>
  [
    'Create or update AGENTS.md at the root of this workspace, the file coding agents read before working here.',
    '',
    'First read the project: its README, its package or build manifests, its CI config, its lint and format config, the layout of its top-level folders, and a few representative source and test files. Also read any CLAUDE.md, .cursor/rules or .github/copilot-instructions.md, and fold what still holds into AGENTS.md.',
    '',
    'Then write AGENTS.md with these sections, each short and specific to this project:',
    '- What this project is, in two or three sentences.',
    '- How to install, build, run, test (including a single test) and lint, as exact commands that work in this repository.',
    '- The layout: the folders that matter and what lives in each.',
    '- The conventions a newcomer would get wrong: code style, naming, error handling, testing patterns, and anything the config enforces.',
    '',
    'Write only what you checked in the files; never invent a command or a convention. Keep it under about 150 lines.',
    'If AGENTS.md already exists, read it first and keep everything the user wrote, word for word. Only add what is missing or correct what is clearly out of date, and say what you changed.',
    'Change no other file. End with a short summary of what AGENTS.md now covers.',
    ...(args === '' ? [] : ['', `The user added: ${args}`]),
  ].join('\n');


export const BUILTIN_COMMANDS = {
  new: { description: 'Start a new chat', runs: 'client' },
  history: { description: 'Open a past chat', runs: 'client' },
  mode: { description: 'Switch the approval mode', hint: 'plan | ask | auto', runs: 'engine' },
  model: { description: 'Choose the model', runs: 'client' },
  clear: { description: 'Clear the chat and start fresh', runs: 'client' },
  compact: { description: 'Summarize the older turns to free context', hint: '[focus]', runs: 'engine' },
  rules: { description: 'Show the project rules', runs: 'client' },
  memory: { description: 'Show what Geno remembers', runs: 'client' },
  init: { description: 'Create or update AGENTS.md for this project', runs: 'engine', turn: initPrompt },
  'best-of-n': { description: 'Run a task in 2 to 4 lanes and pick the best; --vary seeds, effort or models', hint: '<2-4> <task>', runs: 'client' },
} as const satisfies Record<string, BuiltinSpec>;

export type BuiltinName = keyof typeof BUILTIN_COMMANDS;
/** The engine built-ins that answer without the model; the others run a turn. */
export type EngineBuiltin = {
  [K in BuiltinName]: (typeof BUILTIN_COMMANDS)[K] extends { readonly runs: 'engine'; readonly turn: unknown } ? never : (typeof BUILTIN_COMMANDS)[K]['runs'] extends 'engine' ? K : never;
}[BuiltinName];

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
  builtin: ({ name, runs }, _text, args) => {
    const spec: BuiltinSpec = BUILTIN_COMMANDS[name];
    return spec.turn === undefined
      ? { kind: 'builtin', name, runs, args }
      : { kind: 'message', content: spec.turn(args), command: { name, args }, context: [] };
  },
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
