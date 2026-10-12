import { describe, expect, it } from 'vitest';
import { COMMAND_META } from '@g-code/core';
import { BUILTIN_OPTIONS, commandOptions, routeText } from '../src/chat/slash-route.js';
import { CLOSED, insertCommand, movePicker, pickerAt, sendsWhenPicked, slashAtCaret, type CommandOption } from '../src/chat/slash.js';

const listed = commandOptions([
  { name: 'new', description: 'Start a new chat', _meta: { [COMMAND_META]: { kind: 'builtin', runs: 'client' } } },
  { name: 'mode', description: 'Switch the approval mode', input: { hint: 'plan | ask | auto' }, _meta: { [COMMAND_META]: { kind: 'builtin', runs: 'engine' } } },
  { name: 'model', description: 'Choose the model', _meta: { [COMMAND_META]: { kind: 'builtin', runs: 'client' } } },
  { name: 'review', description: 'Review a file', input: { hint: '<file>' }, _meta: { [COMMAND_META]: { kind: 'prompt' } } },
  { name: 'add-i18n', description: 'Add a locale', _meta: { [COMMAND_META]: { kind: 'skill' } } },
  { name: 'other', description: 'Another agent’s command, unmarked' },
]);

const names = (picker: ReturnType<typeof pickerAt>) => (picker.kind === 'open' ? picker.items.map((c) => c.name) : []);

describe('the / picker', () => {
  it('reads each listed command’s route from the engine’s marking', () => {
    expect(listed.map((c) => [c.name, c.route, c.hint])).toEqual([
      ['new', 'editor', undefined],
      ['mode', 'engine', 'plan | ask | auto'],
      ['model', 'editor', undefined],
      ['review', 'prompt', '<file>'],
      ['add-i18n', 'skill', undefined],
      ['other', 'prompt', undefined],
    ]);
  });

  it('sends on pick only a built-in that takes no arguments; a skill or prompt waits for its text', () => {
    expect(listed.filter(sendsWhenPicked).map((c) => c.name)).toEqual(['new', 'model']);
  });

  it('opens only while a command name is typed at the start of the draft', () => {
    expect(slashAtCaret('/', 1)).toBe('');
    expect(slashAtCaret('/rev', 4)).toBe('rev');
    expect(slashAtCaret('/review src', 11)).toBeUndefined();
    expect(slashAtCaret('see /rev', 8)).toBeUndefined();
    expect(slashAtCaret('/review src', 3)).toBe('re');
  });

  it('lists names starting with the query before names containing it, and closes when none match', () => {
    expect(names(pickerAt(CLOSED, listed, '/mo', 3))).toEqual(['mode', 'model']);
    expect(names(pickerAt(CLOSED, listed, '/i18', 4))).toEqual(['add-i18n']);
    expect(names(pickerAt(CLOSED, listed, '/e', 2))).toEqual(['new', 'mode', 'model', 'review', 'other']);
    expect(pickerAt(CLOSED, listed, '/zzz', 4)).toEqual(CLOSED);
    expect(pickerAt(CLOSED, listed, 'hello', 5)).toEqual(CLOSED);
  });

  it('wraps the active row with the arrows and keeps it on the same command as the query narrows', () => {
    const open = pickerAt(CLOSED, listed, '/', 1);
    expect(movePicker(open, -1)).toMatchObject({ active: listed.length - 1 });
    const onModel = movePicker(pickerAt(CLOSED, listed, '/m', 2), 1);
    expect(onModel.kind === 'open' && onModel.items[onModel.active]!.name).toBe('model');
    const narrowed = pickerAt(onModel, listed, '/mod', 4);
    expect(narrowed.kind === 'open' && narrowed.items[narrowed.active]!.name).toBe('model');
  });

  it('puts the chosen name and a space in place of the typed one, keeping the rest of the draft', () => {
    expect(insertCommand('/rev', 4, 'review')).toEqual({ text: '/review ', caret: 8 });
    expect(insertCommand('/re src/app.ts', 3, 'review')).toEqual({ text: '/review src/app.ts', caret: 8 });
  });
});

describe('routing a sent / command', () => {
  it('runs the editor’s built-ins in the panel, /clear as a new chat', () => {
    expect(routeText(BUILTIN_OPTIONS, '/new')).toEqual({ kind: 'editor', action: 'new-chat', args: '' });
    expect(routeText(BUILTIN_OPTIONS, '/clear')).toEqual({ kind: 'editor', action: 'new-chat', args: '' });
    expect(routeText(BUILTIN_OPTIONS, '/history')).toEqual({ kind: 'editor', action: 'history', args: '' });
    expect(routeText(BUILTIN_OPTIONS, '/model')).toEqual({ kind: 'editor', action: 'model', args: '' });
  });

  it('opens the rules and memory panes for /rules and /memory, and sends /init to the engine', () => {
    expect(routeText(BUILTIN_OPTIONS, '/rules')).toEqual({ kind: 'editor', action: 'rules', args: '' });
    expect(routeText(BUILTIN_OPTIONS, '/memory')).toEqual({ kind: 'editor', action: 'memory', args: '' });
    expect(routeText(BUILTIN_OPTIONS, '/best-of-n 3 --vary effort Make two loud')).toEqual({ kind: 'editor', action: 'best-of-n', args: '3 --vary effort Make two loud' });
    expect(routeText(BUILTIN_OPTIONS, '/lane fix the flaky test')).toEqual({ kind: 'editor', action: 'lane', args: 'fix the flaky test' });
    expect(routeText(BUILTIN_OPTIONS, '/init')).toEqual({ kind: 'prompt', command: { name: 'init', args: '', route: 'engine' } });
  });

  it('sends engine built-ins, prompts and skills as typed, with the chip they show as', () => {
    expect(routeText(listed, '/mode auto')).toEqual({ kind: 'prompt', command: { name: 'mode', args: 'auto', route: 'engine' } });
    expect(routeText(listed, '/review src/app.ts  "error paths"')).toEqual({
      kind: 'prompt',
      command: { name: 'review', args: 'src/app.ts  "error paths"', route: 'prompt' },
    });
    expect(routeText(listed, '/add-i18n th')).toEqual({ kind: 'prompt', command: { name: 'add-i18n', args: 'th', route: 'skill' } });
  });

  it('sends text that names no listed command as an ordinary prompt', () => {
    expect(routeText(listed, '/usr/bin is missing')).toEqual({ kind: 'prompt', command: undefined });
    expect(routeText(listed, 'run /new later')).toEqual({ kind: 'prompt', command: undefined });
  });

  it('sends an editor built-in this panel has no action for to the engine', () => {
    const unknown: CommandOption[] = [{ name: 'fork', description: 'Fork the chat', hint: undefined, route: 'editor' }];
    expect(routeText(unknown, '/fork')).toEqual({ kind: 'prompt', command: { name: 'fork', args: '', route: 'editor' } });
  });
});
