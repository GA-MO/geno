import { Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react';
import { codeSegments, endText, PARTY_LABELS, PHASE_LABELS, TURN_END_LABELS, WHOSE_MOVE } from '../scenario/labels.js';
import type { ForkOption, OptionId, Scenario, Step, StepId } from '../scenario/model.js';
import { briefOf, hashOf, initialState, layoutWalk, progressAt, reduce, stateFromHash, walk, type Moment, type TourAction, type TourState } from '../scenario/tour.js';

export interface TourProps {
  readonly scenario: Scenario;
  /** `lane.part` -> its Thai label, from lanes.yaml. */
  readonly parts: Readonly<Record<string, string>>;
}

const COLUMN = 232;
const ROW = 112;
const NODE = 204;
const HEADER = 48;
const PLAY_MS = 1700;

type Action = TourAction | { readonly type: 'restore'; readonly state: TourState };
type Place = 'past' | 'current' | 'future';
type StepNodeData = { step: Step; place: Place; number: number; chosen?: OptionId; choose: (fork: StepId, option: OptionId) => void };
type LaneNodeData = { label: string; party: string };

const Code = ({ text }: { readonly text: string }): ReactNode =>
  codeSegments(text).map((segment, i) => (segment.code ? <code key={i}>{segment.text}</code> : <span key={i}>{segment.text}</span>));

function ForkButtons({ step, chosen, choose }: { readonly step: Step; readonly chosen: OptionId | undefined; readonly choose: (fork: StepId, option: OptionId) => void }) {
  if (step.flow.kind !== 'fork') return null;
  return (
    <div className="tour-fork" role="group" aria-label={step.flow.ask}>
      {step.flow.options.map((option: ForkOption) => (
        <button key={option.id} type="button" className="nodrag" aria-pressed={option.id === chosen} onClick={() => choose(step.id, option.id)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function StepNode({ data }: NodeProps<Node<StepNodeData, 'step'>>) {
  const { step, place, number, chosen, choose } = data;
  return (
    <div className={`tour-node party-${step.party} ${place}${step.flow.kind === 'fork' ? ' fork' : ''}${step.flow.kind === 'end' ? ' end' : ''}`}>
      <Handle type="target" position={Position.Top} id="t" />
      <Handle type="target" position={Position.Left} id="tl" />
      <Handle type="target" position={Position.Right} id="tr" />
      <span className="tour-node-number">{number}</span>
      <span className="tour-node-text">{briefOf(step.does).replace(/`/g, '')}</span>
      {place === 'current' ? <ForkButtons step={step} chosen={chosen} choose={choose} /> : null}
      {step.flow.kind === 'end' ? <span className="tour-node-end">{endText(step.flow.end)}</span> : null}
      <Handle type="source" position={Position.Bottom} id="b" />
      <Handle type="source" position={Position.Right} id="sr" />
      <Handle type="source" position={Position.Left} id="sl" />
    </div>
  );
}

function LaneNode({ data }: NodeProps<Node<LaneNodeData, 'lane'>>) {
  return (
    <div className={`tour-lane party-${data.party}`}>
      <span>{data.label}</span>
    </div>
  );
}

const NODE_TYPES = { step: StepNode, lane: LaneNode };

function Moments({ title, moments, current }: { readonly title: string; readonly moments: readonly Moment[]; readonly current: StepId }) {
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }, [moments.length]);
  return (
    <section className="tour-moments">
      <h4>
        {title} <span>{moments.length}</span>
      </h4>
      {moments.length === 0 ? (
        <p className="tour-empty">ยังไม่มี</p>
      ) : (
        <ol ref={list}>
          {moments.map((moment) => (
            <li key={moment.step} className={moment.step === current ? 'now' : undefined}>
              <Code text={moment.text} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Diagram({ scenario, path, index, choices, dispatch }: { readonly scenario: Scenario; readonly path: readonly StepId[]; readonly index: number; readonly choices: TourState['choices']; readonly dispatch: (action: Action) => void }) {
  const flow = useReactFlow();
  const grid = useMemo(() => layoutWalk(scenario, path), [scenario, path]);
  const choose = (fork: StepId, option: OptionId) => dispatch({ type: 'choose', fork, option });
  const rows = new Map(grid.cells.map((cell) => [cell.step, cell]));

  const nodes: Node[] = [
    ...scenario.columns.map((column, i) => ({
      id: `lane:${column.key}`,
      type: 'lane',
      position: { x: i * COLUMN, y: 0 },
      data: { label: column.label, party: column.party },
      style: { width: COLUMN - 8, height: HEADER + grid.rows * ROW },
      selectable: false,
      draggable: false,
      zIndex: -1,
    })),
    ...grid.cells.map((cell, i) => ({
      id: cell.step,
      type: 'step',
      position: { x: cell.column * COLUMN + (COLUMN - 8 - NODE) / 2, y: HEADER + cell.row * ROW + 12 },
      data: {
        step: scenario.steps[cell.step]!,
        place: i < index ? 'past' : i === index ? 'current' : 'future',
        number: i + 1,
        ...(choices[cell.step] === undefined ? {} : { chosen: choices[cell.step] }),
        choose,
      } satisfies StepNodeData,
      draggable: false,
      zIndex: i === index ? 10 : 1,
    })),
  ];
  const edges: Edge[] = grid.edges.map((edge) => {
    const from = rows.get(edge.from)!;
    const to = rows.get(edge.to)!;
    const sameRow = from.row === to.row;
    const done = path.indexOf(edge.to) <= index && edge.kind === 'next';
    return {
      id: `${edge.kind}:${edge.from}->${edge.to}`,
      source: edge.from,
      target: edge.to,
      sourceHandle: sameRow ? (to.column > from.column ? 'sr' : 'sl') : 'b',
      targetHandle: sameRow ? (to.column > from.column ? 'tl' : 'tr') : 't',
      type: 'smoothstep',
      className: `tour-edge${done ? ' done' : ''}${edge.crossing ? ' crossing' : ''}${edge.kind === 'again' ? ' again' : ''}`,
      animated: path.indexOf(edge.to) === index,
    };
  });

  const current = grid.cells[index];
  useEffect(() => {
    if (current === undefined) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    void flow.setCenter(current.column * COLUMN + COLUMN / 2, HEADER + current.row * ROW + ROW / 2, { zoom: flow.getZoom() < 0.5 ? 0.8 : flow.getZoom(), duration: still ? 0 : 400 });
  }, [current?.step, current?.column, current?.row]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={NODE_TYPES}
      onNodeClick={(_, node) => node.type === 'step' && dispatch({ type: 'jump', step: node.id as StepId })}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      defaultViewport={{ x: 24, y: 8, zoom: 0.8 }}
      minZoom={0.3}
      maxZoom={1.4}
      proOptions={{ hideAttribution: true }}
    />
  );
}

export default function Tour({ scenario, parts }: TourProps) {
  const [state, dispatch] = useReducer((current: TourState, action: Action) => (action.type === 'restore' ? action.state : reduce(scenario, current, action)), scenario, initialState);
  const root = useRef<HTMLDivElement>(null);
  const path = useMemo(() => walk(scenario, state.choices), [scenario, state.choices]);
  const progress = progressAt(scenario, path, state.index);
  const { step } = progress;
  const column = scenario.columns[step.column]!;

  useEffect(() => {
    root.current?.setAttribute('data-hydrated', '');
    const restore = () => location.hash.startsWith('#at=') && dispatch({ type: 'restore', state: stateFromHash(scenario, location.hash) });
    restore();
    addEventListener('hashchange', restore);
    return () => removeEventListener('hashchange', restore);
  }, [scenario]);

  useEffect(() => {
    const hash = hashOf(scenario, state);
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }, [scenario, state.choices, state.index]);

  useEffect(() => {
    if (!state.playing) return;
    const timer = setInterval(() => dispatch({ type: 'tick' }), PLAY_MS);
    return () => clearInterval(timer);
  }, [state.playing]);

  useEffect(() => {
    const keys: Readonly<Record<string, Action>> = { ArrowRight: { type: 'next' }, ArrowLeft: { type: 'back' }, Home: { type: 'first' }, End: { type: 'last' } };
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.altKey || event.ctrlKey || event.metaKey || target?.closest('input, textarea, select, [contenteditable]')) return;
      const action = event.key === ' ' ? ({ type: state.playing ? 'pause' : 'play' } as const) : keys[event.key];
      if (action === undefined) return;
      event.preventDefault();
      dispatch(action);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [state.playing]);

  const forks = path.slice(0, state.index + 1).flatMap((id) => {
    const flow = scenario.steps[id]!.flow;
    if (flow.kind !== 'fork') return [];
    const chosen = flow.options.find((option) => option.id === state.choices[id]) ?? flow.options[0]!;
    return [{ id, label: chosen.label }];
  });
  const choose = (fork: StepId, option: OptionId) => dispatch({ type: 'choose', fork, option });
  const last = state.index === path.length - 1;

  return (
    <div className="tour not-content" ref={root} aria-label={`ทัวร์: ${scenario.title}`}>
      <div className="tour-controls">
        <button type="button" onClick={() => dispatch({ type: 'first' })} disabled={state.index === 0} title="กลับไปขั้นแรก (Home)" aria-label="ขั้นแรก">
          ⏮
        </button>
        <button type="button" onClick={() => dispatch({ type: 'back' })} disabled={state.index === 0} title="ขั้นก่อนหน้า (←)" aria-label="ขั้นก่อนหน้า">
          ◀
        </button>
        <button type="button" className="tour-play" onClick={() => dispatch({ type: state.playing ? 'pause' : 'play' })} title="เล่น หรือหยุด (Space)">
          {state.playing ? '⏸ หยุด' : '▶ เล่น'}
        </button>
        <button type="button" onClick={() => dispatch({ type: 'next' })} disabled={last} title="ขั้นถัดไป (→)" aria-label="ขั้นถัดไป">
          ▶
        </button>
        <button type="button" onClick={() => dispatch({ type: 'last' })} disabled={last} title="ไปขั้นสุดท้าย (End)" aria-label="ขั้นสุดท้าย">
          ⏭
        </button>
        <span className="tour-position" aria-live="polite">
          ขั้นที่ {progress.position.at} จาก {progress.position.of}
        </span>
        {forks.map((fork) => (
          <button key={fork.id} type="button" className="tour-pill" onClick={() => dispatch({ type: 'jump', step: fork.id })} title="กลับไปที่ทางแยกนี้">
            ทางแยก: {fork.label}
          </button>
        ))}
      </div>

      <div className="tour-body">
        <div className="tour-diagram">
          <ReactFlowProvider>
            <Diagram scenario={scenario} path={path} index={state.index} choices={state.choices} dispatch={dispatch} />
          </ReactFlowProvider>
        </div>

        <aside className="tour-progress" aria-label="ความคืบหน้าของ turn">
          <p className={`tour-whose party-${progress.whoseMove}`}>{WHOSE_MOVE[progress.whoseMove]}</p>
          <dl>
            <dt>ช่วงของ turn</dt>
            <dd>
              {PHASE_LABELS[progress.phase]} <code>{progress.phase}</code>
            </dd>
            <dt>ความคืบหน้า</dt>
            <dd>
              ขั้นที่ {progress.position.at} จาก {progress.position.of}
            </dd>
            <dt>นับแล้ว</dt>
            <dd>
              เรียกโมเดล <strong>{progress.modelCalls}</strong> ครั้ง · รันเครื่องมือ <strong>{progress.toolRuns}</strong> ครั้ง
            </dd>
          </dl>
          {progress.turn.kind === 'end' ? (
            <p className={`tour-ending turn-${progress.turn.end.turn}`}>
              {TURN_END_LABELS[progress.turn.end.turn]}: <code>{endText(progress.turn.end)}</code>
            </p>
          ) : progress.turn.kind === 'leave' ? (
            <p className="tour-ending">
              ไปต่อที่ {progress.turn.to.href === undefined ? progress.turn.to.title : <a href={progress.turn.to.href}>{progress.turn.to.title}</a>}
            </p>
          ) : (
            <p className="tour-running">turn กำลังทำงาน</p>
          )}
          <Moments title="AI ทำอะไรไปแล้ว" moments={progress.ai} current={step.id} />
          <Moments title="harness ทำอะไรไปแล้ว" moments={progress.harness} current={step.id} />
        </aside>
      </div>

      <section className={`tour-narration party-${step.party}`} aria-live="polite">
        <header>
          <span className="tour-badge">{PARTY_LABELS[step.party]}</span>
          <span className="tour-lane-name">
            {column.label}
            {parts[step.part] === undefined ? null : <> · {parts[step.part]}</>}
          </span>
        </header>
        <p className="tour-does">
          <Code text={step.does} />
        </p>
        {step.sees === undefined ? null : (
          <blockquote className="tour-sees">
            <span>ผู้ใช้เห็น</span> <Code text={step.sees} />
          </blockquote>
        )}
        {step.flow.kind === 'fork' ? (
          <div className="tour-ask">
            <p>
              <strong>{step.flow.ask}</strong> เลือกทางเพื่อเดินต่อ
            </p>
            <ForkButtons step={step} chosen={state.choices[step.id]} choose={choose} />
          </div>
        ) : null}
        <footer>
          {step.emits.length === 0 ? null : (
            <span className="tour-emits">
              ส่งออก {step.emits.map((name) => <code key={name}>{name}</code>)}
            </span>
          )}
          {step.ref === undefined ? null : (
            <a className="tour-ref" href={step.ref.url} title="เปิดบรรทัดนี้ใน VS Code">
              {step.ref.path}:{step.ref.line}
            </a>
          )}
        </footer>
      </section>
    </div>
  );
}
