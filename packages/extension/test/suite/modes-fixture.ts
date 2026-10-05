/** The modes fixture's files, commands and classifier reasons, shared by the suite inside VS Code and the test that launches it. */
export const FILES = {
  'a.ts': 'export const a = 1;\n',
  'build/out.js': 'console.log(1);\n',
  'dist/out.js': 'console.log(2);\n',
} as const;

export const PROMPTS = { auto: 'Clean up the build output', ask: 'Remove the build folder again', plan: 'Plan how to rename a to answer' } as const;

export const PLAN = '1. Rename `a` to `answer` in a.ts.\n2. Update its callers.\n\nFiles: a.ts.\n\nRisks: other modules may import `a`.';

/** What Start building sends, as the extension words it. */
export const FOLLOW_UP = 'Go ahead with the plan.';

export const COMMANDS = {
  removeBuild: 'rm -rf build',
  script: "node -e \"require('fs').rmSync('a.ts')\"",
  removeDist: 'rm -rf dist',
  removeAgain: 'rm -rf build',
} as const;

export const REASONS = {
  allow: 'it removes build output, which the user asked to clean',
  deny: 'it deletes a.ts, which the request did not ask for',
  ask: 'dist may hold release files the user wants',
} as const;

export const THEMES = { dark: 'Default Dark Modern', light: 'Default Light Modern', 'high-contrast': 'Default High Contrast' } as const;
