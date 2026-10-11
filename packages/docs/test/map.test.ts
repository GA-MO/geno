import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { deriveMap, layoutMap } from '../src/map/map.js';
import { loadSite, siteOptions } from '../src/scenario/site.js';

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('the system map', () => {
  const site = loadSite(siteOptions(DOCS));
  const graph = deriveMap(site);

  test('every hop link opens its scenario at a step on the hop’s source that hands on to its target', () => {
    for (const edge of graph.edges) {
      for (const visit of edge.visits) {
        const scenario = site.scenarios[visit.scenario]!;
        const step = scenario.steps[visit.step]!;
        const next = step.flow.kind === 'next' ? [step.flow.to] : step.flow.kind === 'fork' ? step.flow.options.map((option) => option.to) : [];
        expect(step.part).toBe(edge.from);
        expect(next.map((to) => scenario.steps[to]!.part)).toContain(edge.to);
      }
      expect(new Set(edge.visits.map((visit) => visit.scenario)).size).toBe(edge.visits.length);
    }
  });

  test('the default view draws only hops a third of the scenarios take', () => {
    const total = Object.keys(site.scenarios).length;
    const backbone = graph.edges.filter((edge) => edge.backbone);
    expect(backbone.length).toBeGreaterThan(0);
    expect(backbone.length).toBeLessThan(20);
    for (const edge of graph.edges) expect(edge.backbone).toBe(edge.visits.length * 3 >= total);
  });

  test('lanes stand in process order, one column each, and every part sits inside its lane', async () => {
    const map = await layoutMap(graph, site);
    const processes = site.lanes.processes.map((process) => process.id);
    const processOf = (lane: string) => processes.indexOf(site.lanes.lanes.find((candidate) => candidate.id === lane)!.process);
    for (const [left, right] of map.lanes.slice(1).map((lane, i) => [map.lanes[i]!, lane] as const)) {
      expect(right.x).toBeGreaterThanOrEqual(left.x + left.w);
      expect(processOf(right.lane)).toBeGreaterThanOrEqual(processOf(left.lane));
    }
    for (const node of map.nodes) {
      const lane = map.lanes.find((candidate) => candidate.lane === node.lane)!;
      expect(node.x).toBeGreaterThanOrEqual(lane.x);
      expect(node.x + node.w).toBeLessThanOrEqual(lane.x + lane.w);
      expect(node.y + node.h).toBeLessThanOrEqual(lane.y + lane.h);
    }
  });
});
