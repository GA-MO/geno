import type { Counts, EndIn, Party, Phase, Surface } from './schema.js';

/**
 * Compiled scenarios. Only compile.ts builds these; tour.ts and the components read them and trust them.
 * Plain records and arrays, because a compiled scenario crosses into the browser island as JSON props.
 */

type Brand<T, B extends string> = T & { readonly __brand: B };
/** The page's basename, unique across the site. */
export type ScenarioId = Brand<string, 'ScenarioId'>;
/** Unique within a scenario after fragments and fork arms are expanded: `choice.reject.3`. */
export type StepId = Brand<string, 'StepId'>;
export type OptionId = Brand<string, 'OptionId'>;
/** A system-map node: `loop.settle`, or the lane id for a lane without parts (`model`). */
export type PartKey = Brand<string, 'PartKey'>;

export type TurnEnd = EndIn;

/** A code ref after resolution. `line` is derived from the anchor at build time, never authored. */
export interface CodeRef {
  readonly path: string;
  readonly anchor: string;
  readonly line: number;
  /** `vscode://file/<repo>/<path>:<line>`: opens the line in the reader's editor. */
  readonly url: string;
}

/** One swimlane column. Only lanes the scenario uses appear, in registry order, sessions after their lane. */
export interface LaneColumn {
  /** `child` or `child@explore`. */
  readonly key: string;
  readonly lane: string;
  readonly label: string;
  readonly party: Party;
  readonly process: string;
  readonly session?: string;
}

/** How a step hands on. Exactly one, so a step that both forks and ends cannot be built. */
export type Flow =
  | { readonly kind: 'next'; readonly to: StepId }
  | { readonly kind: 'fork'; readonly ask: string; readonly options: readonly ForkOption[] }
  | { readonly kind: 'end'; readonly end: TurnEnd }
  | { readonly kind: 'leave'; readonly to: Link };

export interface ForkOption {
  readonly id: OptionId;
  readonly label: string;
  /** The first step of the arm, or where the walk rejoins when the arm has no steps. */
  readonly to: StepId;
}

/** A catalog scenario, linked when a page covers it. */
export interface Link {
  readonly id: string;
  readonly title: string;
  readonly href?: string;
}

export interface Step {
  readonly id: StepId;
  readonly lane: string;
  readonly column: number;
  readonly part: PartKey;
  /** From the lane or its part, never authored: "whose move" cannot be written wrong. */
  readonly party: Party;
  readonly counts?: Counts;
  readonly does: string;
  readonly sees?: string;
  readonly emits: readonly string[];
  /** Present on every step whose party is `ai` or `harness`. */
  readonly ref?: CodeRef;
  /** The phase from this step on; every walk through the step agrees on it. */
  readonly phase: Phase;
  readonly alongside: boolean;
  readonly again?: StepId;
  readonly flow: Flow;
}

/** The authored tree after expansion, for the static list: each fork nests its arms once. */
export interface OutlineItem {
  readonly step: StepId;
  readonly arms?: readonly { readonly option: OptionId; readonly label: string; readonly items: readonly OutlineItem[]; readonly rejoins?: StepId }[];
}

/** Fork step -> chosen option. A reader's position is (choices, index into the walk they give). */
export type Choices = Readonly<Record<string, OptionId>>;

export interface Scenario {
  readonly id: ScenarioId;
  readonly file: string;
  readonly href: string;
  readonly title: string;
  readonly surface: Surface;
  readonly given: readonly string[];
  readonly trigger: string;
  readonly covers: readonly Link[];
  readonly related: readonly Link[];
  readonly columns: readonly LaneColumn[];
  readonly start: StepId;
  readonly steps: Readonly<Record<string, Step>>;
  readonly outline: readonly OutlineItem[];
  /** The fork choices that lead to each step, so a deep link or a map jump selects the right branch. */
  readonly via: Readonly<Record<string, Choices>>;
  /** The first option of every fork: what play and the static diagram follow. */
  readonly defaults: Choices;
}

/** A finding from compile or the site load. `path` is a field path into the authored data: `steps[4].ref`. */
export interface Problem {
  readonly level: 'error' | 'warning';
  readonly file: string;
  readonly path: string;
  readonly message: string;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problems: readonly Problem[] };
