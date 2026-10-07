import type { SchedulesResponse } from '@g-code/core';
import { z } from 'zod';

/** The engine's `_gcode/schedulesUpdate`. The engine is Geno's own; this keeps a torn message from reaching the pane as tasks. */
export const schedulesUpdate = z
  .object({
    workspace: z.string(),
    tasks: z.array(
      z.looseObject({
        id: z.string(),
        title: z.string(),
        when: z.looseObject({ kind: z.enum(['cron', 'at']) }),
        edits: z.boolean(),
        budget: z.object({ maxCostUsd: z.number(), maxTurns: z.number() }),
        paused: z.boolean(),
        runs: z.array(z.looseObject({ kind: z.enum(['ran', 'missed', 'not-started']) })),
        nextAt: z.number().nullable(),
      }),
    ),
  })
  .transform((update) => update as unknown as SchedulesResponse);
