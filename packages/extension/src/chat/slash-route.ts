import { BUILTIN_COMMANDS, COMMAND_META, parseInvocation, type BuiltinRunner, type CommandMeta } from '@g-code/core';
import type * as acp from '@agentclientprotocol/sdk';
import { z } from 'zod';
import type { CommandOption, CommandRoute, SentCommand } from './slash.js';

/**
 * Where a sent `/` command goes. The engine lists the commands through ACP `available_commands_update`, each marked
 * under `_meta["gcode/command"]` with what it is and, for a built-in, who runs it.
 */

const commandMeta = z.object({ kind: z.enum(['builtin', 'prompt', 'skill']), runs: z.enum(['client', 'engine']).optional() });

const ROUTES: Readonly<Record<CommandMeta['kind'], (runs: BuiltinRunner | undefined) => CommandRoute>> = {
  builtin: (runs) => (runs === 'client' ? 'editor' : 'engine'),
  prompt: () => 'prompt',
  skill: () => 'skill',
};

/** A listed command's route; a command without the engine's marking is sent as typed, like a prompt. */
function routeOf(meta: unknown): CommandRoute {
  const parsed = commandMeta.safeParse(meta);
  return parsed.success ? ROUTES[parsed.data.kind](parsed.data.runs) : 'prompt';
}

export const commandOptions = (listed: readonly acp.AvailableCommand[]): CommandOption[] =>
  listed.map(({ name, description, input, _meta }) => ({ name, description, hint: input?.hint, route: routeOf(_meta?.[COMMAND_META]) }));

/** What the picker offers before the engine has published its list: the built-ins, which every session has. */
export const BUILTIN_OPTIONS: readonly CommandOption[] = Object.entries(BUILTIN_COMMANDS).map(([name, spec]) => ({
  name,
  description: spec.description,
  hint: 'hint' in spec ? spec.hint : undefined,
  route: ROUTES.builtin(spec.runs),
}));

/** The panel actions the editor's built-ins run instead of a prompt. */
export const EDITOR_ACTIONS = { new: 'new-chat', clear: 'new-chat', history: 'history', model: 'model', rules: 'rules', memory: 'memory', 'best-of-n': 'best-of-n', lane: 'lane' } as const;
export type EditorAction = (typeof EDITOR_ACTIONS)[keyof typeof EDITOR_ACTIONS];

/**
 * What sending `text` does. An editor built-in runs its panel action with the text after its name. A listed command goes to the engine as typed
 * and shows as a chip. Anything else, such as `/usr/bin`, is an ordinary prompt.
 */
export type Routed = { readonly kind: 'editor'; readonly action: EditorAction; readonly args: string } | { readonly kind: 'prompt'; readonly command: SentCommand | undefined };

export function routeText(commands: readonly CommandOption[], text: string): Routed {
  const invocation = parseInvocation(text);
  const command = invocation === undefined ? undefined : commands.find((c) => c.name === invocation.name);
  if (invocation === undefined || command === undefined) return { kind: 'prompt', command: undefined };
  if (command.route === 'editor' && Object.hasOwn(EDITOR_ACTIONS, command.name)) {
    return { kind: 'editor', action: EDITOR_ACTIONS[command.name as keyof typeof EDITOR_ACTIONS], args: invocation.args };
  }
  return { kind: 'prompt', command: { ...invocation, route: command.route } };
}

