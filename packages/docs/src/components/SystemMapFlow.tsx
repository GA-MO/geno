import { BaseEdge, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow, useStore, type Edge, type EdgeProps, type Node, type NodeProps, type Viewport } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useReducer, useRef } from 'react';
import { hopPath } from '../map/hop.js';
import type { PositionedMap } from '../map/map.js';
import { codeSegments } from '../scenario/labels.js';

type Part = PositionedMap['nodes'][number];
type Hop = PositionedMap['edges'][number];
type Look = 'selected' | 'near' | 'dim' | 'plain';
const BAND_TOP = -44;
const READABLE_ZOOM = 0.8;

interface MapView {
  readonly selected: string | undefined;
  readonly openNeighbor: string | undefined;
  readonly hover: string | undefined;
}

type MapAction =
  | { readonly type: 'select'; readonly part: string | undefined }
  | { readonly type: 'open'; readonly neighbor: string | undefined }
  | { readonly type: 'hover'; readonly neighbor: string | undefined }
  | { readonly type: 'follow-hop'; readonly from: string; readonly to: string };

const NOTHING_SELECTED: MapView = { selected: undefined, openNeighbor: undefined, hover: undefined };

function nextView(view: MapView, action: MapAction): MapView {
  switch (action.type) {
    case 'select':
      return { ...NOTHING_SELECTED, selected: action.part };
    case 'open':
      return { ...view, openNeighbor: action.neighbor };
    case 'hover':
      return { ...view, hover: action.neighbor };
    case 'follow-hop':
      if (view.selected === undefined) return { ...NOTHING_SELECTED, selected: action.from, openNeighbor: action.to };
      return { ...view, openNeighbor: action.to === view.selected ? action.from : action.to };
  }
}

function fittedViewport(mapWidth: number, width: number): Viewport {
  const zoom = Math.min(1, Math.max((width - 16) / mapWidth, READABLE_ZOOM));
  const x = mapWidth * zoom <= width ? (width - mapWidth * zoom) / 2 : 8;
  return { x, y: -BAND_TOP * zoom + 8, zoom };
}

interface Neighbor {
  readonly part: Part;
  readonly out?: Hop;
  readonly in?: Hop;
}

function neighborsOf(map: PositionedMap, key: string): Neighbor[] {
  const found = new Map<string, { part: Part; out?: Hop; in?: Hop }>();
  const entry = (other: string) => found.get(other) ?? found.set(other, { part: map.nodes.find((node) => node.key === other)! }).get(other)!;
  for (const hop of map.edges) {
    if (hop.from === key) entry(hop.to).out = hop;
    if (hop.to === key) entry(hop.from).in = hop;
  }
  const weight = (neighbor: Neighbor) => (neighbor.out?.visits.length ?? 0) + (neighbor.in?.visits.length ?? 0);
  return [...found.values()].sort((a, b) => weight(b) - weight(a));
}

const hopTitle = (map: PositionedMap, hop: Hop) => `${labelOf(map, hop.from)} → ${labelOf(map, hop.to)}: ${hop.visits.length} สถานการณ์`;
const labelOf = (map: PositionedMap, key: string) => map.nodes.find((node) => node.key === key)!.label;

function PartNode({ data }: NodeProps<Node<{ part: Part; look: Look; focus: boolean }, 'part'>>) {
  const { part, look, focus } = data;
  return (
    <button type="button" className={`map-part party-${part.party} ${look}${focus ? ' focus' : ''}${part.visits.length === 0 ? ' unvisited' : ''}`} aria-pressed={look === 'selected'}>
      <Handle type="target" position={Position.Left} />
      <span>
        {part.label} <small>{part.visits.length}</small>
      </span>
      <Handle type="source" position={Position.Right} />
    </button>
  );
}

function HopEdge({ data, style, markerEnd }: EdgeProps<Edge<{ d: string; title: string }, 'hop'>>) {
  return (
    <g>
      <title>{data?.title}</title>
      <BaseEdge path={data?.d ?? ''} interactionWidth={14} {...(style === undefined ? {} : { style })} {...(markerEnd === undefined ? {} : { markerEnd })} />
    </g>
  );
}

const LaneNode = ({ data }: NodeProps<Node<{ label: string; party: string }, 'lane'>>) => <div className={`map-lane party-${data.party}`}>{data.label}</div>;
const BandNode = ({ data }: NodeProps<Node<{ label: string }, 'band'>>) => (
  <div className="map-band" title={data.label}>
    {data.label}
  </div>
);
const NODE_TYPES = { part: PartNode, lane: LaneNode, band: BandNode };
const EDGE_TYPES = { hop: HopEdge };

export default function SystemMapFlow({ map }: { readonly map: PositionedMap }) {
  const [{ selected, openNeighbor, hover }, dispatch] = useReducer(nextView, NOTHING_SELECTED);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => root.current?.setAttribute('data-hydrated', ''), []);
  useEffect(() => {
    root.current?.querySelector('.map-panel')?.scrollTo({ top: 0 });
  }, [selected]);
  useEffect(() => {
    root.current?.querySelector(`[data-neighbor="${openNeighbor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [openNeighbor]);
  const part = map.nodes.find((node) => node.key === selected);
  const neighbors = selected === undefined ? [] : neighborsOf(map, selected);

  return (
    <div className="map-island" ref={root}>
      <div className="map-canvas">
        <ReactFlowProvider>
          <Canvas map={map} selected={selected} neighbors={neighbors} focus={hover ?? openNeighbor} dispatch={dispatch} />
        </ReactFlowProvider>
      </div>
      <aside className="map-panel" aria-live="polite">
        {part === undefined ? (
          <>
            <p className="map-hint">คลิกส่วนใดก็ได้ เพื่อดูเส้นเข้าออกของส่วนนั้น ส่วนที่มันส่งต่อหรือรับมา และสถานการณ์ที่ผ่าน แล้วกระโดดเข้าทัวร์ตรงขั้นนั้นเลย</p>
            <p className="map-hint">เส้นที่เห็นตอนนี้คือทางหลัก {map.edges.filter((edge) => edge.backbone).length} ทาง ที่อย่างน้อยหนึ่งในสามของสถานการณ์ทั้งหมดเดินผ่าน ชี้ที่เส้นเพื่อดูว่ามีกี่สถานการณ์</p>
          </>
        ) : (
          <>
            <p className="map-panel-lane">{part.laneLabel}</p>
            <h3>{part.label}</h3>
            {part.about === undefined ? null : (
              <p>
                {codeSegments(part.about).map((segment, i) => (segment.code ? <code key={i}>{segment.text}</code> : <span key={i}>{segment.text}</span>))}
              </p>
            )}
            {part.ref === undefined ? null : (
              <a className="tour-ref" href={part.ref.url}>
                {part.ref.path}:{part.ref.line}
              </a>
            )}
            <h4>เชื่อมกับ {neighbors.length} ส่วน</h4>
            {neighbors.length === 0 ? (
              <p className="tour-empty">ยังไม่มีสถานการณ์ที่เดินเข้าหรือออกจากส่วนนี้</p>
            ) : (
              <ul className="map-hops">
                {neighbors.map((neighbor) => {
                  const key = neighbor.part.key;
                  const open = openNeighbor === key;
                  return (
                    <li key={key} data-neighbor={key} className={hover === key || open ? 'focus' : undefined} onMouseEnter={() => dispatch({ type: 'hover', neighbor: key })} onMouseLeave={() => dispatch({ type: 'hover', neighbor: undefined })}>
                      <div className="map-hop-row">
                        <button type="button" className="map-hop-part" title={`ไปที่ ${neighbor.part.label}`} onClick={() => dispatch({ type: 'select', part: key })}>
                          {neighbor.part.label}
                        </button>
                        <button type="button" className="map-hop-count" title="ดูสถานการณ์ที่เดินเส้นนี้" aria-expanded={open} onClick={() => dispatch({ type: 'open', neighbor: open ? undefined : key })}>
                          {neighbor.out === undefined ? null : <span title="ส่งต่อไป">→ {neighbor.out.visits.length}</span>}
                          {neighbor.in === undefined ? null : <span title="รับมาจาก">← {neighbor.in.visits.length}</span>}
                        </button>
                      </div>
                      {open ? (
                        <>
                          {neighbor.out === undefined ? null : <HopVisits title={`ส่งต่อไป ${neighbor.part.label}`} hop={neighbor.out} />}
                          {neighbor.in === undefined ? null : <HopVisits title={`รับมาจาก ${neighbor.part.label}`} hop={neighbor.in} />}
                        </>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            <h4>ผ่านจุดนี้ใน {part.visits.length} สถานการณ์</h4>
            {part.visits.length === 0 ? (
              <p className="tour-empty">ยังไม่มีสถานการณ์ที่ผ่านส่วนนี้</p>
            ) : (
              <ul>
                {part.visits.map((visit) => (
                  <li key={visit.scenario}>
                    <a href={`${visit.href}#at=${visit.step}`}>{visit.title}</a>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </aside>
    </div>
  );
}

function HopVisits({ title, hop }: { readonly title: string; readonly hop: Hop }) {
  return (
    <div className="map-hop-visits">
      <p>
        {title} ใน {hop.visits.length} สถานการณ์
      </p>
      <ul>
        {hop.visits.map((visit) => (
          <li key={visit.scenario}>
            <a href={`${visit.href}#at=${visit.step}`}>{visit.title}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Canvas({ map, selected, neighbors, focus, dispatch }: { readonly map: PositionedMap; readonly selected: string | undefined; readonly neighbors: readonly Neighbor[]; readonly focus: string | undefined; readonly dispatch: (action: MapAction) => void }) {
  const flow = useReactFlow();
  const width = useStore((store) => store.width);
  useEffect(() => {
    if (width === 0) return;
    void flow.setViewport(fittedViewport(map.width, width));
  }, [width, map.width]);

  const near = new Set(neighbors.map((neighbor) => neighbor.part.key));
  const boxes = new Map(map.nodes.map((node) => [node.key, node]));
  const lookOf = (key: string): Look => (selected === undefined ? 'plain' : key === selected ? 'selected' : near.has(key) ? 'near' : 'dim');
  const shown = map.edges.filter((edge) => (selected === undefined ? edge.backbone : edge.from === selected || edge.to === selected));
  const heaviestOfAllEdges = Math.max(...map.edges.map((edge) => edge.visits.length));

  const nodes: Node[] = [
    ...map.bands.map((band) => ({
      id: `band:${band.process}`,
      type: 'band',
      position: { x: band.x - 4, y: BAND_TOP },
      data: { label: band.label },
      style: { width: band.w + 8, height: map.height - BAND_TOP + 4 },
      selectable: false,
      zIndex: -2,
    })),
    ...map.lanes.map((lane) => ({
      id: `lane:${lane.lane}`,
      type: 'lane',
      position: { x: lane.x, y: lane.y },
      data: { label: lane.label, party: lane.party },
      style: { width: lane.w, height: lane.h },
      selectable: false,
      zIndex: -1,
    })),
    ...map.nodes.map((node) => ({
      id: node.key,
      type: 'part',
      position: { x: node.x, y: node.y },
      data: { part: node, look: lookOf(node.key), focus: node.key === focus },
      style: { width: node.w, height: node.h },
      initialWidth: node.w,
      initialHeight: node.h,
    })),
  ];
  const edges: Edge[] = shown.map((edge) => {
    const other = edge.from === selected ? edge.to : edge.from;
    const tone = selected === undefined ? 'plain' : edge.from === selected ? 'out' : 'in';
    const lit = selected !== undefined && other === focus;
    return {
      id: `${edge.from}>${edge.to}`,
      source: edge.from,
      target: edge.to,
      type: 'hop',
      data: { d: hopPath(boxes.get(edge.from)!, boxes.get(edge.to)!), title: hopTitle(map, edge) },
      className: `map-edge ${tone}${lit ? ' focus' : ''}`,
      style: { strokeWidth: 1 + 6 * Math.sqrt(edge.visits.length / heaviestOfAllEdges) },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, markerUnits: 'userSpaceOnUse', color: lit ? 'var(--sl-color-white)' : tone === 'out' ? 'var(--sl-color-accent)' : 'var(--sl-color-gray-3)' },
      zIndex: lit ? 1 : 0,
    };
  });

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      onNodeClick={(_, node) => node.type === 'part' && dispatch({ type: 'select', part: node.id === selected ? undefined : node.id })}
      onNodeMouseEnter={(_, node) => near.has(node.id) && dispatch({ type: 'open', neighbor: node.id })}
      onEdgeMouseEnter={(_, edge) => selected !== undefined && dispatch({ type: 'open', neighbor: edge.source === selected ? edge.target : edge.source })}
      onEdgeClick={(_, edge) => dispatch({ type: 'follow-hop', from: edge.source, to: edge.target })}
      onPaneClick={() => dispatch({ type: 'select', part: undefined })}
      nodesDraggable={false}
      nodesConnectable={false}
      minZoom={0.3}
      maxZoom={2}
      attributionPosition="bottom-left"
    >
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  );
}
