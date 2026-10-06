/** The compaction fixture's workspace, prompts and replies, shared by the suite inside VS Code and the test that launches it. */

/** The chat's first message carries it, so the fake model knows the call is the chat's own. */
export const MARKER = '[compact]';

const lines = (label: string, chars: number): string => {
  const line = `${label}: step ok, 41 tests passed, cache warm, nothing to report on this line\n`;
  return line.repeat(Math.ceil(chars / line.length)).slice(0, chars);
};

/** Big enough files that the context really holds what the fake model's usage reports. */
export const FILES = {
  'a.ts': 'export const alpha = 1;\n',
  'build.log': lines('build', 2_900_000),
  'logs/1.txt': lines('one', 17_000),
  'logs/2.txt': lines('two', 17_000),
  'logs/3.txt': lines('three', 17_000),
  'logs/4.txt': lines('four', 17_000),
  'logs/5.txt': lines('five', 17_000),
} as const;

export const BIG_LOGS = ['logs/1.txt', 'logs/2.txt', 'logs/3.txt', 'logs/4.txt', 'logs/5.txt'] as const;

/** Auto compaction starts here, so the later turns compact on their own with small usage. */
export const COMPACT_AT = 40_000;

export const PROMPTS = {
  first: `${MARKER} Read the attached build log and a.ts`,
  logs: 'Read the five logs',
  next: 'Now sum up the logs',
} as const;

export const ANSWERS = { first: 'The build log is clean.', logs: 'The five logs are clean too.', next: 'All five logs passed.' } as const;

/** What the fake model writes when Geno asks for a summary. */
export const SUMMARIES = {
  manual: '## Goal\nCheck the build.\n\n## Progress\nRead build.log and a.ts; the build is clean.\n\n## Decisions\nNone yet.\n\n## Next steps\nWait for the next request.',
  auto: '## Goal\nCheck the build and the logs.\n\n## Progress\nRead the five logs; all passed.\n\n## Decisions\nNone.\n\n## Next steps\nSum up the logs.',
} as const;

export const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'high-contrast': 'Default High Contrast' } as const;
