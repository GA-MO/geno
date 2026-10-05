import { z } from 'zod';
import {
  askUserResult,
  MEMORY_SCOPES,
  memoryProblem,
  USER_TOOL_MODES,
  USER_TOOL_NAMES,
  type ApprovalMode,
  type AskUserAnswer,
  type AskUserRequest,
  type RememberInput,
  type UserToolName,
} from '@g-code/core';
import type { MemoryStore } from '../memory.js';
import { executor, ToolError, type Executor } from './context.js';

/**
 * How a run reaches the person at the editor, one entry per user tool it can show. A run whose client cannot show a
 * card has no entry, and the model is never offered that tool.
 */
export type UserChannel = {
  /** Shows the exact note and resolves true only when the user approves it. */
  readonly remember?: (input: RememberInput, signal: AbortSignal) => Promise<boolean>;
  readonly ask_user?: (request: AskUserRequest, signal: AbortSignal) => Promise<AskUserAnswer>;
};

export const shownUserTools = (channel: UserChannel): ReadonlySet<UserToolName> => new Set(USER_TOOL_NAMES.filter((name) => channel[name] !== undefined));

/** Refused once the session has switched to a mode that does not offer the tool, say from Ask to Auto mid-turn. */
function inMode(name: UserToolName, mode: () => ApprovalMode, tool: Executor): Executor {
  return {
    ...tool,
    async run(raw, ctx) {
      if (!USER_TOOL_MODES[name][mode()]) throw new ToolError(`${name} is not available in ${mode()} mode. Do not retry it.`);
      return tool.run(raw, ctx);
    },
  };
}

type UserToolEnv = { readonly channel: UserChannel; readonly mode: () => ApprovalMode; readonly memory: MemoryStore; readonly sessionId: string };

const BUILD: { readonly [K in UserToolName]: (env: UserToolEnv, show: NonNullable<UserChannel[K]>) => Executor } = {
  remember: ({ memory, sessionId }, show) =>
    executor({
      input: z.strictObject({ text: z.string(), scope: z.enum(MEMORY_SCOPES) }),
      describe: ({ scope }) => `remember ${scope}`,
      async run({ text, scope }, ctx) {
        const problem = memoryProblem(text, await memory.list());
        if (problem !== undefined) throw new ToolError(problem);
        // Whatever the note says, only the user's yes keeps it: no mode, rule or classifier answers this question.
        if (!(await show({ text: text.trim(), scope }, ctx.signal))) return 'The user declined. Nothing was saved; do not propose it again unless they ask.';
        await memory.add(text, scope, sessionId);
        return `Saved to ${scope} memory. It applies from the user's next message.`;
      },
    }),
  ask_user: (_env, show) =>
    executor({
      input: z.strictObject({ question: z.string().min(1), options: z.array(z.string().min(1)).max(6).optional() }),
      describe: ({ question }) => `ask_user ${question}`,
      run: async ({ question, options = [] }, ctx) => askUserResult(await show({ question, options }, ctx.signal)),
    }),
};

/** The executors of the user tools the channel can show. */
export function userExecutors(env: UserToolEnv): Record<string, Executor> {
  const executors: Record<string, Executor> = {};
  for (const name of USER_TOOL_NAMES) {
    const show = env.channel[name];
    if (show !== undefined) executors[name] = inMode(name, env.mode, (BUILD[name] as (e: UserToolEnv, s: typeof show) => Executor)(env, show));
  }
  return executors;
}
