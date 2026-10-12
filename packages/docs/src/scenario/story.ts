import type { BeatHead, Choices, Flow, ForkOption, Link, OptionId, Scenario, StepId, TurnEnd } from './model.js';
import type { Actor } from './schema.js';
import { walk } from './tour.js';

export const ACTORS: readonly { readonly id: Actor; readonly name: string; readonly sub: string }[] = [
  { id: 'you', name: 'คุณ', sub: 'หน้าคีย์บอร์ด' },
  { id: 'panel', name: 'Geno panel', sub: 'ใน VS Code' },
  { id: 'engine', name: 'Geno engine', sub: 'เดิน turn' },
  { id: 'model', name: 'AI model', sub: 'คิดและขอ tool' },
  { id: 'machine', name: 'เครื่องของคุณ', sub: 'shell และไฟล์' },
];
export const ACTOR_NAME: Readonly<Record<Actor, string>> = Object.fromEntries(ACTORS.map((actor) => [actor.id, actor.name])) as Record<Actor, string>;
export const actorIndex = (actor: Actor): number => ACTORS.findIndex((candidate) => candidate.id === actor);

/** Who the badge says acts: the person, the AI, or Geno's own code. */
export type Who = 'you' | 'ai' | 'geno';
export const WHO_LABEL: Readonly<Record<Who, string>> = { you: 'คุณ', ai: 'AI', geno: 'Geno' };
const whoOf = (actor: Actor): Who => (actor === 'you' ? 'you' : actor === 'model' ? 'ai' : 'geno');

export interface Beat {
  /** The step that carries the header; the beat's address in the hash. */
  readonly id: StepId;
  readonly head: BeatHead;
  readonly steps: readonly StepId[];
  /** The beat's last step; at a fork, the step that forks. */
  readonly last: StepId;
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
    return [{ id: steps[0]!, head, steps, last: steps.at(-1)!, from, to: head.to ?? scenario.steps[steps.at(-1)!]!.actor, who: whoOf(from), flow: scenario.steps[steps.at(-1)!]!.flow }];
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
  done: 'Turn จบ',
  failed: 'Turn ล้มเหลว',
  stopped: 'Turn ถูกหยุด',
  waits: 'Turn รอ',
  continues: 'Turn ทำต่อ',
  none: 'จบ',
};
const END_TONES: Readonly<Record<TurnEnd['turn'], Tone>> = { done: 'done', failed: 'stop', stopped: 'stop', waits: 'go', continues: 'go', none: 'done' };

/** How the story ends after this beat, or nothing when it goes on. */
export function endingOf(beat: Beat): Ending | undefined {
  if (beat.flow.kind === 'end') return { label: beat.head.end ?? END_LABELS[beat.flow.end.turn], tone: END_TONES[beat.flow.end.turn], end: beat.flow.end };
  if (beat.flow.kind === 'leave') return { label: beat.head.end ?? 'ไปต่อที่ทัวร์อื่น', tone: 'go', to: beat.flow.to };
  return undefined;
}

export interface Branch {
  readonly fork: StepId;
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
    return { fork, option, chosen: option.id === current, first, ending: endingOf(beats.at(-1)!)!, beats: beats.length };
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

/** A beat placed on the swim-lane canvas, one chip per option of a fork, and the walk's end. */
export type LaneItem =
  | { readonly kind: 'beat'; readonly beat: number; readonly x: number; readonly row: number; readonly w: number; readonly fork: boolean }
  | { readonly kind: 'branch'; readonly branch: Branch; readonly beat: number; readonly x: number; readonly row: number; readonly w: number }
  | { readonly kind: 'end'; readonly ending: Ending; readonly x: number; readonly row: number; readonly w: number };

export interface LaneEdge {
  readonly from: number;
  readonly to: number;
}

export interface LaneLayout {
  readonly items: readonly LaneItem[];
  readonly edges: readonly LaneEdge[];
  readonly rows: number;
  readonly width: number;
}

export const LANE = { node: 112, diamond: 68, branch: 112, end: 92, step: 60, gap: 8, trunk: 16, pad: 8 } as const;

/**
 * Places beats left to right in their actor's row. A beat moves right by at least `step` from the one before it and
 * clears whatever already sits in its row, so beats in different rows overlap in x and the walk stays compact.
 * A fork owns a column of its own right after its diamond: one chip per option, in option order, stacked around the
 * diamond's row. The walk goes on from the chosen chip.
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
  let minX: number = LANE.pad;
  beats.forEach((beat, i) => {
    const fork = beat.flow.kind === 'fork';
    const row = actorIndex(beat.from);
    const index = place({ kind: 'beat', beat: i, x: leftOf(row, minX), row, w: fork ? LANE.diamond : LANE.node, fork });
    if (previous !== undefined) edges.push({ from: previous, to: index });
    const self = items[index]!;
    previous = index;
    minX = self.x + LANE.step;
    if (!fork) return;

    const branches = branchesAt(scenario, choices, beat.last);
    rows = Math.max(rows, branches.length);
    const top = Math.min(Math.max(0, row - Math.floor((branches.length - 1) / 2)), rows - branches.length);
    const x = Math.max(...branches.map((_, k) => leftOf(top + k, self.x + self.w + LANE.trunk)));
    branches.forEach((branch, k) => {
      const chip = place({ kind: 'branch', branch, beat: i, x, row: top + k, w: LANE.branch });
      edges.push({ from: index, to: chip });
      if (branch.chosen) previous = chip;
    });
    minX = x + LANE.branch + LANE.trunk;
  });

  const last = beats.at(-1);
  const ending = last === undefined ? undefined : endingOf(last);
  if (ending !== undefined && previous !== undefined) {
    const row = actorIndex(last!.to);
    const end = place({ kind: 'end', ending, x: leftOf(row, minX), row, w: LANE.end });
    edges.push({ from: previous, to: end });
  }
  const width = Math.max(...items.map((item) => item.x + item.w)) + LANE.pad;
  return { items, edges, rows, width };
}

export interface StoryItem {
  readonly beat: Beat;
  readonly number: number;
  readonly branches?: readonly { readonly branch: Branch; readonly items: readonly StoryItem[] }[];
}

/** The whole story for print and no-JS: the default walk, and at a fork each option nested with its beats to the end. */
export function storyOutline(scenario: Scenario, choices: Choices = scenario.defaults, from = 0): StoryItem[] {
  const beats = storyBeats(scenario, choices);
  const items: StoryItem[] = [];
  for (let i = from; i < beats.length; i++) {
    const beat = beats[i]!;
    if (beat.flow.kind !== 'fork') {
      items.push({ beat, number: i + 1 });
      continue;
    }
    const branches = branchesAt(scenario, choices, beat.last).map((branch) => {
      const picked = { ...choices, [beat.last]: branch.option.id };
      return { branch, items: storyOutline(scenario, picked, storyBeats(scenario, picked).findIndex((candidate) => candidate.id === branch.first.id)) };
    });
    items.push({ beat, number: i + 1, branches });
    break;
  }
  return items;
}

