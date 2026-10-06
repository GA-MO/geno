import { z } from 'zod';
import {
  DISMISS_TASK_TOOL,
  offerOf,
  offeredText,
  parseDismissTask,
  parseSpawnTask,
  openSpinoffNamed,
  SPAWN_TASK_TOOL,
  withdrawnText,
  type Parsed,
  type Spinoff,
} from '@g-code/core';
import { executor, ToolError, type Executor } from './context.js';

/** The input, parsed by core's rules, so the model reads the same message whichever rule it broke. */
const parsedBy = <T>(parse: (raw: unknown) => Parsed<T>) =>
  z.unknown().transform((raw, ctx) => {
    const parsed = parse(raw);
    if (parsed.ok) return parsed.value;
    ctx.addIssue({ code: 'custom', message: parsed.problem });
    return z.NEVER;
  });

const valueOf = <T>(parsed: Parsed<T>): T => {
  if (!parsed.ok) throw new ToolError(parsed.problem);
  return parsed.value;
};

/**
 * spawn_task and dismiss_task. Neither starts or stops anything: the result the call logs carries the offer or the
 * withdrawal, which the panel draws and a replay folds. `spinoffs` reads the session's suggestions from its log on
 * disk, so a decision the user logged beside the running turn counts.
 */
export function spinoffExecutors(spinoffs: () => Promise<readonly Spinoff[]>): Readonly<Record<typeof SPAWN_TASK_TOOL | typeof DISMISS_TASK_TOOL, Executor>> {
  return {
    [SPAWN_TASK_TOOL]: executor({
      input: parsedBy(parseSpawnTask),
      describe: ({ title }) => `${SPAWN_TASK_TOOL} ${title}`,
      run: async (input, ctx) => {
        const offer = valueOf(offerOf(input, ctx.toolUseId ?? input.title, await spinoffs()));
        return { text: offeredText(offer), spinoff: { kind: 'offered', offer } };
      },
    }),
    [DISMISS_TASK_TOOL]: executor({
      input: parsedBy(parseDismissTask),
      describe: (id) => `${DISMISS_TASK_TOOL} ${id}`,
      run: async (id) => {
        const found = valueOf(openSpinoffNamed(await spinoffs(), id));
        return { text: withdrawnText(found), spinoff: { kind: 'withdrawn', id: found.id } };
      },
    }),
  };
}
