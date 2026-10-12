import type { Invocation } from '@g-code/core';

/**
 * `/` commands in the composer: what the picker shows and how it moves, and the chip a sent command becomes. The
 * webview bundles this file, so it imports only types; routing lives in slash-route.ts, in the extension.
 */

/** Who handles a command once sent: the editor itself, or the engine, as a built-in, a prompt template or a skill. */
export type CommandRoute = 'editor' | 'engine' | 'prompt' | 'skill';

/** One row of the picker. */
export type CommandOption = { readonly name: string; readonly description: string; readonly hint: string | undefined; readonly route: CommandRoute };

/** A sent command as the user's bubble shows it: a chip with its name, then the arguments as typed. */
export type SentCommand = Invocation & { readonly route: CommandRoute };

/** The command name being typed: the composer starts with `/` and the caret is still inside the name. */
export function slashAtCaret(text: string, caret: number): string | undefined {
  return /^\/(\S*)$/.exec(text.slice(0, caret))?.[1];
}

/** The commands whose names match `query`: names starting with it first, then names containing it, each in the engine's order. */
export function matchCommands(commands: readonly CommandOption[], query: string): CommandOption[] {
  const q = query.toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  return [...starts, ...commands.filter((c) => !starts.includes(c) && c.name.toLowerCase().includes(q))];
}

/**
 * The picker. It is open while a command name is being typed and some command matches it; Escape closes it until
 * the next keystroke or caret move asks again, as the `@` list does.
 */
export type Picker = { readonly kind: 'closed' } | { readonly kind: 'open'; readonly items: readonly CommandOption[]; readonly active: number };

export const CLOSED: Picker = { kind: 'closed' };

/** The picker after the draft or the caret changed; the active row stays on the same command while it still matches. */
export function pickerAt(previous: Picker, commands: readonly CommandOption[], text: string, caret: number): Picker {
  const query = slashAtCaret(text, caret);
  const items = query === undefined ? [] : matchCommands(commands, query);
  if (items.length === 0) return CLOSED;
  const was = previous.kind === 'open' ? previous.items[previous.active]?.name : undefined;
  return { kind: 'open', items, active: Math.max(0, items.findIndex((c) => c.name === was)) };
}

export function movePicker(picker: Picker, by: number): Picker {
  if (picker.kind === 'closed') return picker;
  const count = picker.items.length;
  return { ...picker, active: (picker.active + by + count) % count };
}

/**
 * Whether Enter on the picker sends the command as well as choosing it: only a built-in that takes no arguments,
 * such as `/new`. A skill or prompt template takes free text after its name whether or not it declares a hint.
 */
export const sendsWhenPicked = (command: CommandOption): boolean => command.hint === undefined && (command.route === 'editor' || command.route === 'engine');

/** The draft with the typed name replaced by `/name ` and the caret after it; the rest of the draft stays. */
export function insertCommand(text: string, caret: number, name: string): { readonly text: string; readonly caret: number } {
  const inserted = `/${name} `;
  const rest = text.slice(caret).replace(/^\S*/, '').replace(/^ /, '');
  return { text: inserted + rest, caret: inserted.length };
}
