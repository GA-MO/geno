import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ApprovalMode } from './approval.js';
import { ASK_USER_INPUT_SCHEMA } from './ask-user.js';
import { MEMORY_SCOPES, MEMORY_TEXT_MAX } from './memory.js';

/**
 * Tools that need a person at the editor: `remember` asks the user to approve a note, `ask_user` asks them a
 * question. Each is offered only in the modes its row allows, and only to a client that can show its card, so a run
 * with nobody to ask never sees them. They follow the built-in tools in a request, so the built-ins' cached place holds.
 */
export const USER_TOOL_NAMES = ['ask_user', 'remember'] as const;
export type UserToolName = (typeof USER_TOOL_NAMES)[number];

/**
 * The modes that offer each tool. `remember` writes a standing instruction for later sessions, so it asks in every
 * mode it is offered in, Auto included, and is never offered where nobody can answer. `ask_user` stops the turn to
 * ask, which Auto, the mode for working on its own, never does.
 */
export const USER_TOOL_MODES: Readonly<Record<UserToolName, Readonly<Record<ApprovalMode, boolean>>>> = {
  ask_user: { plan: true, ask: true, auto: false, 'non-interactive': false },
  remember: { plan: true, ask: true, auto: true, 'non-interactive': false },
};

export const USER_TOOL_SPECS: Readonly<Record<UserToolName, Tool>> = {
  ask_user: {
    name: 'ask_user',
    description:
      'Ask the user one to four questions in one card and wait for the answers, when you cannot go on without decisions only they can make. Each question is a tab with 2 to 4 options; give each option a short label and a one-sentence description, mark the one you recommend, and add a preview (a short markdown or code block) when seeing the option helps. The card always adds Other for an answer in the user\'s own words, so never list it. The user can also decline. Do not ask what you can find out by reading the code or running a command.',
    input_schema: ASK_USER_INPUT_SCHEMA as unknown as Tool['input_schema'],
  },
  remember: {
    name: 'remember',
    description: `Propose a note for Geno to remember in later sessions, such as a preference or a convention the user stated. The user sees the exact text and approves or declines it, every time. Use it only for what the user would want applied from now on, not for facts about this task. project keeps it for this workspace; global for every workspace. At most ${MEMORY_TEXT_MAX} characters.`,
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The note, written as an instruction to your future self.' },
        scope: { type: 'string', enum: [...MEMORY_SCOPES], description: 'project or global.' },
      },
      required: ['text', 'scope'],
      additionalProperties: false,
    },
  },
};

/** The user tools a run offers: those its mode allows that the client can show. Sorted, for a stable prefix. */
export const userToolDefinitions = (mode: ApprovalMode, shown: ReadonlySet<UserToolName>): readonly Tool[] =>
  USER_TOOL_NAMES.filter((name) => USER_TOOL_MODES[name][mode] && shown.has(name)).map((name) => USER_TOOL_SPECS[name]);
