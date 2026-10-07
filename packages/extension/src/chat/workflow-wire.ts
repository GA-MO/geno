import type { WorkflowPreview } from '@g-code/core';
import { z } from 'zod';

const caps = z.object({ maxTurns: z.number(), maxCostUsd: z.number() });

/** A workflow's preview on the engine's permission request. The engine is Geno's own; this keeps a torn card from showing half a cost. */
export const workflowPreviewWire = z
  .object({
    name: z.string(),
    description: z.string(),
    input: z.string(),
    path: z.string(),
    rows: z.array(
      z.object({
        id: z.string(),
        kind: z.enum(['agent', 'check', 'gate']),
        label: z.string(),
        role: z.string().optional(),
        model: z.string(),
        lane: z.string().optional(),
        readOnly: z.boolean(),
        count: z.number(),
        dynamic: z.boolean(),
        caps: caps.optional(),
        estimateUsd: z.number().nullable(),
      }),
    ),
    estimateUsd: z.number().nullable(),
    worstUsd: z.number(),
    capUsd: z.number(),
    stopsBefore: z.string().optional(),
    unpriced: z.array(z.string()),
  })
  .transform((preview) => preview as WorkflowPreview);
