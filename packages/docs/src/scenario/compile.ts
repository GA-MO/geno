import { partKeyOf, type BeatHead, type Choices, type CodeRef, type Flow, type LaneColumn, type Link, type OptionId, type OutlineItem, type Problem, type Result, type Scenario, type ScenarioId, type Shown, type Step, type StepId } from './model.js';
import { endProblems, type EndTables } from './ends.js';
import type { RunFiles } from './payload.js';
import type { SourceIndex } from './refs.js';
import { FACES } from './faces.js';
import { isUse, type ActingStepIn, type BeatIn, type LaneIn, type LanesIn, type OptionIn, type Phase, type ScenarioIn, type StepIn, type Surface } from './schema.js';

export interface CompileContext {
  readonly file: string;
  readonly id: string;
  readonly href: string;
  readonly title: string;
  readonly lanes: LanesIn;
  readonly fragments: Readonly<Record<string, readonly StepIn[]>>;
  readonly source: SourceIndex;
  readonly runs: RunFiles;
  readonly ends: EndTables;
  readonly catalog: Readonly<Record<string, Link>>;
}

interface ExpandedStep {
  readonly id: StepId;
  readonly step: ActingStepIn;
  readonly path: string;
  readonly arms: readonly Arm[];
  readonly spliced: boolean;
  /** The beat header this step starts, from the step itself or from the `use:` entry that spliced it in. */
  readonly beat?: { readonly head: BeatIn; readonly path: string };
}

export const TITLE_MAX = 60;
interface Arm {
  readonly option: OptionIn;
  readonly path: string;
  readonly nodes: readonly ExpandedStep[];
}

interface Walk {
  readonly choices: Choices;
  readonly path: readonly StepId[];
}

const MAX_WALKS = 256;

export function compileScenario(authored: ScenarioIn, whole: CompileContext): Result<Scenario> {
  const links = whole.lanes.links.filter((link) => link[2] === undefined || link[2].only.some((id) => authored.covers.includes(id)));
  const ctx: CompileContext = { ...whole, lanes: { ...whole.lanes, links } };
  const problems: Problem[] = [];
  const problem = (path: string, message: string): void => void problems.push({ level: 'error', file: ctx.file, path, message });

  const top = expand(authored.steps, '', 'steps', false, ctx, problem);
  const nodes = new Map<StepId, ExpandedStep>();
  for (const node of allNodes(top)) {
    if (nodes.has(node.id)) problem(`${node.path}.id`, `step id "${node.id}" is used twice`);
    else nodes.set(node.id, node);
  }

  const flows = new Map<StepId, Flow>();
  const outline = link(top, undefined, ctx, flows, problem);
  const columns = columnsOf([...nodes.values()].map((node) => node.step.lane), ctx.lanes);
  const steps = new Map<StepId, Omit<Step, 'phase'>>();
  for (const node of nodes.values()) {
    const step = stepOf(node, flows.get(node.id), authored.surface, columns, ctx, problem);
    if (step !== undefined) steps.set(node.id, step);
  }
  for (const id of authored.related) if (ctx.catalog[id] === undefined) problem('related', `"${id}" is not in the catalog`);

  const start = top[0]?.id;
  if (start === undefined || problems.length > 0) return { ok: false, problems };

  const reachable = reach(start, flows);
  for (const node of nodes.values()) if (!reachable.has(node.id)) problem(node.path, `step "${node.id}" is unreachable: no walk from the start gets here`);
  const walks = enumerate(start, flows, (id, message) => problem(nodes.get(id)?.path ?? 'steps', message));
  if (walks.length > MAX_WALKS) problem('steps', `scenario "${ctx.id}" has more than ${MAX_WALKS} walks, and walks past the ${MAX_WALKS}th go unchecked: split it into smaller scenarios`);
  if (problems.length > 0) return { ok: false, problems };

  const story = [...nodes.values()].some((node) => node.beat !== undefined);
  if (story) storyProblems(top, nodes, walks, flows, problem);
  const phases = phasesOf(walks, nodes, problem);
  const via = viaOf(walks);
  for (const node of nodes.values()) {
    const again = node.step.again;
    if (again === undefined) continue;
    const walk = walks.find((candidate) => candidate.path.includes(node.id))!;
    const target = (nodes.get(again as StepId) ?? [...nodes.values()].find((other) => other.step.id === again))?.id;
    if (target === undefined || walk.path.indexOf(target) >= walk.path.indexOf(node.id)) problem(`${node.path}.again`, `"${again}" is not an earlier step on this walk`);
  }
  if (problems.length > 0) return { ok: false, problems };

  const compiled: Record<StepId, Step> = {};
  for (const [id, step] of steps) compiled[id] = { ...step, phase: phases.get(id)! };
  return {
    ok: true,
    value: {
      id: ctx.id as ScenarioId,
      file: ctx.file,
      href: ctx.href,
      title: ctx.title,
      surface: authored.surface,
      given: authored.given,
      trigger: authored.trigger,
      covers: authored.covers.map((id) => ctx.catalog[id] ?? { id, title: id }),
      related: authored.related.map((id) => ctx.catalog[id]!),
      columns,
      start,
      steps: compiled,
      outline,
      via,
      defaults: walks[0]!.choices,
      story,
    },
  };
}

function expand(list: readonly StepIn[], scope: string, path: string, inFragment: boolean, ctx: CompileContext, problem: (path: string, message: string) => void): ExpandedStep[] {
  const uses = new Map<string, number>();
  return list.flatMap((step, i): ExpandedStep[] => {
    const at = `${path}[${i}]`;
    if (isUse(step)) {
      const fragment = ctx.fragments[step.use];
      if (inFragment) problem(at, `a fragment cannot use another fragment ("${step.use}")`);
      else if (fragment === undefined) problem(`${at}.use`, `no fragment named "${step.use}"`);
      if (inFragment || fragment === undefined) return [];
      const nth = (uses.get(step.use) ?? 0) + 1;
      uses.set(step.use, nth);
      const spliced = expand(fragment, `${scope}${step.use}${nth === 1 ? '' : `-${nth}`}.`, `${at}>${step.use}`, true, ctx, problem).map((node) => ({ ...node, spliced: true }));
      return step.beat === undefined || spliced[0] === undefined ? spliced : [{ ...spliced[0], beat: { head: step.beat, path: `${at}.beat` } }, ...spliced.slice(1)];
    }
    if (inFragment && step.beat !== undefined) problem(`${at}.beat`, 'a fragment carries no beat header: many pages share it; put the header on the page\'s `use:` entry');
    const id = `${scope}${step.id ?? i + 1}` as StepId;
    const arms = (step.fork?.options ?? []).map((option, o) => ({
      option,
      path: `${at}.fork.options[${o}]`,
      nodes: expand(option.steps ?? [], `${id}.${option.id}.`, `${at}.fork.options[${o}].steps`, inFragment, ctx, problem),
    }));
    return [{ id, step, path: at, arms, spliced: false, ...(step.beat === undefined || inFragment ? {} : { beat: { head: step.beat, path: `${at}.beat` } }) }];
  });
}

function allNodes(list: readonly ExpandedStep[]): ExpandedStep[] {
  return list.flatMap((node) => [node, ...node.arms.flatMap((arm) => allNodes(arm.nodes))]);
}

function link(list: readonly ExpandedStep[], continuesAt: StepId | undefined, ctx: CompileContext, flows: Map<StepId, Flow>, problem: (path: string, message: string) => void): OutlineItem[] {
  return list.map((node, i) => {
    const next = list[i + 1]?.id ?? continuesAt;
    const { step } = node;
    const exits = [step.fork && 'fork', step.end && 'end', step.goto && 'goto'].filter(Boolean);
    if (exits.length > 1) problem(node.path, `a step has one way out; this one has ${exits.join(' and ')}`);

    if (step.fork !== undefined) {
      const arms = node.arms.map((arm) => {
        const target = arm.option.then === undefined ? next : rejoinOf(arm.option.then, list);
        if (typeof target === 'object') problem(`${arm.path}.then`, target.problem);
        const rejoin = typeof target === 'object' ? undefined : target;
        const items = link(arm.nodes, rejoin, ctx, flows, problem);
        const to = arm.nodes[0]?.id ?? rejoin;
        if (to === undefined && typeof target !== 'object') problem(arm.path, `option "${arm.option.id}" has no steps and nothing after the fork: this path never ends`);
        const last = arm.nodes.at(-1)?.step;
        const fallsThrough = last === undefined || (last.end === undefined && last.goto === undefined && last.fork === undefined);
        return { option: arm.option, items, to, rejoins: fallsThrough ? rejoin : undefined };
      });
      flows.set(node.id, {
        kind: 'fork',
        ask: step.fork.ask,
        options: arms.flatMap(({ option, to }) => (to === undefined ? [] : [{ id: option.id as OptionId, label: option.label, to }])),
      });
      return {
        step: node.id,
        arms: arms.map(({ option, items, rejoins }) => ({ option: option.id as OptionId, label: option.label, items, ...(rejoins === undefined ? {} : { rejoins }) })),
      };
    }
    if (step.end !== undefined) flows.set(node.id, { kind: 'end', end: step.end });
    else if (step.goto !== undefined) {
      const target = ctx.catalog[step.goto];
      if (target === undefined) problem(`${node.path}.goto`, `"${step.goto}" is not in the catalog`);
      flows.set(node.id, { kind: 'leave', to: target ?? { id: step.goto, title: step.goto } });
    } else if (next !== undefined) flows.set(node.id, { kind: 'next', to: next });
    else problem(node.path, `the walk stops at "${node.id}" without end, goto or a rejoin: this path never ends`);
    return { step: node.id };
  });
}

function rejoinOf(then: string, list: readonly ExpandedStep[]): StepId | { readonly problem: string } {
  const exact = list.find((node) => node.id === then);
  if (exact !== undefined) return exact.id;
  const named = list.filter((node) => node.step.id === then);
  if (named.length === 1 && !named[0]!.spliced) return named[0]!.id;
  if (named.length === 0) return { problem: `no step "${then}" in the list that holds this fork` };
  const which = named.map((node) => `${node.id}${node.spliced ? ' (inside a fragment)' : ''}`).join(', ');
  return { problem: `"${then}" names ${named.length === 1 ? 'a step inside a fragment' : `${named.length} steps`}: ${which}; write the scoped id of the one to rejoin at` };
}

function laneOf(key: string, lanes: LanesIn): { readonly lane: LaneIn | undefined; readonly session: string | undefined } {
  const [id, session] = key.split('@') as [string, string | undefined];
  return { lane: lanes.lanes.find((lane) => lane.id === id), session };
}

function columnsOf(keys: readonly string[], lanes: LanesIn): LaneColumn[] {
  const unique = [...new Set(keys)];
  const rank = (key: string): number => lanes.lanes.findIndex((lane) => lane.id === key.split('@')[0]);
  return unique
    .filter((key) => rank(key) >= 0)
    .sort((a, b) => rank(a) - rank(b) || unique.indexOf(a) - unique.indexOf(b))
    .map((key) => {
      const { lane, session } = laneOf(key, lanes);
      const base = { key, lane: lane!.id, label: session === undefined ? lane!.label : `${lane!.label} · ${session}`, party: lane!.party, process: lane!.process };
      return session === undefined ? base : { ...base, session };
    });
}

function stepOf(node: ExpandedStep, flow: Flow | undefined, surface: Surface, columns: readonly LaneColumn[], ctx: CompileContext, problem: (path: string, message: string) => void): Omit<Step, 'phase'> | undefined {
  const { step, path } = node;
  const { lane, session } = laneOf(step.lane, ctx.lanes);
  if (lane === undefined) {
    problem(`${path}.lane`, `lane "${step.lane}" is not in lanes.yaml (${ctx.lanes.lanes.map((known) => known.id).join(', ')})`);
    return undefined;
  }
  if (session !== undefined && !lane.instanced) problem(`${path}.lane`, `lane "${lane.id}" has no sessions; write "${lane.id}"`);
  if (!lane.surfaces.includes(surface)) problem(`${path}.lane`, `lane "${lane.id}" does not exist on surface ${surface} (only ${lane.surfaces.join(', ')})`);
  const part = step.at === undefined ? undefined : lane.parts.find((candidate) => candidate.id === step.at);
  if (step.at !== undefined && part === undefined) problem(`${path}.at`, `lane "${lane.id}" has no part "${step.at}" (${lane.parts.map((known) => known.id).join(', ')})`);
  if (step.at === undefined && lane.parts.length > 0) problem(`${path}.at`, `lane "${lane.id}" has parts; say which one with at: (${lane.parts.map((known) => known.id).join(', ')})`);

  const party = part?.party ?? lane.party;
  let ref: CodeRef | undefined;
  if (step.ref !== undefined) {
    const resolved = ctx.source.resolve(step.ref);
    if (resolved.ok) ref = resolved.ref;
    else problem(`${path}.ref`, resolved.reason);
  } else if (party === 'ai' || party === 'harness') problem(`${path}.ref`, `a ${party} step needs a code ref`);
  for (const [i, name] of (step.emits ?? []).entries()) if (!ctx.source.literalExists(name)) problem(`${path}.emits[${i}]`, `"${name}" appears nowhere in packages/{core,engine,extension}/src`);
  if (step.end?.reason !== undefined && !ctx.source.literalExists(step.end.reason)) problem(`${path}.end.reason`, `"${step.end.reason}" appears nowhere in packages/{core,engine,extension}/src`);
  if (step.end !== undefined) {
    const modelStops = party === 'ai' && !lane.instanced ? (step.emits ?? []) : [];
    for (const { field, message } of endProblems(step.end, modelStops, ctx.ends)) problem(field === 'reason' ? `${path}.end` : `${path}.emits`, message);
  }
  const beat = node.beat === undefined ? undefined : beatOf(node.beat.head, node.beat.path, ctx, problem);
  if (flow === undefined) return undefined;

  const counts = part?.counts ?? lane.counts;
  return {
    id: node.id,
    lane: step.lane,
    column: columns.findIndex((column) => column.key === step.lane),
    part: partKeyOf(lane.id, part?.id),
    party,
    actor: lane.actor,
    ...(beat === undefined ? {} : { beat }),
    ...(counts === undefined ? {} : { counts }),
    ...(step.runs === undefined ? {} : { runs: step.runs }),
    does: step.do.trim(),
    ...(step.sees === undefined ? {} : { sees: step.sees.trim() }),
    emits: step.emits ?? [],
    ...(ref === undefined ? {} : { ref }),
    alongside: step.alongside ?? false,
    ...(step.again === undefined ? {} : { again: step.again as StepId }),
    flow,
  };
}

const graphemes = new Intl.Segmenter('th', { granularity: 'grapheme' });
/** What a reader counts as characters: a Thai vowel or tone mark rides on its consonant. */
export const lengthOf = (text: string): number => [...graphemes.segment(text)].length;

function beatOf(head: BeatIn, path: string, ctx: CompileContext, problem: (path: string, message: string) => void): BeatHead {
  const title = head.title.trim();
  const length = lengthOf(title);
  if (length > TITLE_MAX) problem(`${path}.title`, `"${title}" is ${length} characters; keep a beat title to ${TITLE_MAX}`);
  const listed = head.sees === undefined ? [] : typeof head.sees === 'string' ? [head.sees] : Array.isArray(head.sees) ? head.sees : [head.sees];
  const sees = listed.flatMap((mock, i): Shown[] => {
    if (typeof mock === 'string') return [{ kind: 'text', text: mock.trim() }];
    if (mock.kind === 'permission') {
      const at = `${path}.sees${Array.isArray(head.sees) ? `[${i}]` : ''}`;
      for (const need of FACES[mock.face ?? 'command'].needs) if (mock[need] === undefined) problem(`${at}.${need}`, `a ${mock.face} card's title names its ${need}: give the mock ${need}:`);
      if (mock.face === 'mcp' && mock.command !== '' && !isJson(mock.command)) problem(`${at}.command`, "an MCP card shows the call's arguments as JSON, or '' for none");
      if (mock.face !== 'mcp' && mock.command.trim() === '') problem(`${at}.command`, 'only an MCP card, whose call sends no arguments, shows no command');
    }
    if (mock.kind !== 'payload') return [mock];
    const resolved = ctx.runs.resolve(mock);
    const at = `${path}.sees${Array.isArray(head.sees) ? `[${i}]` : ''}`;
    if (!resolved.ok) problem(at, resolved.reason);
    else if (resolved.partial !== undefined) problem(`${at}.select`, resolved.partial);
    return resolved.ok ? [resolved.view] : [];
  });
  for (const end of ['from', 'to'] as const)
    if (head[end] === undefined) problem(`${path}.${end}`, `beat "${title}" has no ${end}: give every beat its arrow, who acts (from) and who receives (to)`);
  const { from, to } = head;
  if (from !== undefined && to !== undefined && from !== to && !ctx.lanes.links.some(([a, b]) => (a === from && b === to) || (a === to && b === from))) {
    const reach = ctx.lanes.links.flatMap(([a, b]) => (a === from ? [b] : b === from ? [a] : []));
    problem(`${path}.to`, `beat "${title}" draws ${from} -> ${to}, which no process link carries; ${from} hands to ${reach.join(', ')} (lanes.yaml links)`);
  }
  return {
    title,
    text: head.text.trim(),
    from: head.from ?? 'engine',
    to: head.to ?? 'engine',
    sees,
    ...(head.ask === undefined ? {} : { ask: head.ask.trim() }),
    ...(head.end === undefined ? {} : { end: head.end.trim() }),
  };
}

/** The story rules, checked along every walk: beats are derived per walk, so a rule can hold on one and fail on another. */
function storyProblems(top: readonly ExpandedStep[], nodes: ReadonlyMap<StepId, ExpandedStep>, walks: readonly Walk[], flows: ReadonlyMap<StepId, Flow>, problem: (path: string, message: string) => void): void {
  if (top[0] !== undefined && top[0].beat === undefined) problem(top[0].path, 'a page with a story starts with a beat: put a beat header on its first step or `use:` entry');
  for (const node of nodes.values()) {
    for (const arm of node.arms) {
      const first = arm.nodes[0];
      if (first !== undefined && first.beat === undefined) problem(`${arm.path}.steps[0]`, `option "${arm.option.id}" starts no beat: a fork arm opens with its own beat header`);
    }
  }
  const reported = new Set<string>();
  const once = (path: string, message: string): void => {
    if (reported.has(path + message)) return;
    reported.add(path + message);
    problem(path, message);
  };
  for (const walk of walks) {
    const chosen = Object.entries(walk.choices).map(([fork, option]) => `${fork}=${option}`).join(', ') || 'the default walk';
    const headers = walk.path.filter((id) => nodes.get(id)!.beat !== undefined);
    if (headers.length < 2) once('steps', `the walk choosing ${chosen} has ${headers.length} beat(s); a story walk has 2 or more`);
    let header: ExpandedStep | undefined;
    for (const id of walk.path) {
      const node = nodes.get(id)!;
      if (node.beat !== undefined) header = node;
      if (flows.get(id)?.kind === 'fork' && header?.beat !== undefined && header.beat.head.ask === undefined)
        once(`${header.beat.path}.ask`, `beat "${header.beat.head.title}" ends at the fork "${id}": give it ask:, the short label of the decision`);
    }
  }
}

function successors(flow: Flow | undefined): StepId[] {
  if (flow?.kind === 'next') return [flow.to];
  if (flow?.kind === 'fork') return flow.options.map((option) => option.to);
  return [];
}

function reach(start: StepId, flows: ReadonlyMap<StepId, Flow>): Set<StepId> {
  const seen = new Set<StepId>();
  const stack = [start];
  for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
    if (seen.has(at)) continue;
    seen.add(at);
    stack.push(...successors(flows.get(at)));
  }
  return seen;
}

function enumerate(start: StepId, flows: ReadonlyMap<StepId, Flow>, problem: (at: StepId, message: string) => void): Walk[] {
  const walks: Walk[] = [];
  const explore = (from: StepId, choices: Choices, before: readonly StepId[]): void => {
    const path = [...before];
    for (let at: StepId | undefined = from; at !== undefined; ) {
      if (walks.length > MAX_WALKS) return;
      if (path.includes(at)) {
        const chosen = Object.entries(choices).map(([fork, option]) => `${fork}=${option}`).join(', ');
        problem(at, `a walk never ends: ${chosen === '' ? 'the default walk' : `choosing ${chosen}`} comes back to "${at}"`);
        return;
      }
      path.push(at);
      const flow = flows.get(at);
      if (flow?.kind === 'fork') {
        for (const option of flow.options) explore(option.to, { ...choices, [at]: option.id }, path);
        return;
      }
      at = flow?.kind === 'next' ? flow.to : undefined;
    }
    walks.push({ choices, path });
  };
  explore(start, {}, []);
  return walks;
}

function phasesOf(walks: readonly Walk[], nodes: ReadonlyMap<StepId, ExpandedStep>, problem: (path: string, message: string) => void): Map<StepId, Phase> {
  const phases = new Map<StepId, Phase>();
  const reported = new Set<StepId>();
  for (const walk of walks) {
    let phase: Phase = 'idle';
    for (const id of walk.path) {
      const node = nodes.get(id)!;
      phase = node.step.phase ?? phase;
      const earlier = phases.get(id);
      if (earlier === undefined) phases.set(id, phase);
      else if (earlier !== phase && !reported.has(id)) {
        reported.add(id);
        problem(`${node.path}.phase`, `walks reach "${id}" in phase ${earlier} and in phase ${phase}; set phase: on it`);
      }
    }
  }
  return phases;
}

function viaOf(walks: readonly Walk[]): Record<StepId, Choices> {
  const via: Record<StepId, Choices> = {};
  for (const walk of walks) {
    walk.path.forEach((id, i) => {
      if (via[id] !== undefined) return;
      const before = new Set<string>(walk.path.slice(0, i));
      via[id] = Object.fromEntries(Object.entries(walk.choices).filter(([fork]) => before.has(fork)));
    });
  }
  return via;
}

const isJson = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};
