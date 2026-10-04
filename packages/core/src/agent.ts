import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import { EDIT_FORMAT_SPECS } from './edit.js';
import { SYSTEM_PROMPT } from './request.js';
import { TOOL_NAMES, TOOL_SPECS } from './tools.js';
import type { EditFormat } from './types.js';

/** docs/e3-results.md: str_replace had the lowest first-try failure rate of the diff formats on Model Studio Qwen. */
export const AGENT_EDIT_FORMAT: EditFormat = 'str_replace';

export const DEFAULT_BASH_TIMEOUT_SECONDS = 120;
export const MAX_BASH_TIMEOUT_SECONDS = 600;

export const AGENT_TOOL_NAMES = ['bash', 'check', 'edit', ...TOOL_NAMES] as const;
export type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

const AGENT_ONLY_SPECS: Readonly<Record<Exclude<AgentToolName, keyof typeof TOOL_SPECS>, Tool>> = {
  bash: {
    name: 'bash',
    description: `Run a shell command with the workspace root as the working directory, and return its combined stdout and stderr and its exit code. The command runs in a sandbox: it can write only inside the workspace and a temp dir, and it has no network, so installing packages or fetching URLs fails. Commands that push, hard-reset, delete recursively, download, call cloud or database CLIs, or name paths outside the workspace need the user's approval and may be denied. Each command times out after ${DEFAULT_BASH_TIMEOUT_SECONDS} seconds unless timeout_seconds says otherwise.`,
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command, for example npx vitest run src/foo.test.ts.' },
        timeout_seconds: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_BASH_TIMEOUT_SECONDS,
          description: `Seconds before the command is killed. Defaults to ${DEFAULT_BASH_TIMEOUT_SECONDS}.`,
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  check: {
    name: 'check',
    description:
      "Run the project's check command (its type checker, linter or tests, as the user configured it) and return whether it passed and the end of its output. Takes no input.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  edit: EDIT_FORMAT_SPECS[AGENT_EDIT_FORMAT].tool,
};

const AGENT_SPECS: Readonly<Record<AgentToolName, Tool>> = { ...TOOL_SPECS, ...AGENT_ONLY_SPECS };

// Sorted and never rebuilt, for the same cache reason as TOOL_DEFINITIONS.
export const AGENT_TOOL_DEFINITIONS: readonly Tool[] = Object.freeze(AGENT_TOOL_NAMES.toSorted().map((name) => AGENT_SPECS[name]));

export const AGENT_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

You are running as an agent that changes the code itself. How to work in this mode:
- Your tools are read, grep, glob and list to look around, edit to change files, bash to run commands, and check to run the project's check command.
- Read a file before you edit it. edit refuses a file you have not read in this session, or one that changed since you last read it; read it again and retry.
- edit replaces one exact piece of text that appears once in the file. Copy old_str from what read showed you, without the line numbers and the tab after them. To make a new file, pass create: true with the whole content as new_str. Several separate changes to one file are several edit calls.
- When the project has a check command, it runs after every successful edit and its result is appended to the edit's result. If it fails because of your change, fix that before moving on. Failures that were there before your change are not yours to fix unless the task asks.
- bash runs in a sandbox with no network and writes only inside the workspace. Dependencies are already installed; do not try to install packages. If a command is denied, do not retry it; find another way or explain what you could not do.
- Before you finish, run the relevant tests or type checker with bash or check and read the result.
- Work until the task is done without stopping to ask questions; when something is ambiguous, choose the reading that best fits the codebase and say which you chose. End your turn with a short report of what you changed and how you checked it.`;
