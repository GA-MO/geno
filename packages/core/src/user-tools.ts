import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { ApprovalMode } from './approval.js';
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
      'Ask the user a question and wait for the answer, when you cannot go on without a decision only they can make. Offer the likely answers as options; the user can also answer in their own words, or decline. Do not ask what you can find out by reading the code or running a command.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, in one or two plain sentences.' },
        options: { type: 'array', items: { type: 'string' }, maxItems: 6, description: 'Short answers the user can pick with one click.' },
      },
      required: ['question'],
      additionalProperties: false,
    },
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

export type AskUserRequest = { readonly question: string; readonly options: readonly string[] };

/** The user's reply to `ask_user`: an answer, or a refusal to answer. */
export type AskUserAnswer = { readonly kind: 'answered'; readonly text: string } | { readonly kind: 'declined' };

/**
 * The form an `ask_user` question becomes in ACP's `elicitation/create`: a pick among the options when there are
 * any, and a free-text answer. The client sends back one of them.
 */
export const ASK_USER_FIELDS = { choice: 'choice', answer: 'answer' } as const;

export const askUserSchema = ({ options }: AskUserRequest) => ({
  type: 'object' as const,
  properties: {
    ...(options.length === 0 ? {} : { [ASK_USER_FIELDS.choice]: { type: 'string' as const, title: 'Pick an answer', oneOf: options.map((option) => ({ const: option, title: option })) } }),
    [ASK_USER_FIELDS.answer]: { type: 'string' as const, title: 'Or answer in your own words' },
  },
});

/** What the user's reply tells the model. */
export const askUserResult = (answer: AskUserAnswer): string =>
  answer.kind === 'answered' ? `The user answered: ${answer.text}` : 'The user declined to answer. Go on with your best judgment and say what you assumed.';
