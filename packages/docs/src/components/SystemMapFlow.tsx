import { Handle, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useRef, useState } from 'react';
import type { PositionedMap } from '../map/map.js';
import { codeSegments } from '../scenario/labels.js';

type Part = PositionedMap['nodes'][number];
const BAND_TOP = -44;

function PartNode({ data }: NodeProps<Node<{ part: Part; selected: boolean; dim: boolean }, 'part'>>) {
  const { part, selected, dim } = data;
  return (
    <button type="button" className={`map-part party-${part.party}${selected ? ' selected' : ''}${dim ? ' dim' : ''}${part.visits.length === 0 ? ' unvisited' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <span>{part.label}</span>
      {part.visits.length > 0 ? <small>{part.visits.length}</small> : null}
      <Handle type="source" position={Position.Right} />
    </button>
  );
}

const LaneNode = ({ data }: NodeProps<Node<{ label: string; party: string }, 'lane'>>) => <div className={`map-lane party-${data.party}`}>{data.label}</div>;
const BandNode = ({ data }: NodeProps<Node<{ label: string }, 'band'>>) => <div className="map-band">{data.label}</div>;
const NODE_TYPES = { part: PartNode, lane: LaneNode, band: BandNode };

/** The map island: build-time positions from elkjs, React Flow for pan, zoom and picking a part. */
export default function SystemMapFlow({ map }: { readonly map: PositionedMap }) {
  const [selected, setSelected] = useState<string | undefined>();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => root.current?.setAttribute('data-hydrated', ''), []);
  const part = map.nodes.find((node) => node.key === selected);
  const touches = new Set(selected === undefined ? [] : map.edges.flatMap((edge) => (edge.from === selected || edge.to === selected ? [edge.from, edge.to] : [])));

  const nodes: Node[] = [
    ...map.bands.map((band) => ({
      id: `band:${band.process}`,
      type: 'band',
      position: { x: band.x - 6, y: BAND_TOP },
      data: { label: band.label },
      style: { width: band.w + 12, height: map.height - BAND_TOP + 8 },
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
      data: { part: node, selected: node.key === selected, dim: selected !== undefined && !touches.has(node.key) && node.key !== selected },
      style: { width: node.w, height: node.h },
    })),
  ];
  const edges: Edge[] = map.edges.map((edge) => ({
    id: `${edge.from}>${edge.to}`,
    source: edge.from,
    target: edge.to,
    type: 'smoothstep',
    className: `map-edge${edge.crossing ? ' crossing' : ''}${selected !== undefined && (edge.from === selected || edge.to === selected) ? ' lit' : ''}`,
    style: { strokeWidth: 1 + Math.min(edge.weight, 4) },
  }));

  return (
    <div className="map-island" ref={root}>
      <div className="map-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodeClick={(_, node) => node.type === 'part' && setSelected(node.id === selected ? undefined : node.id)}
          onPaneClick={() => setSelected(undefined)}
          nodesDraggable={false}
          nodesConnectable={false}
          fitView
          fitViewOptions={{ padding: 0.06 }}
          minZoom={0.25}
          proOptions={{ hideAttribution: true }}
        />
      </div>
      <aside className="map-panel" aria-live="polite">
        {part === undefined ? (
          <p className="map-hint">คลิกส่วนใดก็ได้บนแผนที่ เพื่อดูว่าสถานการณ์ไหนผ่านส่วนนั้น แล้วกระโดดเข้าทัวร์ตรงขั้นนั้นเลย</p>
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
