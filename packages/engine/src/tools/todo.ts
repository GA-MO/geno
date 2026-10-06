import { z } from 'zod';
import { parseTodo, TODO_TOOL, todoLine, todoResult } from '@g-code/core';
import { executor, type Executor } from './context.js';

/** The input, parsed by core's rules, so the model reads the same message whichever rule it broke. */
const todoInput = z.unknown().transform((raw, ctx) => {
  const parsed = parseTodo(raw);
  if (parsed.ok) return parsed.value;
  ctx.addIssue({ code: 'custom', message: parsed.problem });
  return z.NEVER;
});

/** Sets the whole list; the result the call logs carries it, which is all the panel and a replay read. */
export const todo: Executor = executor({
  input: todoInput,
  concurrent: () => true,
  describe: (list) => `${TODO_TOOL} ${todoLine(list)}`,
  run: async (list) => ({ text: todoResult(list), todo: list }),
});
