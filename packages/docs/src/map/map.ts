import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { CodeRef, Scenario } from '../scenario/model.js';
import type { Party } from '../scenario/schema.js';
import type { Site, Visit } from '../scenario/site.js';

/**
 * The system map, derived: nodes are the lanes' parts (a lane without parts is one node), edges are the moves
 * between parts that any scenario makes. Nobody draws map edges, so the map cannot disagree with the scenarios.
 * elkjs lays it out once at build; the browser gets positions only.
 */

export interface MapNode {
  readonly key: string;
  readonly label: string;
  readonly lane: string;
  readonly laneLabel: string;
  readonly party: Party;
  readonly process: string;
  readonly about?: string;
  readonly ref?: CodeRef;
  readonly visits: readonly Visit[];
}
export interface MapEdge {
  readonly from: string;
  readonly to: string;
  /** How many scenarios make this move. */
  readonly weight: number;
  readonly crossing: boolean;
}
interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}
export interface PositionedMap {
  readonly nodes: readonly (MapNode & Box)[];
  readonly lanes: readonly ({ readonly lane: string; readonly label: string; readonly party: Party } & Box)[];
  readonly bands: readonly { readonly process: string; readonly label: string; readonly x: number; readonly w: number }[];
  readonly edges: readonly (MapEdge & { readonly points: readonly { readonly x: number; readonly y: number }[] })[];
  readonly width: number;
  readonly height: number;
}

export function deriveMap(site: Site): { readonly nodes: readonly MapNode[]; readonly edges: readonly MapEdge[] } {
  const nodes = site.lanes.lanes.flatMap((lane): MapNode[] => {
    const base = { lane: lane.id, laneLabel: lane.label, process: lane.process };
    if (lane.parts.length === 0) return [{ ...base, key: lane.id, label: lane.label, party: lane.party, about: lane.about, visits: site.visits[lane.id] ?? [] }];
    return lane.parts.map((part) => {
      const key = `${lane.id}.${part.id}`;
      const ref = site.partRefs[key];
      return { ...base, key, label: part.label, party: part.party ?? lane.party, ...(part.about === undefined ? {} : { about: part.about }), ...(ref === undefined ? {} : { ref }), visits: site.visits[key] ?? [] };
    });
  });
  const processOf = new Map(nodes.map((node) => [node.key, node.process]));
  const users = new Map<string, Set<string>>();
  for (const scenario of Object.values(site.scenarios)) {
    for (const [from, to] of movesOf(scenario)) {
      if (from === to) continue;
      const key = `${from}>${to}`;
      users.set(key, (users.get(key) ?? new Set()).add(scenario.id));
    }
  }
  const edges = [...users].map(([key, scenarios]) => {
    const [from, to] = key.split('>') as [string, string];
    return { from, to, weight: scenarios.size, crossing: processOf.get(from) !== processOf.get(to) };
  });
  return { nodes, edges };
}

/** Every step-to-step hand-on in a scenario, as part keys; instanced sessions fold into their lane's parts. */
function movesOf(scenario: Scenario): [string, string][] {
  return Object.values(scenario.steps).flatMap((step) => {
    const flow = step.flow;
    const next = flow.kind === 'next' ? [flow.to] : flow.kind === 'fork' ? flow.options.map((option) => option.to) : [];
    return next.map((to): [string, string] => [step.part, scenario.steps[to]!.part]);
  });
}

/** Thai glyphs are narrower than their code units suggest once vowels and tone marks stack; this is close enough. */
const widthOf = (label: string): number => Math.max(112, Math.round([...label.replace(/[ัิ-ฺ็-๎]/g, '')].length * 7.6) + 28);

export async function layoutMap(graph: ReturnType<typeof deriveMap>, site: Site): Promise<PositionedMap> {
  const processes = site.lanes.processes.map((process) => process.id);
  const laneNodes = site.lanes.lanes.filter((lane) => graph.nodes.some((node) => node.lane === lane.id));
  const root: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.partitioning.activate': 'true',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '18',
      'elk.layered.spacing.nodeNodeBetweenLayers': '56',
    },
    children: laneNodes.map((lane) => ({
      id: `lane:${lane.id}`,
      layoutOptions: { 'elk.partitioning.partition': String(processes.indexOf(lane.process)), 'elk.padding': '[top=38,left=12,bottom=12,right=12]', 'elk.algorithm': 'layered', 'elk.direction': 'DOWN' },
      children: graph.nodes.filter((node) => node.lane === lane.id).map((node) => ({ id: node.key, width: widthOf(node.label), height: 40 })),
    })),
    edges: graph.edges.map((edge, i) => ({ id: `e${i}`, sources: [edge.from], targets: [edge.to] })),
  };
  const laid = await new ELK().layout(root);

  const nodes: (MapNode & Box)[] = [];
  const lanes: PositionedMap['lanes'][number][] = [];
  for (const group of laid.children ?? []) {
    const lane = site.lanes.lanes.find((candidate) => `lane:${candidate.id}` === group.id)!;
    const gx = group.x ?? 0;
    const gy = group.y ?? 0;
    lanes.push({ lane: lane.id, label: lane.label, party: lane.party, x: gx, y: gy, w: group.width ?? 0, h: group.height ?? 0 });
    for (const child of group.children ?? []) {
      const node = graph.nodes.find((candidate) => candidate.key === child.id)!;
      nodes.push({ ...node, x: gx + (child.x ?? 0), y: gy + (child.y ?? 0), w: child.width ?? 0, h: child.height ?? 0 });
    }
  }
  const bands = site.lanes.processes.flatMap((process) => {
    const inside = lanes.filter((lane) => site.lanes.lanes.find((candidate) => candidate.id === lane.lane)!.process === process.id);
    if (inside.length === 0) return [];
    const x = Math.min(...inside.map((lane) => lane.x));
    return [{ process: process.id, label: process.label, x, w: Math.max(...inside.map((lane) => lane.x + lane.w)) - x }];
  });
  // With INCLUDE_CHILDREN, edges declared on the root come back in root coordinates.
  const edges = graph.edges.map((edge, i) => {
    const section = laid.edges?.find((candidate) => candidate.id === `e${i}`)?.sections?.[0];
    const points = section === undefined ? [] : [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
    return { ...edge, points };
  });
  return { nodes, lanes, bands, edges, width: laid.width ?? 0, height: laid.height ?? 0 };
}
