import { describe, expect, it } from 'vitest';
import {
  BUILTIN_COMMANDS,
  builtinCommands,
  expandInvocation,
  mergeCommands,
  parseCommandArgs,
  parseInvocation,
  renderContextItems,
  substituteArgs,
  type SlashCommand,
} from '../src/index.js';

const review: SlashCommand = {
  kind: 'prompt',
  name: 'review',
  description: 'Review a file',
  hint: '<file>',
  scope: 'workspace',
  path: '.claude/commands/review.md',
  template: 'Review $1 carefully. Focus: ${2:-everything}.',
};
const i18n: SlashCommand = {
  kind: 'skill',
  name: 'add-i18n',
  description: 'Add a locale',
  hint: undefined,
  scope: 'workspace',
  path: '.claude/skills/add-i18n/SKILL.md',
  text: '---\nname: add-i18n\ndescription: Add a locale\n---\nSteps for a new locale.',
  userInvocable: true,
};
const catalog = mergeCommands([builtinCommands(), [review, i18n]]);

describe('command arguments, ported from Pi', () => {
  it('splits on whitespace and keeps quoted runs whole', () => {
    expect(parseCommandArgs(`src/a.ts  "two words" 'single quoted' last`)).toEqual(['src/a.ts', 'two words', 'single quoted', 'last']);
    expect(parseCommandArgs('   ')).toEqual([]);
  });

  it('substitutes $1, $@, $ARGUMENTS, defaults and slices, without substituting inside the values', () => {
    const args = ['a', 'b', 'c'];
    expect(substituteArgs('$1|$2|$4|$@|$ARGUMENTS', args)).toBe('a|b||a b c|a b c');
    expect(substituteArgs('${4:-none} ${1:-x} ${@:2} ${@:2:1} ${ARGUMENTS:-empty}', args)).toBe('none a b c b a b c');
    expect(substituteArgs('${@:-empty}', [])).toBe('empty');
    expect(substituteArgs('$1', ['$ARGUMENTS'])).toBe('$ARGUMENTS');
  });
});

describe('invocations', () => {
  it('parses a leading slash name and the raw text after it', () => {
    expect(parseInvocation('/review src/app.ts  now')).toEqual({ name: 'review', args: 'src/app.ts  now' });
    expect(parseInvocation('/new')).toEqual({ name: 'new', args: '' });
    expect(parseInvocation('/mode\nauto')).toEqual({ name: 'mode', args: 'auto' });
    expect(parseInvocation('review /x')).toBeUndefined();
    expect(parseInvocation('/')).toBeUndefined();
  });

  it('expands a prompt command into the message and records its name and arguments', () => {
    expect(expandInvocation(catalog, '/review src/app.ts "error paths"')).toEqual({
      kind: 'message',
      content: 'Review src/app.ts carefully. Focus: error paths.',
      command: { name: 'review', args: 'src/app.ts "error paths"' },
      context: [],
    });
    expect(expandInvocation(catalog, '/review src/app.ts')).toMatchObject({ content: 'Review src/app.ts carefully. Focus: everything.' });
  });

  it('appends the arguments to a template with no placeholder, so typed text is never dropped', () => {
    const plain: SlashCommand = { ...review, name: 'plain', template: 'Tidy the imports.' };
    const commands = mergeCommands([[plain]]);
    expect(expandInvocation(commands, '/plain src/a.ts')).toMatchObject({ content: 'Tidy the imports.\n\nARGUMENTS: src/a.ts' });
    expect(expandInvocation(commands, '/plain')).toMatchObject({ content: 'Tidy the imports.' });
  });

  it('keeps the typed text for a skill and attaches its SKILL.md as a context item', () => {
    const expanded = expandInvocation(catalog, '/add-i18n th');
    expect(expanded).toEqual({
      kind: 'message',
      content: '/add-i18n th',
      command: { name: 'add-i18n', args: 'th' },
      context: [{ kind: 'skill', name: 'add-i18n', path: '.claude/skills/add-i18n/SKILL.md', text: i18n.kind === 'skill' ? i18n.text : '' }],
    });
    expect(renderContextItems(expanded?.kind === 'message' ? expanded.context : [])).toContain(
      '<context_item kind="skill" name="add-i18n" path=".claude/skills/add-i18n/SKILL.md">\n---\nname: add-i18n',
    );
  });

  it('returns a built-in for the caller to run, and leaves unknown names and plain text alone', () => {
    expect(expandInvocation(catalog, '/mode auto')).toEqual({ kind: 'builtin', name: 'mode', runs: 'engine', args: 'auto' });
    expect(expandInvocation(catalog, '/new')).toEqual({ kind: 'builtin', name: 'new', runs: 'client', args: '' });
    expect(expandInvocation(catalog, '/usr/bin is on PATH?')).toBeUndefined();
    expect(expandInvocation(catalog, 'review this')).toBeUndefined();
  });
});

describe('the command table', () => {
  it('holds the built-ins, each marked as a client or an engine action', () => {
    expect(Object.keys(BUILTIN_COMMANDS)).toEqual(['new', 'history', 'mode', 'model', 'clear', 'compact', 'rules', 'memory', 'init', 'best-of-n', 'schedule']);
    expect(Object.fromEntries(Object.entries(BUILTIN_COMMANDS).map(([name, spec]) => [name, spec.runs]))).toEqual({
      new: 'client',
      history: 'client',
      mode: 'engine',
      model: 'client',
      clear: 'client',
      compact: 'engine',
      rules: 'client',
      memory: 'client',
      init: 'engine',
      'best-of-n': 'client',
      schedule: 'engine',
    });
    expect(BUILTIN_COMMANDS.init.description).toBe('Create or update AGENTS.md for this project');
    expect(BUILTIN_COMMANDS.mode.hint).toBe('plan | ask | auto');
  });

  it('keeps the first command of a name, so earlier groups win', () => {
    const shadow: SlashCommand = { ...review, name: 'new', template: 'shadowed' };
    const global: SlashCommand = { ...review, scope: 'global', template: 'global review' };
    const merged = mergeCommands([builtinCommands(), [review, shadow], [global]]);
    expect(merged.filter((c) => c.name === 'new')).toEqual([expect.objectContaining({ kind: 'builtin' })]);
    expect(merged.filter((c) => c.name === 'review')).toEqual([review]);
  });
});
