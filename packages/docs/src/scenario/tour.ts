import type { Choices, Link, OptionId, Scenario, Step, StepId, TurnEnd } from './model.js';
import type { Party, Phase } from './schema.js';

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
  | { readonly type: 'tick' };

export function walk(scenario: Scenario, choices: Choices): StepId[] {
  const path: StepId[] = [];
  for (let at: StepId | undefined = scenario.start; at !== undefined && !path.includes(at); ) {
    path.push(at);
    const flow: Step['flow'] = scenario.steps[at]!.flow;
    if (flow.kind === 'next') at = flow.to;
    else if (flow.kind === 'fork') {
      const chosen: OptionId | undefined = choices[at] ?? scenario.defaults[at];
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
  readonly turn: { readonly kind: 'running' } | { readonly kind: 'end'; readonly end: TurnEnd } | { readonly kind: 'leave'; readonly to: Link };
  readonly position: { readonly at: number; readonly of: number };
  readonly modelCalls: number;
  readonly toolRuns: number;
  readonly ai: readonly Moment[];
  readonly harness: readonly Moment[];
  readonly user: readonly Moment[];
}

export function briefOf(does: string): string {
  const flat = does.replace(/\s+/g, ' ').trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length > 110 ? `${sentence.slice(0, 108)}…` : sentence;
}

function tally(done: readonly Step[]): { readonly modelCalls: number; readonly toolRuns: number } {
  let modelCalls = 0;
  let toolRuns = 0;
  let batchCounted = false;
  done.forEach((step, i) => {
    const previous = done[i - 1];
    if (step.counts === 'model-call' && !(previous?.counts === 'model-call' && previous.column === step.column)) {
      modelCalls += 1;
      batchCounted = false;
    }
    const runs = step.runs ?? (step.counts === 'tool-run' && !batchCounted ? 1 : 0);
    if (step.runs !== undefined || runs > 0) batchCounted = true;
    toolRuns += runs;
  });
  return { modelCalls, toolRuns };
}

export function progressAt(scenario: Scenario, path: readonly StepId[], index: number): Progress {
  const done = path.slice(0, index + 1).map((id) => scenario.steps[id]!);
  const step = done.at(-1)!;
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
    ...tally(done),
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
  readonly crossing: boolean;
}
export interface Grid {
  readonly cells: readonly Cell[];
  readonly edges: readonly Edge[];
  readonly columns: number;
  readonly rows: number;
}

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

export function hashOf(scenario: Scenario, state: TourState): string {
  const at = walk(scenario, state.choices)[state.index]!;
  const implied = { ...scenario.defaults, ...scenario.via[at] };
  const extra = Object.entries(state.choices).filter(([fork, option]) => implied[fork] !== option);
  return `#at=${at}${extra.length === 0 ? '' : `&c=${extra.map(([fork, option]) => `${fork}:${option}`).join(',')}`}`;
}

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
