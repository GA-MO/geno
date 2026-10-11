import type { Choices, Link, OptionId, Scenario, Step, StepId, TurnEnd } from './model.js';
import type { Party, Phase } from './schema.js';

/**
 * The player as pure functions over a compiled scenario. The island and the static fallback both use them.
 * Nothing here is stored: the diagram, the progress panel, the narration and the URL hash all derive from TourState.
 */

export interface TourState {
  readonly choices: Choices;
  readonly index: number;
  readonly playing: boolean;
}

export type TourAction =
  | { readonly type: 'next' }
  | { readonly type: 'back' }
  | { readonly type: 'first' }
  | { readonly type: 'last' }
  | { readonly type: 'jump'; readonly step: StepId }
  | { readonly type: 'choose'; readonly fork: StepId; readonly option: OptionId }
  | { readonly type: 'play' }
  | { readonly type: 'pause' }
  /** The play timer: steps on, and stops at a fork or the end. */
  | { readonly type: 'tick' };

/** The path from the start under `choices` (defaults where a fork is not chosen), to an end or a goto. */
export function walk(scenario: Scenario, choices: Choices): StepId[] {
  const path: StepId[] = [];
  for (let at: StepId | undefined = scenario.start; at !== undefined && !path.includes(at); ) {
    path.push(at);
    const flow: Step['flow'] = scenario.steps[at]!.flow;
    if (flow.kind === 'next') at = flow.to;
    else if (flow.kind === 'fork') {
      const chosen = choices[at] ?? scenario.defaults[at];
      at = flow.options.find((option) => option.id === chosen)?.to ?? flow.options[0]?.to;
    } else at = undefined;
  }
  return path;
}

export const initialState = (scenario: Scenario): TourState => ({ choices: scenario.defaults, index: 0, playing: false });

const clamp = (index: number, length: number): number => Math.max(0, Math.min(index, length - 1));

export function reduce(scenario: Scenario, state: TourState, action: TourAction): TourState {
  const path = walk(scenario, state.choices);
  switch (action.type) {
    case 'next':
      return { ...state, index: clamp(state.index + 1, path.length) };
    case 'back':
      return { ...state, index: clamp(state.index - 1, path.length), playing: false };
    case 'first':
      return { ...state, index: 0, playing: false };
    case 'last':
      return { ...state, index: path.length - 1, playing: false };
    case 'jump': {
      if (path.includes(action.step)) return { ...state, index: path.indexOf(action.step), playing: false };
      const via = scenario.via[action.step];
      if (via === undefined) return state;
      const choices = { ...state.choices, ...via };
      return { choices, index: walk(scenario, choices).indexOf(action.step), playing: false };
    }
    case 'choose': {
      const choices = { ...state.choices, [action.fork]: action.option };
      const index = walk(scenario, choices).indexOf(action.fork);
      return { choices, index: index === -1 ? state.index : index, playing: state.playing };
    }
    case 'play':
      return { ...state, playing: true, index: state.index >= path.length - 1 ? 0 : state.index };
    case 'pause':
      return { ...state, playing: false };
    case 'tick': {
      if (!state.playing) return state;
      const index = clamp(state.index + 1, path.length);
      const stops = index === path.length - 1 || scenario.steps[path[index]!]!.flow.kind === 'fork';
      return { ...state, index, playing: !stops };
    }
  }
}

export interface Moment {
  readonly step: StepId;
  readonly lane: string;
  readonly text: string;
}

export interface Progress {
  readonly step: Step;
  readonly whoseMove: Party;
  readonly phase: Phase;
  /** Where the turn stands once this step is done: still running, ended, or handed to another scenario. */
  readonly turn: { readonly kind: 'running' } | { readonly kind: 'end'; readonly end: TurnEnd } | { readonly kind: 'leave'; readonly to: Link };
  readonly position: { readonly at: number; readonly of: number };
  readonly modelCalls: number;
  readonly toolRuns: number;
  readonly ai: readonly Moment[];
  readonly harness: readonly Moment[];
  readonly user: readonly Moment[];
}

/** The first sentence of a step's text, for the running lists. */
export function briefOf(does: string): string {
  const flat = does.replace(/\s+/g, ' ').trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length > 110 ? `${sentence.slice(0, 108)}…` : sentence;
}

/** A fold over the walk up to `index`. A counter rises when a run of its steps begins. */
export function progressAt(scenario: Scenario, path: readonly StepId[], index: number): Progress {
  const done = path.slice(0, index + 1).map((id) => scenario.steps[id]!);
  const step = done.at(-1)!;
  const runsOf = (counts: Step['counts']): number => done.filter((current, i) => current.counts === counts && done[i - 1]?.counts !== counts).length;
  const momentsOf = (party: Party): Moment[] => done.filter((current) => current.party === party).map((current) => ({ step: current.id, lane: current.lane, text: briefOf(current.does) }));
  const last = index === path.length - 1;
  const turn: Progress['turn'] =
    last && step.flow.kind === 'end' ? { kind: 'end', end: step.flow.end } : last && step.flow.kind === 'leave' ? { kind: 'leave', to: step.flow.to } : { kind: 'running' };
  return {
    step,
    whoseMove: step.party,
    phase: step.phase,
    turn,
    position: { at: index + 1, of: path.length },
    modelCalls: runsOf('model-call'),
    toolRuns: runsOf('tool-run'),
    ai: momentsOf('ai'),
    harness: momentsOf('harness'),
    user: momentsOf('user'),
  };
}

export interface Cell {
  readonly step: StepId;
  readonly column: number;
  readonly row: number;
}
export interface Edge {
  readonly from: StepId;
  readonly to: StepId;
  readonly kind: 'next' | 'again';
  /** The two lanes live in different processes: an ACP message, a postMessage, an HTTPS call. */
  readonly crossing: boolean;
}
export interface Grid {
  readonly cells: readonly Cell[];
  readonly edges: readonly Edge[];
  readonly columns: number;
  readonly rows: number;
}

/** Column = the step's lane, row = its place on the walk (an `alongside` step shares the row before it). */
export function layoutWalk(scenario: Scenario, path: readonly StepId[]): Grid {
  let row = -1;
  const cells = path.map((id, i) => {
    const step = scenario.steps[id]!;
    if (!step.alongside || i === 0) row += 1;
    return { step: id, column: step.column, row };
  });
  const processOf = (id: StepId): string => scenario.columns[scenario.steps[id]!.column]!.process;
  const edges: Edge[] = path.slice(1).map((to, i) => ({ from: path[i]!, to, kind: 'next', crossing: processOf(path[i]!) !== processOf(to) }));
  for (const id of path) {
    const again = scenario.steps[id]!.again;
    if (again !== undefined && path.includes(again)) edges.push({ from: id, to: again, kind: 'again', crossing: false });
  }
  return { cells, edges, columns: scenario.columns.length, rows: row + 1 };
}

/** `#at=<step>`, plus `&c=<fork>:<option>,…` for choices the step's own `via` does not imply. */
export function hashOf(scenario: Scenario, state: TourState): string {
  const at = walk(scenario, state.choices)[state.index]!;
  const implied = { ...scenario.defaults, ...scenario.via[at] };
  const extra = Object.entries(state.choices).filter(([fork, option]) => implied[fork] !== option);
  return `#at=${at}${extra.length === 0 ? '' : `&c=${extra.map(([fork, option]) => `${fork}:${option}`).join(',')}`}`;
}

/** Unknown steps or options fall back to the start; a bad link never throws. */
export function stateFromHash(scenario: Scenario, hash: string): TourState {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const at = params.get('at') ?? '';
  const extra = Object.fromEntries(
    (params.get('c') ?? '')
      .split(',')
      .map((pair) => pair.split(':') as [string, string])
      .filter(([fork, option]) => {
        const flow = scenario.steps[fork]?.flow;
        return flow?.kind === 'fork' && flow.options.some((candidate) => candidate.id === option);
      }),
  ) as Choices;
  const choices = { ...scenario.defaults, ...extra, ...scenario.via[at] };
  const index = walk(scenario, choices).indexOf(at as StepId);
  return index === -1 ? initialState(scenario) : { choices, index, playing: false };
}
