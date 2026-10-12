import type { Choices, Link, OptionId, Scenario, Step, StepId, TurnEnd } from './model.js';
import type { Party, Phase } from './schema.js';

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

type Batch = 'uncounted' | 'counted';

function runsOf(step: Step, batch: Batch): { readonly runs: number; readonly batch: Batch } {
  if (step.runs !== undefined) return { runs: step.runs, batch: 'counted' };
  if (step.counts === 'tool-run' && batch === 'uncounted') return { runs: 1, batch: 'counted' };
  return { runs: 0, batch };
}

function tally(done: readonly Step[]): { readonly modelCalls: number; readonly toolRuns: number } {
  let modelCalls = 0;
  let toolRuns = 0;
  let batch: Batch = 'uncounted';
  done.forEach((step, i) => {
    const previous = done[i - 1];
    if (step.counts === 'model-call' && !(previous?.counts === 'model-call' && previous.column === step.column)) {
      modelCalls += 1;
      batch = 'uncounted';
    }
    const counted = runsOf(step, batch);
    toolRuns += counted.runs;
    batch = counted.batch;
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
