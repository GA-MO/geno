/** The skills fixture, shared by the suite inside VS Code and the test that launches it. */
export const FILES = { 'a.ts': 'export const a = 1;\n' } as const;

export const SKILL = '---\nname: deploy-notes\ndescription: Write release notes for a deploy\n---\n# Deploy notes\n\nRead references/steps.md, then write the notes.\n';
export const STEPS = 'List the merged pull requests, newest first.\n';
export const AGENT = '---\nname: reviewer\ndescription: Reviews a diff for bugs\ntools: read, grep\n---\nYou review diffs. Report bugs with file and line.\n';

export const PROMPT = 'Write the deploy notes';
