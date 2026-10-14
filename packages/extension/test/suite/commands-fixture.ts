/** The command steps fixture's files, prompts and the fake model's calls, shared by the suite and the test that launches it. */
export const MANY_LINES = Array.from({ length: 30 }, (_, i) => `entry ${String(i + 1).padStart(2, '0')}`);

export const FILES = {
  'a.ts': 'export const a = 1;\n',
  'notes/many.txt': `${MANY_LINES.join('\n')}\n`,
  'build/out.js': 'console.log(1);\n',
} as const;

export const PROMPTS = { look: 'Look around the project', remove: 'Then delete the build folder' } as const;

/** Long enough to wrap several times in a 300px panel, so a cut-off command would show. */
export const LONG_COMMAND = `ls -lat ./a.ts ./notes ./build ./notes/many.txt ./build/out.js ./notes/../notes/many.txt ./build/../build/out.js ./a.ts ./notes/many.txt`;

type Call = { readonly narration: string; readonly name: string; readonly input: Readonly<Record<string, unknown>> };

export const LOOK: readonly Call[] = [
  { narration: 'Listing the project.', name: 'bash', input: { command: 'ls -t', description: 'List the files in the project root' } },
  { narration: 'Reading the notes.', name: 'bash', input: { command: 'cat -v notes/many.txt', description: 'Show the entries in the notes file' } },
  { narration: 'Looking at each path.', name: 'bash', input: { command: LONG_COMMAND, description: 'Show details of the source, notes and build files' } },
  { narration: 'Checking where we are.', name: 'bash', input: { command: 'pwd' } },
];

export const REMOVE: readonly Call[] = [
  { narration: 'Removing the build output.', name: 'bash', input: { command: 'rm -rf build', description: 'Delete the build output folder' } },
];

export const ANSWERS = { look: 'The project has a.ts, notes and build.', remove: 'Left build alone.' } as const;
