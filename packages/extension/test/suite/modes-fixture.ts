/** The modes fixture's files, commands and classifier reasons, shared by the suite inside VS Code and the test that launches it. */
export const FILES = {
  'a.ts': 'export const a = 1;\n',
  'build/out.js': 'console.log(1);\n',
  'dist/out.js': 'console.log(2);\n',
} as const;

export const PROMPTS = { auto: 'Clean up the build output', ask: 'Remove the build folder again' } as const;

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
