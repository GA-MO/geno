import type { BeatHead, Choices, Flow, ForkOption, Link, OptionId, Scenario, StepId, TurnEnd } from './model.js';
import type { Actor } from './schema.js';
import { walk } from './tour.js';

export const ACTORS: readonly { readonly id: Actor; readonly name: string; readonly sub: string }[] = [
  { id: 'you', name: 'You', sub: 'at the keyboard' },
  { id: 'panel', name: 'Geno panel', sub: 'in VS Code' },
  { id: 'engine', name: 'Geno engine', sub: 'runs the turn' },
  { id: 'model', name: 'AI model', sub: 'thinks and asks' },
  { id: 'machine', name: 'Your machine', sub: 'shell and files' },
];
export const ACTOR_NAME: Readonly<Record<Actor, string>> = Object.fromEntries(ACTORS.map((actor) => [actor.id, actor.name])) as Record<Actor, string>;
export const actorIndex = (actor: Actor): number => ACTORS.findIndex((candidate) => candidate.id === actor);

/** Who the badge says acts: the person, the AI, or Geno's own code. */
export type Who = 'you' | 'ai' | 'geno';
export const WHO_LABEL: Readonly<Record<Who, string>> = { you: 'You', ai: 'AI', geno: 'Geno' };
const whoOf = (actor: Actor): Who => (actor === 'you' ? 'you' : actor === 'model' ? 'ai' : 'geno');

export interface Beat {
  /** The step that carries the header; the beat's address in the hash. */
  readonly id: StepId;
  readonly head: BeatHead;
  readonly steps: readonly StepId[];
  readonly from: Actor;
  readonly to: Actor;
  readonly who: Who;
  /** The flow of the beat's last step: where the story goes after it. */
  readonly flow: Flow;
}

/** Splits a walk at its beat headers. A step with no header belongs to the latest header before it on this walk. */
export function beatsOf(scenario: Scenario, path: readonly StepId[]): Beat[] {
  const groups: StepId[][] = [];
  for (const id of path) {
    if (scenario.steps[id]!.beat !== undefined || groups.length === 0) groups.push([id]);
    else groups.at(-1)!.push(id);
  }
  return groups.flatMap((steps): Beat[] => {
    const head = scenario.steps[steps[0]!]!.beat;
    if (head === undefined) return [];
    const from = head.from ?? scenario.steps[steps[0]!]!.actor;
    return [{ id: steps[0]!, head, steps, from, to: head.to ?? scenario.steps[steps.at(-1)!]!.actor, who: whoOf(from), flow: scenario.steps[steps.at(-1)!]!.flow }];
  });
}

export type Tone = 'done' | 'stop' | 'go';
export interface Ending {
  readonly label: string;
  readonly tone: Tone;
  readonly end?: TurnEnd;
  readonly to?: Link;
}

const END_LABELS: Readonly<Record<TurnEnd['turn'], string>> = {
  done: 'Turn done',
  failed: 'Turn failed',
  stopped: 'Stopped',
  waits: 'Turn waits',
  continues: 'Turn continues',
  none: 'Done',
};
const END_TONES: Readonly<Record<TurnEnd['turn'], Tone>> = { done: 'done', failed: 'stop', stopped: 'stop', waits: 'go', continues: 'go', none: 'done' };

/** How the story ends after this beat, or nothing when it goes on. */
export function endingOf(beat: Beat): Ending | undefined {
  if (beat.flow.kind === 'end') return { label: beat.head.end ?? END_LABELS[beat.flow.end.turn], tone: END_TONES[beat.flow.end.turn], end: beat.flow.end };
  if (beat.flow.kind === 'leave') return { label: beat.head.end ?? 'Continues in another tour', tone: 'go', to: beat.flow.to };
  return undefined;
}

export interface Branch {
  readonly option: ForkOption;
  readonly chosen: boolean;
  /** The beat the option opens. */
  readonly first: Beat;
  /** Where its walk ends, with every later fork at its current choice. */
  readonly ending: Ending;
  readonly beats: number;
}

const chosenAt = (scenario: Scenario, choices: Choices, fork: StepId): OptionId | undefined => {
  const flow = scenario.steps[fork]!.flow;
  if (flow.kind !== 'fork') return undefined;
  const picked = choices[fork] ?? scenario.defaults[fork];
  return flow.options.find((option) => option.id === picked)?.id ?? flow.options[0]?.id;
};

export function branchesAt(scenario: Scenario, choices: Choices, fork: StepId): Branch[] {
  const flow = scenario.steps[fork]!.flow;
  if (flow.kind !== 'fork') return [];
  const current = chosenAt(scenario, choices, fork);
  return flow.options.map((option) => {
    const beats = beatsOf(scenario, walk(scenario, { ...choices, [fork]: option.id }));
    const first = beats.find((beat) => beat.steps.includes(option.to))!;
    return { option, chosen: option.id === current, first, ending: endingOf(beats.at(-1)!)!, beats: beats.length };
  });
}

export interface StoryState {
  readonly choices: Choices;
  /** Index of the current beat on the walk the choices pick. */
  readonly at: number;
}

export const storyStart = (scenario: Scenario): StoryState => ({ choices: scenario.defaults, at: 0 });

export const storyBeats = (scenario: Scenario, choices: Choices): Beat[] => beatsOf(scenario, walk(scenario, choices));

export function choose(scenario: Scenario, state: StoryState, fork: StepId, option: OptionId): StoryState {
  const choices = { ...state.choices, [fork]: option };
  const target = scenario.steps[fork]!.flow;
  const to = target.kind === 'fork' ? target.options.find((candidate) => candidate.id === option)?.to : undefined;
  const beats = storyBeats(scenario, choices);
  const at = beats.findIndex((beat) => to !== undefined && beat.steps.includes(to));
  return { choices, at: at === -1 ? state.at : at };
}

/** `#at=<header step>`, plus `&c=fork:option` for choices the beat itself does not imply. */
export function storyHash(scenario: Scenario, state: StoryState): string {
  const beat = storyBeats(scenario, state.choices)[state.at]!;
  const implied = { ...scenario.defaults, ...scenario.via[beat.id] };
  const extra = (Object.entries(state.choices) as [StepId, OptionId][]).filter(([fork, option]) => implied[fork] !== option);
  return `#at=${beat.id}${extra.length === 0 ? '' : `&c=${extra.map(([fork, option]) => `${fork}:${option}`).join(',')}`}`;
}

/** Reads a story hash, or any step link: `#at=<step>` lands on the beat that holds the step. */
export function storyFromHash(scenario: Scenario, hash: string): StoryState {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const at = (params.get('at') ?? '') as StepId;
  const extra = Object.fromEntries(
    (params.get('c') ?? '')
      .split(',')
      .map((pair) => pair.split(':') as [StepId, OptionId])
      .filter(([fork, option]) => {
        const flow = scenario.steps[fork]?.flow;
        return flow?.kind === 'fork' && flow.options.some((candidate) => candidate.id === option);
      }),
  ) as Choices;
  const choices = { ...scenario.defaults, ...extra, ...scenario.via[at] };
  const index = storyBeats(scenario, choices).findIndex((beat) => beat.steps.includes(at));
  return index === -1 ? storyStart(scenario) : { choices, at: index };
}

/** A beat placed on the swim-lane canvas, a fork's other branches, and the walk's end. */
export type LaneItem =
  | { readonly kind: 'beat'; readonly beat: number; readonly x: number; readonly row: number; readonly w: number; readonly fork: boolean }
  | { readonly kind: 'stub'; readonly branch: Branch; readonly fork: StepId; readonly x: number; readonly row: number; readonly w: number }
  | { readonly kind: 'end'; readonly ending: Ending; readonly x: number; readonly row: number; readonly w: number };

export interface LaneEdge {
  readonly from: number;
  readonly to: number;
  /** Paths from a diamond leave at their own x, so no two branches share a segment. */
  readonly lane: number;
}

export interface LaneLayout {
  readonly items: readonly LaneItem[];
  readonly edges: readonly LaneEdge[];
  readonly rows: number;
  readonly width: number;
}

export const LANE = { node: 128, diamond: 84, stub: 120, end: 116, step: 86, gap: 12, branch: 9, pad: 14 } as const;

/**
 * Places beats left to right in their actor's row. A beat moves right by at least `step` from the one before it and
 * clears whatever already sits in its row, so beats in different rows overlap in x and the walk stays compact.
 * A fork's other options sit in the column after its diamond, each in its own free row.
 */
export function layoutLanes(scenario: Scenario, choices: Choices, beats: readonly Beat[]): LaneLayout {
  const items: LaneItem[] = [];
  const edges: LaneEdge[] = [];
  const rowEnd = new Map<number, number>();
  let rows = ACTORS.length;
  const place = (item: LaneItem): number => {
    items.push(item);
    rowEnd.set(item.row, item.x + item.w);
    return items.length - 1;
  };
  const leftOf = (row: number, after: number): number => Math.max(after, (rowEnd.get(row) ?? -Infinity) + LANE.gap);

  let previous: number | undefined;
  let lane = 0;
  let minX: number = LANE.pad;
  beats.forEach((beat, i) => {
    const fork = beat.flow.kind === 'fork';
    const row = actorIndex(beat.from);
    const w = fork ? LANE.diamond : LANE.node;
    const index = place({ kind: 'beat', beat: i, x: leftOf(row, minX), row, w, fork });
    if (previous !== undefined) edges.push({ from: previous, to: index, lane });
    lane = 0;
    const self = items[index]!;
    previous = index;
    minX = self.x + LANE.step;
    if (!fork) return;

    const branches = branchesAt(scenario, choices, beat.id);
    const next = beats[i + 1];
    const taken = new Set<number>(next === undefined ? [] : [actorIndex(next.from)]);
    const column = self.x + self.w / 2 + LANE.branch * branches.length + 2 * LANE.gap;
    minX = column;
    branches.forEach((branch, k) => {
      if (branch.chosen) return;
      const natural = actorIndex(branch.first.from);
      const free = [...Array(rows).keys()].filter((candidate) => !taken.has(candidate)).sort((a, b) => Math.abs(a - natural) - Math.abs(b - natural) || a - b)[0] ?? rows++;
      taken.add(free);
      const stub = place({ kind: 'stub', branch, fork: beat.id, x: leftOf(free, column), row: free, w: LANE.stub });
      edges.push({ from: index, to: stub, lane: k + 1 });
    });
    lane = branches.findIndex((branch) => branch.chosen) + 1;
  });

  const last = beats.at(-1);
  const ending = last === undefined ? undefined : endingOf(last);
  if (ending !== undefined && previous !== undefined) {
    const row = actorIndex(last!.to);
    const end = place({ kind: 'end', ending, x: leftOf(row, minX), row, w: LANE.end });
    edges.push({ from: previous, to: end, lane });
  }
  const width = Math.max(...items.map((item) => item.x + item.w)) + LANE.pad;
  return { items, edges, rows, width };
}

