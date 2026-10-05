/// <reference lib="dom" />
import { h, icon, type Child } from './dom.js';
import { CLOSED, insertCommand, movePicker, pickerAt, type CommandOption, type CommandRoute, type Picker, type SentCommand } from './slash.js';

const ICONS: Readonly<Record<CommandRoute, string>> = { editor: 'window', engine: 'gear', prompt: 'note', skill: 'library' };

/** A sent command in the user's bubble: a chip naming it, then its arguments as typed. */
export const commandContent = ({ name, args, route }: SentCommand): Child[] => [
  h('span', { class: 'command-chip', 'data-command': name, 'data-route': route }, icon(ICONS[route]), h('span', {}, `/${name}`)),
  args !== '' && h('span', { class: 'command-args' }, args),
];

/**
 * The `/` picker over the composer, beside the `@` list and with its keys: arrows move, Enter or Tab puts the
 * command in the draft, Escape closes, and a click chooses. `edited` hears the draft after a command goes in, and
 * `wanted` fires the first time the picker opens, so the extension can have the engine list the session's commands.
 */
export function slashPicker(input: HTMLTextAreaElement, edited: () => void, wanted: () => void) {
  let commands: readonly CommandOption[] = [];
  let picker: Picker = CLOSED;
  let asked = false;
  const element = h('ul', { class: 'mentions slash-menu', id: 'commands', role: 'listbox', 'aria-label': 'Commands', hidden: true });

  function show(next: Picker): void {
    picker = next;
    const items = picker.kind === 'open' ? picker.items : [];
    const active = picker.kind === 'open' ? picker.active : -1;
    element.hidden = items.length === 0;
    element.replaceChildren(
      ...items.map((command, i) =>
        h(
          'li',
          {
            id: `command-${i}`,
            class: i === active ? 'mention command-option active' : 'mention command-option',
            role: 'option',
            'aria-selected': String(i === active),
            'data-command': command.name,
            onmousedown: (event) => event.preventDefault(),
            onclick: () => accept(i),
          },
          icon(ICONS[command.route]),
          h('span', { class: 'mention-label' }, `/${command.name}`),
          command.hint !== undefined && h('span', { class: 'command-hint' }, command.hint),
          h('span', { class: 'mention-detail' }, command.description),
        ),
      ),
    );
    if (items.length === 0) return;
    input.setAttribute('aria-controls', 'commands');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', `command-${active}`);
    element.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    if (!asked) {
      asked = true;
      wanted();
    }
  }

  function accept(index: number): void {
    const command = picker.kind === 'open' ? picker.items[index] : undefined;
    if (command === undefined) return;
    const next = insertCommand(input.value, input.selectionStart, command.name);
    close();
    input.value = next.text;
    input.focus();
    input.setSelectionRange(next.caret, next.caret);
    edited();
  }

  function close(): void {
    if (picker.kind === 'closed') return;
    show(CLOSED);
    input.setAttribute('aria-controls', 'mentions');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  const KEYS: Readonly<Record<string, () => void>> = {
    ArrowDown: () => show(movePicker(picker, 1)),
    ArrowUp: () => show(movePicker(picker, -1)),
    Enter: () => picker.kind === 'open' && accept(picker.active),
    Tab: () => picker.kind === 'open' && accept(picker.active),
    Escape: close,
  };

  /** Opens, filters or closes the picker for the draft and caret as they are now. */
  function refresh(): void {
    const next = input.selectionStart === input.selectionEnd ? pickerAt(picker, commands, input.value, input.selectionStart) : CLOSED;
    if (next.kind === 'closed') close();
    else show(next);
  }

  return {
    element,
    refresh,
    setCommands(next: readonly CommandOption[]): void {
      commands = next;
      if (picker.kind === 'open') refresh();
    },
    /** Handles a key while the picker is open; true when it did. */
    keydown(event: KeyboardEvent): boolean {
      const handle = KEYS[event.key];
      if (picker.kind === 'closed' || handle === undefined || event.isComposing) return false;
      event.preventDefault();
      event.stopPropagation();
      handle();
      return true;
    },
    close,
  };
}
