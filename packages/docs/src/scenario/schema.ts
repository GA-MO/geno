import { z } from 'astro/zod';

/**
 * What an author types: a scenario page's `scenario:` frontmatter, a fragment file, lanes.yaml and catalog.yaml.
 * This is the boundary. compile.ts turns these into the domain types in model.ts, and nothing past it re-checks shape.
 */

export const PARTIES = ['user', 'ai', 'harness', 'outside'] as const;
export const SURFACES = ['vscode', 'cli', 'acp-editor'] as const;
/** What a step in a lane adds to the progress counters. Lanes and parts carry it, so no component names a lane. */
export const COUNTS = ['model-call', 'tool-run'] as const;

export const PHASES = [
  'idle', // no turn is running
  'starting', // the server took the prompt and is opening the run
  'calling-model', // a model request is being built, sent or streamed
  'running-tools', // a batch runs, including the policy checks before each call
  'waiting-user', // a permission card or ask_user question is open
  'waiting-retry', // gateway backoff, offline or rate-limit wait
  'compacting',
  'held', // the turn waits for a background child's report
  'ending', // the loop said done; Stop hook, usage, task end
] as const;

export const TURN_ENDS = [
  'done', // the task ends done; `reason` names the loop's DoneReason (end_turn, ...)
  'failed',
  'stopped', // the user or the engine stopped it
  'waits', // parked on something outside the turn (a held child, a paused wake)
  'continues', // the scenario stops here but the turn goes on
  'none', // the scenario has no turn (an API key, Tab)
] as const;

const id = z.string().regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and hyphens');
const stepRef = z.string().regex(/^[a-z0-9][a-z0-9.-]*$/, 'a step id, scoped ids allowed');
/** A catalog id such as `turn.text-answer`. */
const catalogId = z.string().regex(/^[a-z]+\.[a-z0-9-]+$/, 'a catalog id such as turn.text-answer');
/** `lane` or `lane@session`: the session gives a child its own column (`child@explore`). */
const laneKey = z.string().regex(/^[a-z][a-z-]*(@[a-z0-9][a-z0-9-]*)?$/, 'a lane id, or lane@session');
/**
 * `path#Symbol`, `path#Class.member` or `path#"exact text"`. Never a line number: the build derives lines,
 * so code moving inside a file keeps every ref valid, and a rename fails `docs:check`.
 */
const codeRef = z.string().regex(/^packages\/[^#\s]+#(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*|".+")$/, 'path#symbol or path#"literal"');

export type Party = (typeof PARTIES)[number];
export type Surface = (typeof SURFACES)[number];
export type Counts = (typeof COUNTS)[number];
export type Phase = (typeof PHASES)[number];

const endIn = z.object({ turn: z.enum(TURN_ENDS), reason: z.string().optional() }).strict();
export type EndIn = z.infer<typeof endIn>;

export interface ActingStepIn {
  readonly id?: string | undefined;
  readonly lane: string;
  /** A part of the lane (lanes.yaml); required on lanes that have parts, so every step sits on the system map. */
  readonly at?: string | undefined;
  /** Thai: what this actor does. The first sentence is what the progress lists show. */
  readonly do: string;
  /** What the user sees on screen at this step, quoted UI copy where it exists. */
  readonly sees?: string | undefined;
  /** Event, message or status names this step produces; each must appear as text in packages/. */
  readonly emits?: readonly string[] | undefined;
  readonly ref?: string | undefined;
  /** The turn phase from this step on, until another step sets it. */
  readonly phase?: Phase | undefined;
  /** Draw in the same row as the previous step: two actors at once. */
  readonly alongside?: boolean | undefined;
  /**
   * Tool calls this step runs. Default: one at the first tool-run step after a model call. Say it where that is wrong:
   * a step that stands for several calls, a second batch, or a call the tool refuses before doing its work (`runs: 0`).
   */
  readonly runs?: number | undefined;
  /** A drawn loop-back to an earlier step that the walk does not follow. */
  readonly again?: string | undefined;
  /** Leave for another scenario, by catalog id. */
  readonly goto?: string | undefined;
  readonly end?: EndIn | undefined;
  readonly fork?: ForkIn | undefined;
}
export interface UseStepIn {
  readonly use: string;
}
export type StepIn = ActingStepIn | UseStepIn;
export interface ForkIn {
  /** Thai: the question the decider answers. */
  readonly ask: string;
  readonly options: readonly OptionIn[];
}
export interface OptionIn {
  readonly id: string;
  readonly label: string;
  /** An id in the list that holds the fork, to rejoin after the arm. Absent: the step after the fork. */
  readonly then?: string | undefined;
  readonly steps?: readonly StepIn[] | undefined;
}

export const isUse = (step: StepIn): step is UseStepIn => 'use' in step;

const optionSchema: z.ZodType<OptionIn> = z.lazy(() =>
  z.object({ id, label: z.string().min(1), then: stepRef.optional(), steps: z.array(stepSchema).optional() }).strict(),
);

const actingSchema: z.ZodType<ActingStepIn> = z.lazy(() =>
  z
    .object({
      id: id.optional(),
      lane: laneKey,
      at: id.optional(),
      do: z.string().min(1),
      sees: z.string().optional(),
      emits: z.array(z.string().min(1)).optional(),
      ref: codeRef.optional(),
      phase: z.enum(PHASES).optional(),
      alongside: z.boolean().optional(),
      runs: z.number().int().min(0).optional(),
      again: stepRef.optional(),
      goto: catalogId.optional(),
      end: endIn.optional(),
      fork: z.object({ ask: z.string().min(1), options: z.array(optionSchema).min(2) }).strict().optional(),
    })
    .strict(),
);

export const stepSchema: z.ZodType<StepIn> = z.lazy(() => z.union([z.object({ use: id }).strict(), actingSchema]));

export const scenarioSchema = z
  .object({
    surface: z.enum(SURFACES),
    /** Thai: what is true before the trigger. */
    given: z.array(z.string()).default([]),
    trigger: z.string().min(1),
    /** Catalog ids this page answers; each id belongs to at most one page. */
    covers: z.array(catalogId).min(1),
    /** Catalog ids worth reading next. */
    related: z.array(catalogId).default([]),
    steps: z.array(stepSchema).min(1),
  })
  .strict();
export type ScenarioIn = z.infer<typeof scenarioSchema>;

export const fragmentSchema = z.array(stepSchema).min(1);

const partSchema = z
  .object({
    id,
    label: z.string(),
    about: z.string().optional(),
    ref: codeRef,
    /** Overrides the lane's party: a child's model calls are the AI's move, its loop is the harness's. */
    party: z.enum(PARTIES).optional(),
    counts: z.enum(COUNTS).optional(),
  })
  .strict();

export const lanesSchema = z
  .object({
    processes: z.array(z.object({ id, label: z.string() }).strict()).min(1),
    lanes: z
      .array(
        z
          .object({
            id,
            label: z.string(),
            english: z.string(),
            about: z.string(),
            party: z.enum(PARTIES),
            process: id,
            surfaces: z.array(z.enum(SURFACES)).min(1),
            instanced: z.boolean().default(false),
            counts: z.enum(COUNTS).optional(),
            parts: z.array(partSchema).default([]),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type LanesIn = z.infer<typeof lanesSchema>;
export type LaneIn = LanesIn['lanes'][number];

export const PRIORITIES = ['P1', 'P2', 'P3'] as const;
export const catalogSchema = z
  .object({
    chapters: z.array(z.object({ number: z.number().int(), prefix: z.string(), thai: z.string(), english: z.string() }).strict()),
    scenarios: z.array(
      z
        .object({
          id: catalogId,
          thai: z.string(),
          english: z.string(),
          chapter: z.number().int(),
          priority: z.enum(PRIORITIES),
          lanes: z.array(z.string()),
          terminal: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type CatalogIn = z.infer<typeof catalogSchema>;
export type CatalogRow = CatalogIn['scenarios'][number];
