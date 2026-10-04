import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';

export const TOOL_NAMES = ['glob', 'grep', 'list', 'read'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export const isToolName = (raw: string): raw is ToolName => (TOOL_NAMES as readonly string[]).includes(raw);

/** What the model sees of a tool. Executors live in the engine. */
export type ToolSpec = Tool & { readonly name: ToolName };

export const TOOL_SPECS: Readonly<Record<ToolName, ToolSpec>> = {
  glob: {
    name: 'glob',
    description:
      'Find files by name. Returns matching file paths relative to the workspace root, sorted. Files ignored by .gitignore and hidden files are skipped. A pattern without a slash matches file names in any directory, like .gitignore.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob such as **/*.ts, src/**/config.*, or package.json.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  grep: {
    name: 'grep',
    description:
      'Search file contents with ripgrep. Returns path:line:text for every matching line, sorted by path. Files ignored by .gitignore and hidden files are skipped.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression in Rust regex syntax.' },
        path: {
          type: 'string',
          description: 'Optional glob limiting which files are searched, relative to the workspace root, such as src/** or **/*.ts.',
        },
        ignore_case: { type: 'boolean', description: 'Match case-insensitively. Defaults to false.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  list: {
    name: 'list',
    description:
      'List the files and directories under a directory, as paths relative to the workspace root. Directories end in a slash; one at the depth limit shows how many files it holds. Ignored and hidden files are skipped.',
    input_schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: 'Directory relative to the workspace root. Defaults to the root.' },
        depth: { type: 'integer', minimum: 1, description: 'How many levels to show. Defaults to 2.' },
      },
      additionalProperties: false,
    },
  },
  read: {
    name: 'read',
    description:
      'Read a text file. Returns its lines numbered from 1. Pass start_line and end_line (inclusive) to read part of a long file. Also reads spilled tool output by its absolute path.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root, or a spill file path.' },
        start_line: { type: 'integer', minimum: 1, description: 'First line to return, from 1.' },
        end_line: { type: 'integer', minimum: 1, description: 'Last line to return, inclusive.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
};

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
};

// Sorted and frozen: the definitions open every request's cached prefix, so their bytes must never move.
export const TOOL_DEFINITIONS: readonly ToolSpec[] = deepFreeze(
  TOOL_NAMES.toSorted().map((name) => TOOL_SPECS[name]),
);

/** Results longer than this many characters go to a spill file instead of the conversation. */
export const SPILL_THRESHOLD = 24_000;
/** How many characters of a spilled result's start and end the model still sees. */
export const SPILL_EDGE = 2_000;

export type Spill = {
  readonly path: string;
  readonly bytes: number;
  readonly head: string;
  readonly tail: string;
};

export const needsSpill = (output: string): boolean => output.length > SPILL_THRESHOLD;

export const spillEdges = (output: string): Pick<Spill, 'head' | 'tail'> => ({
  head: output.slice(0, SPILL_EDGE),
  tail: output.slice(-SPILL_EDGE),
});

export const spillNotice = ({ path, bytes, head, tail }: Spill): string =>
  [
    `[The output was ${bytes} bytes, too long to show. The full text is in ${path}; read it with start_line and end_line to see more.]`,
    `--- first ${head.length} characters ---`,
    head,
    `--- last ${tail.length} characters ---`,
    tail,
  ].join('\n');
