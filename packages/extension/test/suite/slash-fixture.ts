/** The slash fixture's files and prompts, shared by the suite inside VS Code and the test that launches it. */
export const REVIEW = '---\ndescription: Review a file for bugs\nargument-hint: <file>\n---\nReview $1 for ${2:-bugs}.\n';

export const SKILL = '---\nname: add-i18n\ndescription: Add a locale to the site\nargument-hint: <locale>\n---\nCopy messages/en.json to the new locale.\n';

export const FILES = {
  'a.ts': 'export const a = 1;\n',
  '.claude/commands/review.md': REVIEW,
  '.claude/skills/add-i18n/SKILL.md': SKILL,
} as const;

/** What each command turn sends, as typed in the composer. */
export const SENT = { review: '/review a.ts', skill: '/add-i18n th', mode: '/mode plan' } as const;

/** What the review template expands to, which the model gets and the bubble never shows. */
export const EXPANDED = 'Review a.ts for bugs.';

export const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'high-contrast': 'Default High Contrast' } as const;
