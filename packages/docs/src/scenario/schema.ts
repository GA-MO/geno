import { z } from 'astro/zod';
import { PERMISSION_FACES } from './faces.js';

const PARTIES = ['user', 'ai', 'harness', 'outside'] as const;
export const ACTORS = ['you', 'panel', 'engine', 'model', 'machine'] as const;
const SURFACES = ['vscode', 'cli', 'acp-editor'] as const;
const COUNTS = ['model-call', 'tool-run'] as const;

const PHASES = ['idle', 'starting', 'calling-model', 'running-tools', 'waiting-user', 'waiting-retry', 'compacting', 'held', 'ending'] as const;

export const TURN_ENDS = ['done', 'failed', 'stopped', 'waits', 'continues', 'none'] as const;

const id = z.string().regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and hyphens');
const stepRef = z.string().regex(/^[a-z0-9][a-z0-9.-]*$/, 'a step id, scoped ids allowed');
const catalogId = z.string().regex(/^[a-z]+\.[a-z0-9-]+$/, 'a catalog id such as turn.text-answer');
/** `lane` or `lane@session`: the session gives a child its own column (`child@explore`). */
const laneKey = z.string().regex(/^[a-z][a-z-]*(@[a-z0-9][a-z0-9-]*)?$/, 'a lane id, or lane@session');
/**
 * `path#Symbol`, `path#Class.member` or `path#"exact text"`. Never a line number: the build derives lines,
 * so code moving inside a file keeps every ref valid, and a rename fails `docs:check`.
 */
const codeRef = z.string().regex(/^packages\/[^#\s]+#(?:[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*|".+")$/, 'path#symbol or path#"literal"');

export type Party = (typeof PARTIES)[number];
export type Actor = (typeof ACTORS)[number];
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
  /** Starts a story beat: this step and the ones after it on a walk, until the next header. */
  readonly beat?: BeatIn | undefined;
}
export interface UseStepIn {
  readonly use: string;
  /** Starts a story beat at the fragment's first step. */
  readonly beat?: BeatIn | undefined;
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

const text = z.string().min(1);
const segment = String.raw`(?:[A-Za-z_$][\w$-]*|\[-?\d+\])`;
const jsonPath = z.string().regex(new RegExp(String.raw`^${segment}(?:\.?${segment})*$`), 'a JSON path such as messages[-1].content[0]');
/**
 * A record in a recorded run: `docs/results/real-usecases/runs/<case>/<n>/<file>.jsonl[.gz]#seq=<n>` for the record
 * with that `seq`, or `#line=<n>` for the record on that line, counting from 1. A flow that `pnpm docs:record` ran on
 * the real engine with a scripted model is `packages/docs/src/data/recorded/<flow>.jsonl#line=<n>`.
 */
const runSource = z
  .string()
  .regex(
    /^(?:docs\/results\/real-usecases\/runs\/[^#\s]+\.jsonl(?:\.gz)?#(?:seq|line)=\d+|packages\/docs\/src\/data\/recorded\/[\w-]+\.jsonl#line=\d+)$/,
    'docs/results/real-usecases/runs/<case>/<n>/<file>.jsonl[.gz]#seq=<n> or #line=<n>, or packages/docs/src/data/recorded/<flow>.jsonl#line=<n>',
  );

/** Real wire data from a recorded run, on a beat or on any page's `payloads`. */
export const payloadSpecSchema = z
  .object({
    source: runSource,
    /** A path into the record; the whole record when absent. The card's label comes from what the path reaches. */
    select: jsonPath.optional(),
    highlight: z.array(jsonPath).optional(),
    collapse: z.array(jsonPath).optional(),
    /** Text to mark in a string of the card; a long string keeps the stretch around it. */
    quote: z.string().min(1).optional(),
  })
  .strict();
export type PayloadSpec = z.infer<typeof payloadSpecSchema>;

/** A page's named payloads, which its `<Payload>` elements show. */
export const pagePayloadsSchema = z.record(z.string().regex(/^[a-z][A-Za-z0-9]*$/, 'a name such as firstUsage'), payloadSpecSchema);

/** What the user sees at a beat: a small copy of the real UI, in its English copy. */
export const mockSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('permission'),
      /** Which card: its title and default buttons (faces.ts). Default: command. */
      face: z.enum(PERMISSION_FACES).optional(),
      /** The command, path, URL, tool input, note or workflow the card shows. */
      command: text,
      host: text.optional(),
      server: text.optional(),
      tool: text.optional(),
      /** A memory card's note: where Geno keeps it. Default: project. */
      scope: z.enum(['project', 'global']).optional(),
      reason: text.optional(),
      rule: text.optional(),
      options: z.array(text).min(1).optional(),
      chosen: text.optional(),
      note: text.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('question'), question: text, options: z.array(text).min(1), chosen: text.optional() }).strict(),
  z.object({ kind: z.literal('notice'), text, detail: text.optional(), actions: z.array(text).optional(), tone: z.enum(['info', 'warning', 'error']).optional() }).strict(),
  z.object({ kind: z.literal('step'), label: text, status: z.enum(['running', 'done', 'failed', 'denied']), note: text.optional(), output: text.optional() }).strict(),
  z.object({ kind: z.literal('message'), from: z.enum(['you', 'geno']), text, streaming: z.boolean().optional(), footer: z.array(text).optional() }).strict(),
  z.object({ kind: z.literal('toast'), text, actions: z.array(text).optional() }).strict(),
  z.object({ kind: z.literal('composer'), state: z.enum(['idle', 'working']), text: text.optional(), header: text.optional() }).strict(),
  z.object({ kind: z.literal('task'), title: text, status: z.enum(['running', 'needs-input', 'done', 'failed']), detail: text.optional(), actions: z.array(text).optional() }).strict(),
  payloadSpecSchema.extend({ kind: z.literal('payload') }),
]);
export type MockIn = z.infer<typeof mockSchema>;

const beatSchema = z
  .object({
    /** English, a sentence with the actor as subject. */
    title: text,
    /** Thai, one to three sentences for a newcomer; no function names. */
    text,
    from: z.enum(ACTORS).optional(),
    to: z.enum(ACTORS).optional(),
    sees: z.union([text, mockSchema, z.array(mockSchema).min(1)]).optional(),
    /** English: the decision diamond's label, when the beat ends at a fork. */
    ask: text.optional(),
    /** English: the end node's label, when a walk ends in this beat. */
    end: text.optional(),
  })
  .strict();
export type BeatIn = z.infer<typeof beatSchema>;

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
      beat: beatSchema.optional(),
    })
    .strict(),
);

const stepSchema: z.ZodType<StepIn> = z.lazy(() => z.union([z.object({ use: id, beat: beatSchema.optional() }).strict(), actingSchema]));

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

/**
 * A page's frontmatter. Strict, so a key left over from Starlight (`sidebar`, `tableOfContents`, `template`, `hero`)
 * fails the build and docs:check: meta.json orders the sidebar, and `full` is Fumadocs' wide page without a table of
 * contents, which every tour page already is.
 */
export const pageSchema = z
  .object({
    title: z.string(),
    description: z.string().optional(),
    full: z.boolean().optional(),
    scenario: scenarioSchema.optional(),
    payloads: pagePayloadsSchema.optional(),
  })
  .strict();

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
            actor: z.enum(ACTORS),
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
