/** The chapters fixture's files, prompts and answers, shared by the suites inside VS Code and the test that launches them. */
export const FILES = {
  'src/date.ts': 'export const parseDate = (s: string) => new Date(s);\n',
  'test/date.test.ts': "import { parseDate } from '../src/date';\n",
} as const;

/** The chat's first message carries it, so the fake model knows the call is the chat's own. */
export const MARKER = '[chapters]';

export const PROMPTS = {
  look: `${MARKER} Look at parseDate in src/date.ts`,
  fix: 'Fix the off-by-one in it',
  verify: 'Now check the tests',
  notes: 'Write the release notes for it',
} as const;

/** Long enough that the chat scrolls: each answer is a numbered list of many lines. */
const long = (label: string, lines: number): string => `${label}\n\n${Array.from({ length: lines }, (_, i) => `${i + 1}. ${label} detail ${i + 1}: the month index stays within 0 to 11.`).join('\n')}`;

export const ANSWERS = {
  look: long('parseDate reads the month as given.', 20),
  fix: long('The parser fix is in.', 30),
  verify: long('The tests cover it.', 30),
  notes: long('Release notes drafted.', 30),
} as const;

export const CHAPTERS = {
  fix: { toolUseId: 'tu_ch_fix', title: 'Parser fix', summary: 'Guard the month index in parseDate.' },
  verify: { toolUseId: 'tu_ch_verify', title: 'Test verification' },
} as const;

/** The chapter the user marks at the fourth message, from its menu. */
export const USER_CHAPTER = 'Release notes';
