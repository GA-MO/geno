import type { Choices, CodeRef, Flow, LaneColumn, Link, OptionId, OutlineItem, PartKey, Problem, Result, Scenario, ScenarioId, Step, StepId } from './model.js';
import type { SourceIndex } from './refs.js';
import { isUse, type ActingStepIn, type LaneIn, type LanesIn, type OptionIn, type Phase, type ScenarioIn, type StepIn, type Surface } from './schema.js';

/** Everything compile needs from outside, so compile itself stays pure and testable with fakes. */
export interface CompileContext {
  readonly file: string;
  readonly id: string;
  readonly href: string;
  readonly title: string;
  readonly lanes: LanesIn;
  readonly fragments: Readonly<Record<string, readonly StepIn[]>>;
  readonly source: SourceIndex;
  /** Every catalog id, linked to the page that covers it when there is one. */
  readonly catalog: Readonly<Record<string, Link>>;
}

/** An authored step after fragments are spliced in and every step has its scoped id. */
interface Node {
  readonly id: StepId;
  readonly step: ActingStepIn;
  readonly path: string;
  readonly arms: readonly Arm[];
  /** Spliced into its list by `use:`, so it is the fragment's step, not the list's own. */
  readonly spliced: boolean;
}
interface Arm {
  readonly option: OptionIn;
  readonly path: string;
  readonly nodes: readonly Node[];
}

interface Walk {
  readonly choices: Choices;
  readonly path: readonly StepId[];
}

/** Enough to list every branch of a scenario with a few forks; past this a scenario should be split. */
const MAX_WALKS = 256;

/**
 * Authored scenario -> compiled Scenario, in passes: expand fragments and name steps, link each step to exactly
 * one flow, check lanes and refs, enumerate every walk (reachability, termination), then derive phase, `via`
 * and defaults. Problems accumulate, so one run names every broken ref and link in the file.
 */
export function compileScenario(authored: ScenarioIn, ctx: CompileContext): Result<Scenario> {
  const problems: Problem[] = [];
  const problem = (path: string, message: string): void => void problems.push({ level: 'error', file: ctx.file, path, message });

  const top = expand(authored.steps, '', 'steps', false, ctx, problem);
  const nodes = new Map<StepId, Node>();
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
  if (problems.length > 0) return { ok: false, problems };

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

  const compiled: Record<string, Step> = {};
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
    },
  };
}

/** Splices fragments in and names every step. A fragment used again in the same list is scoped `name-2.`, `name-3.`. */
function expand(list: readonly StepIn[], scope: string, path: string, inFragment: boolean, ctx: CompileContext, problem: (path: string, message: string) => void): Node[] {
  const uses = new Map<string, number>();
  return list.flatMap((step, i): Node[] => {
    const at = `${path}[${i}]`;
    if (isUse(step)) {
      const fragment = ctx.fragments[step.use];
      if (inFragment) problem(at, `a fragment cannot use another fragment ("${step.use}")`);
      else if (fragment === undefined) problem(`${at}.use`, `no fragment named "${step.use}"`);
      if (inFragment || fragment === undefined) return [];
      const nth = (uses.get(step.use) ?? 0) + 1;
      uses.set(step.use, nth);
      return expand(fragment, `${scope}${step.use}${nth === 1 ? '' : `-${nth}`}.`, `${at}>${step.use}`, true, ctx, problem).map((node) => ({ ...node, spliced: true }));
    }
    const id = `${scope}${step.id ?? i + 1}` as StepId;
    const arms = (step.fork?.options ?? []).map((option, o) => ({
      option,
      path: `${at}.fork.options[${o}]`,
      nodes: expand(option.steps ?? [], `${id}.${option.id}.`, `${at}.fork.options[${o}].steps`, inFragment, ctx, problem),
    }));
    return [{ id, step, path: at, arms, spliced: false }];
  });
}

function allNodes(list: readonly Node[]): Node[] {
  return list.flatMap((node) => [node, ...node.arms.flatMap((arm) => allNodes(arm.nodes))]);
}

/** Gives every node exactly one flow. `after` is where the list continues when it runs out. */
function link(list: readonly Node[], after: StepId | undefined, ctx: CompileContext, flows: Map<StepId, Flow>, problem: (path: string, message: string) => void): OutlineItem[] {
  return list.map((node, i) => {
    const next = list[i + 1]?.id ?? after;
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

/**
 * A rejoin names a step of the list that holds the fork: its own step by id, or any step by scoped id.
 * A bare id that a spliced fragment also uses is ambiguous, so the author writes the scoped id.
 */
function rejoinOf(then: string, list: readonly Node[]): StepId | { readonly problem: string } {
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

/** Used lanes in registry order; a lane's sessions follow it in the order they first appear. */
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

function stepOf(node: Node, flow: Flow | undefined, surface: Surface, columns: readonly LaneColumn[], ctx: CompileContext, problem: (path: string, message: string) => void): Omit<Step, 'phase'> | undefined {
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
    if (typeof resolved === 'string') problem(`${path}.ref`, resolved);
    else ref = resolved;
  } else if (party === 'ai' || party === 'harness') problem(`${path}.ref`, `a ${party} step needs a code ref`);
  for (const [i, name] of (step.emits ?? []).entries()) if (!ctx.source.literalExists(name)) problem(`${path}.emits[${i}]`, `"${name}" appears nowhere in packages/{core,engine,extension}/src`);
  if (step.end?.reason !== undefined && !ctx.source.literalExists(step.end.reason)) problem(`${path}.end.reason`, `"${step.end.reason}" appears nowhere in packages/{core,engine,extension}/src`);
  if (flow === undefined) return undefined;

  const counts = part?.counts ?? lane.counts;
  return {
    id: node.id,
    lane: step.lane,
    column: columns.findIndex((column) => column.key === step.lane),
    part: (part === undefined ? lane.id : `${lane.id}.${part.id}`) as PartKey,
    party,
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

/** Every walk from the start under every combination of choices, default options first. */
function enumerate(start: StepId, flows: ReadonlyMap<StepId, Flow>, problem: (at: StepId, message: string) => void): Walk[] {
  const walks: Walk[] = [];
  const explore = (from: StepId, choices: Choices, before: readonly StepId[]): void => {
    const path = [...before];
    for (let at: StepId | undefined = from; at !== undefined; ) {
      if (walks.length >= MAX_WALKS) return;
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

function phasesOf(walks: readonly Walk[], nodes: ReadonlyMap<StepId, Node>, problem: (path: string, message: string) => void): Map<StepId, Phase> {
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

/** For each step, the choices made before it on the first walk that reaches it. */
function viaOf(walks: readonly Walk[]): Record<string, Choices> {
  const via: Record<string, Choices> = {};
  for (const walk of walks) {
    walk.path.forEach((id, i) => {
      if (via[id] !== undefined) return;
      const before = new Set<string>(walk.path.slice(0, i));
      via[id] = Object.fromEntries(Object.entries(walk.choices).filter(([fork]) => before.has(fork)));
    });
  }
  return via;
}
