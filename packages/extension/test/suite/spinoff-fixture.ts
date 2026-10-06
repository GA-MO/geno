import { spinoffIdOf } from '@g-code/core/spinoff';

/** The spin-off fixture's files, prompts and suggestions, shared by the suites inside VS Code and the test that launches them. */
export const FILES = {
  'src/parse.ts': 'export const parse = (s: string) => s.split(",");\n',
  'src/util.ts': '// TODO: delete formatDate; nothing imports it since the date picker moved.\nexport const formatDate = (d: Date) => d.toISOString();\n',
} as const;

/** Each conversation carries its marker in its first message, so the fake model knows whose call it answers. */
export const MARKERS = { chat: '[spinoff]', task: '[spinoff-task]' } as const;

export const PROMPT = `${MARKERS.chat} Make parse trim each field`;

export const SUGGESTIONS = {
  helper: {
    toolUseId: 'tu_helper',
    title: 'Remove the unused formatDate helper',
    tldr: 'src/util.ts has a TODO to delete formatDate, and nothing imports it any more.',
    prompt: `${MARKERS.task} Delete formatDate and its TODO from src/util.ts. First grep the repo for formatDate to confirm nothing imports it, then run the type checker.`,
  },
  test: {
    toolUseId: 'tu_test',
    title: 'Add a test for parse with empty fields',
    tldr: 'parse has no test, and an input such as "a,,b" is the case most likely to break when it changes.',
    prompt: `${MARKERS.task} Add a test for parse in src/parse.ts covering "a,,b" and a trailing comma, then run it.`,
  },
} as const;

export const IDS = { helper: spinoffIdOf(SUGGESTIONS.helper.toolUseId, []), test: spinoffIdOf(SUGGESTIONS.test.toolUseId, []) } as const;

/** The lane a started suggestion runs in: its title's first words as a slug. */
export const LANE = 'remove-the-unused-formatdate';

export const ANSWERS = { chat: 'parse trims each field now. I suggested two tasks I noticed on the way.', task: 'Removed formatDate; nothing imported it.' } as const;

export const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'high-contrast': 'Default High Contrast' } as const;
