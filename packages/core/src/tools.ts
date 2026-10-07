import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';

/** The most lines one read returns. */
export const PAGE_MAX_LINES = 2000;

/**
 * The most characters of numbered text one read returns. Pi pages at 50 KB; here a page must stay under every model's
 * `spillChars`, or the page itself would be spilled, with room left for a notice and a rule.
 */
export const PAGE_MAX_CHARS = 20_000;

const formatCount = (n: number): string => n.toLocaleString('en-US');

export const TOOL_NAMES = ['glob', 'grep', 'list', 'read'] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export const isToolName = (raw: string): raw is ToolName => (TOOL_NAMES as readonly string[]).includes(raw);

/** What the model sees of a tool. Executors live in the engine. */
export type ToolSpec = Tool & { readonly name: ToolName };

export const TOOL_SPECS: Readonly<Record<ToolName, ToolSpec>> = {
  glob: {
    name: 'glob',
    description:
      'Find files by name. Returns matching file paths relative to the workspace root, sorted. Files ignored by .gitignore, the .git directory and symlinks are skipped; other hidden files are included. A pattern without a slash matches file names in any directory, like .gitignore.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob such as **/*.ts, src/**/config.*, or package.json.' },
        directory: {
          type: 'string',
          description: "Directory to search instead of the workspace root: relative to it, or the absolute path of a skill's folder. Paths outside the workspace come back absolute.",
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  grep: {
    name: 'grep',
    description:
      'Search file contents with ripgrep. Returns path:line:text for every matching line, sorted by path. Files ignored by .gitignore, the .git directory and symlinks are skipped; other hidden files are included.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression in Rust regex syntax.' },
        path: {
          type: 'string',
          description:
            "File or directory to search, such as src/lib or src/app.ts: relative to the workspace root, or an absolute path in a skill's folder. Defaults to the workspace root. Paths outside the workspace come back absolute.",
        },
        glob: { type: 'string', description: 'Glob limiting which files are searched, relative to the directory searched, such as *.ts or src/**/*.tsx.' },
        ignore_case: { type: 'boolean', description: 'Match case-insensitively. Defaults to false.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  list: {
    name: 'list',
    description:
      'List the files and directories under a directory, as paths relative to the workspace root. Directories end in a slash; one at the depth limit shows how many files it holds. Files ignored by .gitignore, the .git directory and symlinks are skipped; other hidden files are included.',
    input_schema: {
      type: 'object',
      properties: {
        directory: { type: 'string', description: "Directory relative to the workspace root, or the absolute path of a skill's folder. Defaults to the root." },
        depth: { type: 'integer', minimum: 1, description: 'How many levels to show. Defaults to 2.' },
      },
      additionalProperties: false,
    },
  },
  read: {
    name: 'read',
    description:
      `Read a text file, or look at an image: a PNG, JPEG, GIF or WebP file comes back as the image itself. Returns a text file's lines numbered from 1. One read returns at most ${formatCount(PAGE_MAX_LINES)} lines or ${formatCount(PAGE_MAX_CHARS)} characters; a longer file comes back a page at a time, ending with the start_line that continues it. Pass start_line and end_line (inclusive) to read part of a file. A PDF returns the text of each page under a page marker, 10 pages unless pages asks for others (at most 20 per read); a page with no text layer, such as a scan, comes back as an image. A Jupyter notebook (.ipynb) returns each cell's type, source and outputs, with image outputs as images; pass start_line to read its raw JSON instead. Also reads spilled tool output and the files in a skill's folder by their absolute paths. After a successful edit the file is current, so do not read it again just to see the change.`,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: "File path relative to the workspace root, or the absolute path of a spill file or a file in a skill's folder." },
        start_line: { type: 'integer', minimum: 1, description: 'First line to return, from 1.' },
        end_line: { type: 'integer', minimum: 1, description: 'Last line to return, inclusive.' },
        pages: { type: 'string', description: 'PDF pages to return, such as "3" or "1-5", from 1. At most 20. Defaults to the first 10.' },
        cells: { type: 'string', description: 'Notebook cells to return, such as "3" or "4-9", from 1. Defaults to every cell.' },
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

/** How many characters of a spilled result's start and end the model still sees. */
export const SPILL_EDGE = 2_000;

export type Spill = {
  readonly path: string;
  readonly bytes: number;
  readonly head: string;
  readonly tail: string;
};

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

/** The last line of a bash result. */
export const commandStatusLine = (code: number | null, killedAfterSeconds: number | undefined): string =>
  killedAfterSeconds === undefined ? `[exit code ${code ?? 'killed'}]` : `[killed after ${killedAfterSeconds} seconds]`;

/** The shortest foreground wait bash refuses when other commands follow it. */
const MIN_BLOCKED_SLEEP_SECONDS = 2;

const SLEEP_UNITS: Readonly<Record<string, number>> = { '': 1, s: 1, m: 60, h: 3600, d: 86_400 };
const LEADING_SLEEP = /^\s*sleep\s+(\d+(?:\.\d+)?)([smhd]?)\s*(?:;|&&|\n)\s*(\S[\s\S]*)$/;

/** A command that waits `seconds` before it does `rest`, for a wait long enough to refuse; undefined for any other. */
export function leadingSleep(command: string): { readonly seconds: number; readonly rest: string } | undefined {
  const match = LEADING_SLEEP.exec(command);
  if (match === null) return undefined;
  const seconds = Number(match[1]) * SLEEP_UNITS[match[2]!]!;
  return seconds < MIN_BLOCKED_SLEEP_SECONDS ? undefined : { seconds, rest: match[3]!.trim() };
}

/** Claude Code's refusal of a leading foreground sleep, pointing to Geno's tools for waiting. */
export const sleepRefusal = ({ seconds, rest }: { readonly seconds: number; readonly rest: string }): string =>
  `Blocked: sleep ${seconds} followed by: ${rest}. To wait for a condition, use monitor with a command such as \`until <check>; do sleep 2; done; echo ready\` and the pattern ready, then end your turn. To wait for a command you started, run it with run_in_background: true; Geno starts your next turn when it ends. Do not chain shorter sleeps to work around this block.`;

/** Appended to a bash result whose command changed directory: the next command starts at the workspace root again. */
export const cwdResetLine = (workspace: string): string => `Shell cwd was reset to ${workspace}`;

/** The first line of a failed bash result, so the failure is the first thing the model reads; undefined for a clean exit. */
export const commandFailureLine = (code: number | null, killedAfterSeconds: number | undefined): string | undefined =>
  killedAfterSeconds !== undefined ? `Killed after ${killedAfterSeconds} seconds` : code === 0 ? undefined : `Exit code ${code ?? 'killed'}`;

/** The first line of a check run, alone or after an edit's own line. */
export const checkHeadline = (command: string, code: number | null, timedOut: boolean): string =>
  `check \`${command}\` ${timedOut ? 'timed out' : code === 0 ? 'passed' : `failed (exit ${code ?? 'killed'})`}`;

const FAILED_COMMAND = /\[(?:exit code (?!0\])[^\]]+|killed after \d+ seconds)\]\s*$/;
const FAILED_CHECK = /^check `.*` (?:failed \(exit [^)]+\)|timed out)$/m;

/** Whether a tool's text reports a failed command or check, by the lines above. */
export const reportsFailure = (text: string): boolean => FAILED_COMMAND.test(text) || FAILED_CHECK.test(text);
