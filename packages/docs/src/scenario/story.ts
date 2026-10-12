import type { BeatHead, Choices, Flow, ForkOption, Link, OptionId, Scenario, StepId, TurnEnd } from './model.js';
import type { Actor, Surface } from './schema.js';
import { walk } from './tour.js';

export const ACTORS: readonly { readonly id: Actor; readonly name: string; readonly sub: string }[] = [
  { id: 'you', name: 'คุณ', sub: 'หน้าคีย์บอร์ด' },
  { id: 'panel', name: 'Geno panel', sub: 'ใน VS Code' },
  { id: 'engine', name: 'Geno engine', sub: 'เดิน turn' },
  { id: 'model', name: 'AI model', sub: 'คิดและขอ tool' },
  { id: 'machine', name: 'เครื่องของคุณ', sub: 'shell และไฟล์' },
];
/** Where the panel actor lives: the chat in VS Code, the terminal for the CLI, the editor that speaks ACP. */
const PANEL_SUB: Readonly<Record<Surface, string>> = { vscode: 'ใน VS Code', cli: 'ในเทอร์มินัล', 'acp-editor': 'ใน editor ของคุณ' };
/** The actors as a tour on this surface labels them. */
export const actorsOn = (surface: Surface): typeof ACTORS => ACTORS.map((actor) => (actor.id === 'panel' ? { ...actor, sub: PANEL_SUB[surface] } : actor));
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
    return [{ id: steps[0]!, head, steps, last: steps.at(-1)!, from: head.from, to: head.to, who: whoOf(head.from), flow: scenario.steps[steps.at(-1)!]!.flow }];
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

/**
 * The swim-lane canvas, in pixels. Each beat owns a column: its node sits in the `from` lane and, when the beat goes
 * from one actor to another, a receiver marker sits in the `to` lane under the node's center, joined by a message
 * arrow. A fork's diamond takes the receiver's place (beside the node when the actor decides alone), and its chips
 * stack in a column of their own. Nothing else shares a column, so an arrow inside one crosses no node, and every
 * other connector turns only in the empty gutter before its target.
 */
export const LANE = {
  height: 72,
  node: 240,
  nodeH: 56,
  receiver: 44,
  receiverH: 10,
  diamond: 68,
  diamondH: 52,
  branch: 204,
  branchH: 52,
  end: 140,
  endH: 28,
  gap: 44,
  pad: 20,
} as const;

interface Placed {
  readonly x: number;
  readonly row: number;
  readonly w: number;
  readonly h: number;
}

/** A beat's node, its receiver marker or fork diamond, one chip per fork option, and the walk's end. */
export type LaneItem =
  | (Placed & { readonly kind: 'beat' | 'receiver' | 'decision'; readonly beat: number })
  | (Placed & { readonly kind: 'branch'; readonly beat: number; readonly branch: Branch })
  | (Placed & { readonly kind: 'end'; readonly beat: number; readonly ending: Ending });

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * `message`: a beat's actor hands off to its receiver. `flow`: the walk moves on to the next beat. `branch`: a fork
 * fans out to an option. `beat` is the beat whose place (past, current, future) colors the arrow.
 */
export interface LaneEdge {
  readonly kind: 'message' | 'flow' | 'branch';
  readonly from: number;
  readonly to: number;
  readonly beat: number;
  /** An orthogonal polyline whose last point is the arrowhead's tip on the target's edge. */
  readonly points: readonly Point[];
}

export interface LaneLayout {
  readonly items: readonly LaneItem[];
  readonly edges: readonly LaneEdge[];
  readonly rows: number;
  readonly width: number;
  readonly height: number;
}

export const rowCenter = (row: number): number => row * LANE.height + LANE.height / 2;

/** Leaves `from` at its right edge and enters `to` at its left edge, turning in the gutter just before `to`. */
function across(from: Placed, to: Placed): Point[] {
  const start = { x: from.x + from.w, y: rowCenter(from.row) };
  const tip = { x: to.x, y: rowCenter(to.row) };
  if (start.y === tip.y) return [start, tip];
  const turn = to.x - Math.min(LANE.gap / 2, (to.x - start.x) / 2);
  return [start, { x: turn, y: start.y }, { x: turn, y: tip.y }, tip];
}

/** Leaves a node from its center, straight up or down its own column, onto the near edge of `to`. */
function down(from: Placed, to: Placed): Point[] {
  const x = to.x + to.w / 2;
  const below = to.row > from.row;
  return [
    { x, y: rowCenter(from.row) },
    { x, y: rowCenter(to.row) + (below ? -to.h / 2 : to.h / 2) },
  ];
}

export function layoutLanes(scenario: Scenario, choices: Choices, beats: readonly Beat[]): LaneLayout {
  const items: LaneItem[] = [];
  const edges: LaneEdge[] = [];
  let rows = ACTORS.length;
  const add = (item: LaneItem): number => items.push(item) - 1;
  const link = (kind: LaneEdge['kind'], from: number, to: number, beat: number, route: (a: Placed, b: Placed) => Point[]) => edges.push({ kind, from, to, beat, points: route(items[from]!, items[to]!) });

  let x: number = LANE.pad;
  /** The item the walk leaves from to reach the next beat. */
  let tail: number | undefined;
  beats.forEach((beat, i) => {
    const row = actorIndex(beat.from);
    const toRow = actorIndex(beat.to);
    const node = add({ kind: 'beat', beat: i, x, row, w: LANE.node, h: LANE.nodeH });
    if (tail !== undefined) link('flow', tail, node, i, across);
    tail = node;
    const center = x + LANE.node / 2;
    let right = x + LANE.node;

    if (beat.flow.kind === 'fork') {
      const alone = toRow === row;
      const dx = alone ? right + LANE.gap / 2 : center - LANE.diamond / 2;
      const diamond = add({ kind: 'decision', beat: i, x: dx, row: toRow, w: LANE.diamond, h: LANE.diamondH });
      link(alone ? 'flow' : 'message', node, diamond, i, alone ? across : down);
      right = Math.max(right, dx + LANE.diamond);
      const branches = branchesAt(scenario, choices, beat.last);
      rows = Math.max(rows, branches.length);
      const top = Math.min(Math.max(0, toRow - Math.floor((branches.length - 1) / 2)), rows - branches.length);
      const cx = right + LANE.gap;
      branches.forEach((branch, k) => {
        const chip = add({ kind: 'branch', branch, beat: i, x: cx, row: top + k, w: LANE.branch, h: LANE.branchH });
        link('branch', diamond, chip, i, across);
        if (branch.chosen) tail = chip;
      });
      right = cx + LANE.branch;
    } else if (toRow !== row) {
      const receiver = add({ kind: 'receiver', beat: i, x: center - LANE.receiver / 2, row: toRow, w: LANE.receiver, h: LANE.receiverH });
      link('message', node, receiver, i, down);
      tail = receiver;
    }
    x = right + LANE.gap;
  });

  const last = beats.at(-1);
  const ending = last === undefined ? undefined : endingOf(last);
  if (ending !== undefined && tail !== undefined) {
    const end = add({ kind: 'end', ending, beat: beats.length - 1, x, row: actorIndex(last!.to), w: LANE.end, h: LANE.endH });
    link('flow', tail, end, beats.length - 1, across);
  }
  const width = Math.max(...items.map((item) => item.x + item.w)) + LANE.pad;
  return { items, edges, rows, width, height: rows * LANE.height };
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

