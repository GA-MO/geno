import type { Counts, EndIn, Party, Phase, Surface } from './schema.js';

type Brand<T, B extends string> = T & { readonly __brand: B };
export type ScenarioId = Brand<string, 'ScenarioId'>;
export type StepId = Brand<string, 'StepId'>;
export type OptionId = Brand<string, 'OptionId'>;
export type PartKey = Brand<string, 'PartKey'>;

export const partKeyOf = (lane: string, part?: string): PartKey => (part === undefined ? lane : `${lane}.${part}`) as PartKey;

export type TurnEnd = EndIn;

export interface CodeRef {
  readonly path: string;
  readonly anchor: string;
  readonly line: number;
  readonly url: string;
}

export interface LaneColumn {
  readonly key: string;
  readonly lane: string;
  readonly label: string;
  readonly party: Party;
  readonly process: string;
  readonly session?: string;
}

export type Flow =
  | { readonly kind: 'next'; readonly to: StepId }
  | { readonly kind: 'fork'; readonly ask: string; readonly options: readonly ForkOption[] }
  | { readonly kind: 'end'; readonly end: TurnEnd }
  | { readonly kind: 'leave'; readonly to: Link };

export interface ForkOption {
  readonly id: OptionId;
  readonly label: string;
  readonly to: StepId;
}

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
  readonly party: Party;
  readonly counts?: Counts;
  readonly runs?: number;
  readonly does: string;
  readonly sees?: string;
  readonly emits: readonly string[];
  readonly ref?: CodeRef;
  readonly phase: Phase;
  readonly alongside: boolean;
  readonly again?: StepId;
  readonly flow: Flow;
}

export interface OutlineItem {
  readonly step: StepId;
  readonly arms?: readonly { readonly option: OptionId; readonly label: string; readonly items: readonly OutlineItem[]; readonly rejoins?: StepId }[];
}

export type Choices = Readonly<Record<StepId, OptionId>>;

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
  readonly steps: Readonly<Record<StepId, Step>>;
  readonly outline: readonly OutlineItem[];
  readonly via: Readonly<Record<StepId, Choices>>;
  readonly defaults: Choices;
}

export interface Problem {
  readonly level: 'error' | 'warning';
  readonly file: string;
  readonly path: string;
  readonly message: string;
}

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problems: readonly Problem[] };
