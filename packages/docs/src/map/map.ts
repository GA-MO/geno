import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import { partKeyOf, type CodeRef, type Scenario, type StepId } from '../scenario/model.js';
import type { Party } from '../scenario/schema.js';
import type { Site, Visit } from '../scenario/site.js';
import type { Box } from './hop.js';

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
  readonly visits: readonly Visit[];
  readonly backbone: boolean;
}
export interface PositionedMap {
  readonly nodes: readonly (MapNode & Box)[];
  readonly lanes: readonly ({ readonly lane: string; readonly label: string; readonly party: Party } & Box)[];
  readonly bands: readonly { readonly process: string; readonly label: string; readonly x: number; readonly w: number }[];
  readonly edges: readonly MapEdge[];
  readonly width: number;
  readonly height: number;
}

export function deriveMap(site: Site): { readonly nodes: readonly MapNode[]; readonly edges: readonly MapEdge[] } {
  const nodes = site.lanes.lanes.flatMap((lane): MapNode[] => {
    const base = { lane: lane.id, laneLabel: lane.label, process: lane.process };
    if (lane.parts.length === 0) return [{ ...base, key: lane.id, label: lane.label, party: lane.party, about: lane.about, visits: site.visits[partKeyOf(lane.id)] ?? [] }];
    return lane.parts.map((part) => {
      const key = partKeyOf(lane.id, part.id);
      const ref = site.partRefs[key];
      return { ...base, key, label: part.label, party: part.party ?? lane.party, ...(part.about === undefined ? {} : { about: part.about }), ...(ref === undefined ? {} : { ref }), visits: site.visits[key] ?? [] };
    });
  });
  const hops = new Map<string, Visit[]>();
  const scenarios = Object.values(site.scenarios);
  for (const scenario of scenarios) {
    const seen = new Set<string>();
    for (const [step, from, to] of hopsOf(scenario)) {
      const key = `${from}>${to}`;
      if (from === to || seen.has(key)) continue;
      seen.add(key);
      hops.set(key, [...(hops.get(key) ?? []), { scenario: scenario.id, title: scenario.title, href: scenario.href, step }]);
    }
  }
  const edges = [...hops].map(([key, visits]) => {
    const [from, to] = key.split('>') as [string, string];
    return { from, to, visits, backbone: visits.length * 3 >= scenarios.length };
  });
  return { nodes, edges };
}

function hopsOf(scenario: Scenario): [Visit['step'], string, string][] {
  return (Object.keys(scenario.via) as StepId[]).flatMap((id) => {
    const step = scenario.steps[id]!;
    const flow = step.flow;
    const next = flow.kind === 'next' ? [flow.to] : flow.kind === 'fork' ? flow.options.map((option) => option.to) : [];
    return next.map((to): [Visit['step'], string, string] => [step.id, step.part, scenario.steps[to]!.part]);
  });
}

const widthOf = (text: string): number => [...text.replace(/[\u0e31\u0e34-\u0e3a\u0e47-\u0e4e]/g, '')].reduce((sum, char) => sum + (char === ' ' ? SPACE : char.charCodeAt(0) >= 0x0e00 ? 7.1 : 6.8), 0);
const textOf = (node: MapNode): string => `${node.label} ${node.visits.length}`;
const SPACE = 3.4;
const PADDING = 18;
const LINE = 17;
const MIN_TEXT = 64;
const MAX_TEXT = 100;

function linesOf(text: string, inner: number): number {
  let lines = 0;
  let used = inner;
  for (const width of text.split(' ').map(widthOf)) {
    if (used + SPACE + width <= inner) used += SPACE + width;
    else {
      lines += Math.ceil(width / inner);
      used = width % inner || inner;
    }
  }
  return lines;
}

function laneWidth(parts: readonly MapNode[]): number {
  return Math.round(Math.min(MAX_TEXT, Math.max(MIN_TEXT, Math.max(...parts.map((part) => widthOf(textOf(part)))) / 2 + 8))) + PADDING;
}
const partHeight = (part: MapNode, width: number): number => 10 + LINE * linesOf(textOf(part), (width - PADDING) * 0.94);

export async function layoutMap(graph: ReturnType<typeof deriveMap>, site: Site): Promise<PositionedMap> {
  const processes = site.lanes.processes.map((process) => process.id);
  const laneNodes = site.lanes.lanes.filter((lane) => graph.nodes.some((node) => node.lane === lane.id)).sort((a, b) => processes.indexOf(a.process) - processes.indexOf(b.process));
  const root: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.partitioning.activate': 'true',
      'elk.separateConnectedComponents': 'false',
      'elk.layered.spacing.nodeNodeBetweenLayers': '10',
      'elk.padding': '[top=0,left=0,bottom=0,right=0]',
    },
    children: laneNodes.map((lane, column) => {
      const parts = graph.nodes.filter((node) => node.lane === lane.id);
      const width = laneWidth(parts);
      return {
        id: `lane:${lane.id}`,
        layoutOptions: {
          'elk.partitioning.partition': String(column),
          'elk.algorithm': 'layered',
          'elk.direction': 'RIGHT',
          'elk.layered.crossingMinimization.forceNodeModelOrder': 'true',
          'elk.separateConnectedComponents': 'false',
          'elk.spacing.nodeNode': '6',
          'elk.padding': '[top=36,left=5,bottom=5,right=5]',
        },
        children: parts.map((part) => ({ id: part.key, width, height: partHeight(part, width) })),
      };
    }),
  };
  const laid = await new ELK().layout(root);

  const nodes: (MapNode & Box)[] = [];
  const lanes: PositionedMap['lanes'][number][] = [];
  for (const group of laid.children ?? []) {
    const lane = laneNodes.find((candidate) => `lane:${candidate.id}` === group.id)!;
    const gx = group.x ?? 0;
    lanes.push({ lane: lane.id, label: lane.label, party: lane.party, x: gx, y: 0, w: group.width ?? 0, h: group.height ?? 0 });
    for (const child of group.children ?? []) {
      const node = graph.nodes.find((candidate) => candidate.key === child.id)!;
      nodes.push({ ...node, x: gx + (child.x ?? 0), y: child.y ?? 0, w: child.width ?? 0, h: child.height ?? 0 });
    }
  }
  const bands = site.lanes.processes.flatMap((process) => {
    const inside = lanes.filter((lane) => laneNodes.find((candidate) => candidate.id === lane.lane)!.process === process.id);
    if (inside.length === 0) return [];
    const x = Math.min(...inside.map((lane) => lane.x));
    return [{ process: process.id, label: process.label, x, w: Math.max(...inside.map((lane) => lane.x + lane.w)) - x }];
  });
  return { nodes, lanes, bands, edges: graph.edges, width: laid.width ?? 0, height: Math.max(...lanes.map((lane) => lane.h)) };
}
