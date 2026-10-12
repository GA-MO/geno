import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Scenario } from '../scenario/model.js';
import {
  ACTOR_NAME,
  ACTORS,
  actorIndex,
  branchesAt,
  choose,
  endingOf,
  LANE,
  layoutLanes,
  storyBeats,
  storyFromHash,
  storyHash,
  storyStart,
  WHO_LABEL,
  type Beat,
  type Branch,
  type Ending,
  type LaneEdge,
  type LaneItem,
  type StoryState,
} from '../scenario/story.js';
import Sees, { Code } from './Mock.js';

export interface StoryProps {
  readonly scenario: Scenario;
  /** English lane names for the internals, by lane id. */
  readonly laneNames: Readonly<Record<string, string>>;
}

type View = 'sequence' | 'lanes';
const VIEW_KEY = 'geno-docs:tour-view';
const LANE_H = 76;
/** The lane name sits in a strip at the top of its lane, so nodes below it never pass under it. */
const CAPTION = 18;
const reduced = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;
const place = (i: number, at: number): 'past' | 'current' | 'future' => (i < at ? 'past' : i === at ? 'current' : 'future');
const hopText = (beat: Beat): string => (beat.from === beat.to ? `${ACTOR_NAME[beat.from]} ทำเอง` : `${ACTOR_NAME[beat.from]} → ${ACTOR_NAME[beat.to]}`);
const xOf = (actor: Beat['from']): number => 10 + actorIndex(actor) * 20;

function EndPill({ ending, className = '' }: { readonly ending: Ending; readonly className?: string }) {
  return (
    <span className={`end end-${ending.tone} ${className}`}>
      <span className="end-dot" aria-hidden="true" />
      {ending.label}
    </span>
  );
}

/* ---------- Sequence view ---------- */

function SeqRow({ beat, i, at, go }: { readonly beat: Beat; readonly i: number; readonly at: number; readonly go: (i: number) => void }) {
  const a = xOf(beat.from);
  const z = xOf(beat.to);
  const self = a === z;
  const lo = Math.min(a, z);
  const hi = Math.max(a, z);
  const label: CSSProperties = self ? (a <= 50 ? { marginLeft: `calc(${a}% + 48px)` } : { marginRight: `calc(${100 - a}% + 48px)`, textAlign: 'right', justifyContent: 'flex-end' }) : 100 - lo >= 45 ? { marginLeft: `calc(${lo}% + 10px)` } : { marginRight: `calc(${100 - hi}% + 10px)`, textAlign: 'right', justifyContent: 'flex-end' };
  return (
    <button type="button" className={`sq-row ${place(i, at)} w-${beat.who}${self ? ' self' : ''}`} onClick={() => go(i)} aria-current={i === at ? 'step' : undefined}>
      <span className="sq-label" style={label}>
        <span className="sq-n">{i + 1}</span>
        <span>
          <Code text={beat.head.title} />
        </span>
      </span>
      {self ? <span className="sq-self" style={{ left: `${a}%` }} /> : <span className={`sq-arrow ${z > a ? 'right' : 'left'}`} style={{ left: `${lo}%`, width: `${hi - lo}%` }} />}
    </button>
  );
}

function SeqDecision({ beat, branches, past, pick }: { readonly beat: Beat; readonly branches: readonly Branch[]; readonly past: boolean; readonly pick: (branch: Branch) => void }) {
  const x = xOf(beat.to);
  const leftward = x > 50;
  const chosen = branches.find((branch) => branch.chosen);
  const side: CSSProperties = leftward ? { marginRight: `calc(${100 - x}% - 1px)`, flexDirection: 'row-reverse' } : { marginLeft: `calc(${x}% - 1px)` };
  return (
    <div className={`sq-decision${past ? ' past' : ''}`}>
      <div className="sq-diamond-row" style={leftward ? { justifyContent: 'flex-end', marginRight: `calc(${100 - x}% - 13px)` } : { marginLeft: `calc(${x}% - 13px)` }}>
        <span className="sq-diamond" aria-hidden="true" />
        <span className="sq-ask">{beat.head.ask}</span>
      </div>
      {branches
        .filter((branch) => !branch.chosen)
        .map((branch) => (
          <button key={branch.option.id} type="button" className={`sq-branch${leftward ? ' leftward' : ''}`} style={side} onClick={() => pick(branch)} title={`เดินทาง ${branch.option.label}`}>
            <span className="br-line" aria-hidden="true" />
            <span className="br-label">{branch.option.label}</span>
            <span className="br-arrow" aria-hidden="true" />
            <EndPill ending={branch.ending} className="br-end" />
          </button>
        ))}
      {chosen === undefined ? null : (
        <div className="sq-chosen" style={leftward ? { justifyContent: 'flex-end', marginRight: `calc(${100 - x}% - 1px)` } : { marginLeft: `calc(${x}% - 1px)` }}>
          <span className="br-stem" aria-hidden="true" />
          <span className="br-label chosen">{chosen.option.label}</span>
        </div>
      )}
    </div>
  );
}

function Sequence({ scenario, beats, state, go, pick }: { readonly scenario: Scenario; readonly beats: readonly Beat[]; readonly state: StoryState; readonly go: (i: number) => void; readonly pick: (branch: Branch) => void }) {
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scroller = body.current;
    const current = scroller?.querySelector<HTMLElement>('.sq-row.current');
    if (scroller === null || current === null || current === undefined) return;
    scroller.scrollTo({ top: current.offsetTop - scroller.clientHeight / 2 + current.offsetHeight / 2, behavior: reduced() ? 'auto' : 'smooth' });
  }, [state.at, beats.length]);
  const last = beats.at(-1)!;
  const ending = endingOf(last);
  return (
    <section className="seq tour-card" aria-label="Sequence diagram">
      <div className="sq-head">
        {ACTORS.map((actor) => (
          <div key={actor.id} className="sq-actor" style={{ left: `${xOf(actor.id)}%` }}>
            <strong>{actor.name}</strong>
            <span>{actor.sub}</span>
          </div>
        ))}
      </div>
      <div className="sq-body" ref={body}>
        <div className="sq-inner">
          <div className="sq-lines" aria-hidden="true">
            {ACTORS.map((actor) => (
              <span key={actor.id} style={{ left: `${xOf(actor.id)}%` }} />
            ))}
          </div>
          {beats.map((beat, i) => (
            <div key={beat.id}>
              <SeqRow beat={beat} i={i} at={state.at} go={go} />
              {beat.flow.kind === 'fork' ? <SeqDecision beat={beat} branches={branchesAt(scenario, state.choices, beat.last)} past={i < state.at} pick={pick} /> : null}
            </div>
          ))}
          {ending === undefined ? null : (
            <div className={`sq-end ${state.at === beats.length - 1 ? 'current' : 'future'}`} style={xOf(last.to) > 50 ? { justifyContent: 'flex-end', marginRight: `calc(${100 - xOf(last.to)}% - 12px)` } : { marginLeft: `calc(${xOf(last.to)}% - 12px)` }}>
              <EndPill ending={ending} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/* ---------- Swim lanes ---------- */

interface Box {
  readonly x: number;
  readonly cy: number;
  readonly w: number;
}

function edgePath(from: Box, to: Box): string {
  const start = from.x + from.w;
  if (from.cy === to.cy) return `M ${start} ${from.cy} H ${to.x}`;
  const s = to.cy > from.cy ? 1 : -1;
  if (to.x - start >= LANE.trunk) {
    const turn = to.x - 8;
    const bend = Math.min(6, Math.abs(to.cy - from.cy) / 2);
    return `M ${start} ${from.cy} H ${turn - bend} Q ${turn} ${from.cy} ${turn} ${from.cy + s * bend} V ${to.cy - s * bend} Q ${turn} ${to.cy} ${turn + bend} ${to.cy} H ${to.x}`;
  }
  const x = from.x + from.w / 2;
  const r = Math.min(8, Math.abs(to.cy - from.cy) / 2, (to.x - x) / 2);
  return `M ${x} ${from.cy} V ${to.cy - s * r} Q ${x} ${to.cy} ${x + r} ${to.cy} H ${to.x}`;
}

function Lanes({ scenario, beats, state, go, pick }: { readonly scenario: Scenario; readonly beats: readonly Beat[]; readonly state: StoryState; readonly go: (i: number) => void; readonly pick: (branch: Branch) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => layoutLanes(scenario, state.choices, beats), [scenario, state.choices, beats]);
  const boxes = layout.items.map((item) => ({ ...item, cy: item.row * LANE_H + CAPTION + (LANE_H - CAPTION) / 2 }));
  const current = layout.items.findIndex((item) => item.kind === 'beat' && item.beat === state.at);
  useLayoutEffect(() => {
    const element = scroller.current;
    const item = boxes[current];
    if (element === null || item === undefined) return;
    element.scrollTo({ left: item.x + item.w / 2 - element.clientWidth / 2, behavior: reduced() ? 'auto' : 'smooth' });
  }, [current, layout.width]);
  const height = layout.rows * LANE_H;
  const stateOf = (item: LaneItem): 'past' | 'current' | 'future' | 'other' => {
    if (item.kind === 'beat') return place(item.beat, state.at);
    if (item.kind === 'branch') return !item.branch.chosen ? 'other' : state.at > item.beat ? 'past' : 'future';
    return state.at === beats.length - 1 ? 'current' : 'future';
  };
  const edgeKind = (edge: LaneEdge): string => {
    if (edge.to === current) return 'into';
    const to = stateOf(layout.items[edge.to]!);
    return to === 'other' ? 'faded' : to === 'future' ? 'future' : 'past';
  };
  return (
    <section className="lanes tour-card" aria-label="Swim lanes">
      <div className="ln-captions" aria-hidden="true">
        {[...Array(layout.rows).keys()].map((row) => (
          <p key={row} className="ln-caption" style={{ top: row * LANE_H }}>
            {ACTORS[row] === undefined ? null : <><strong>{ACTORS[row].name}</strong> <span>{ACTORS[row].sub}</span></>}
          </p>
        ))}
      </div>
      <div className="ln-scroll" ref={scroller}>
        <div className="ln-canvas" style={{ width: layout.width, height }}>
          {[...Array(layout.rows).keys()].map((row) => (
            <div key={row} className={`ln-band${row % 2 === 1 ? ' alt' : ''}`} style={{ top: row * LANE_H, height: LANE_H }} />
          ))}
          <svg className="ln-svg" width={layout.width} height={height} aria-hidden="true">
            <defs>
              {['past', 'future', 'faded', 'into'].map((kind) => (
                <marker key={kind} id={`ah-${kind}`} className={`mk-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0 0 L10 5 L0 10 z" />
                </marker>
              ))}
            </defs>
            {[...layout.edges]
              .map((edge) => ({ edge, kind: edgeKind(edge) }))
              .sort((a, b) => Number(b.kind === 'faded') - Number(a.kind === 'faded'))
              .map(({ edge, kind }) => (
                <path key={`${edge.from}-${edge.to}`} className={`edge e-${kind}`} d={edgePath(boxes[edge.from]!, boxes[edge.to]!)} markerEnd={`url(#ah-${kind})`} />
              ))}
          </svg>
          {boxes.map((item, index) => {
            const style: CSSProperties = { left: item.x, top: item.cy, width: item.w };
            if (item.kind === 'beat') {
              const beat = beats[item.beat]!;
              const label = `จังหวะที่ ${item.beat + 1}: ${beat.head.title.replace(/`/g, '')}`;
              if (item.fork)
                return (
                  <button key={index} type="button" className={`ln-diamond ${place(item.beat, state.at)}`} style={style} onClick={() => go(item.beat)} aria-label={label} title={label}>
                    <span className="dm-shape" aria-hidden="true" />
                    <span className="dm-t">{beat.head.ask}</span>
                  </button>
                );
              return (
                <button key={index} type="button" className={`ln-node ${place(item.beat, state.at)} w-${beat.who}`} style={style} onClick={() => go(item.beat)} aria-current={item.beat === state.at ? 'step' : undefined} title={label}>
                  <span className="ln-t">
                    <span className="ln-num">{item.beat + 1}</span>
                    <Code text={beat.head.title} />
                  </span>
                </button>
              );
            }
            if (item.kind === 'branch') {
              const { option, ending, chosen } = item.branch;
              return (
                <button key={index} type="button" className={`ln-chip ${stateOf(item)}`} style={style} onClick={() => pick(item.branch)} aria-pressed={chosen} title={chosen ? option.label : `เดินทาง ${option.label}: ${ending.label}`}>
                  <span className="chip-label">{option.label}</span>
                  {chosen ? null : (
                    <span className={`chip-end end-${ending.tone}`}>
                      <span className="end-dot" aria-hidden="true" />
                      {ending.label}
                    </span>
                  )}
                </button>
              );
            }
            return (
              <div key={index} className={`ln-end ${stateOf(item)}`} style={style}>
                <EndPill ending={item.ending} />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/* ---------- Reading card ---------- */

function Internals({ scenario, beat, laneNames }: { readonly scenario: Scenario; readonly beat: Beat; readonly laneNames: StoryProps['laneNames'] }) {
  const laneName = (lane: string): string => {
    const [id, session] = lane.split('@') as [string, string | undefined];
    return session === undefined ? (laneNames[id] ?? id) : `${laneNames[id] ?? id} (${session})`;
  };
  return (
    <details className="int">
      <summary>
        ดูขั้นในโค้ด <span>{beat.steps.length} ขั้น</span>
      </summary>
      <ol>
        {beat.steps.map((id) => {
          const step = scenario.steps[id]!;
          return (
            <li key={id} id={`step-${id}`}>
              <span className="int-lane">{laneName(step.lane)}</span>
              <div>
                <p>
                  <Code text={step.does} />
                </p>
                {step.sees === undefined ? null : (
                  <p className="int-sees">
                    บนจอ: <Code text={step.sees} />
                  </p>
                )}
                {step.ref === undefined ? null : (
                  <a className="ref" href={step.ref.url} title="เปิดบรรทัดนี้ใน VS Code">
                    {step.ref.path}:{step.ref.line}
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

function Reading({ scenario, beats, state, laneNames, go, pick, restart }: { readonly scenario: Scenario; readonly beats: readonly Beat[]; readonly state: StoryState; readonly laneNames: StoryProps['laneNames']; readonly go: (i: number) => void; readonly pick: (branch: Branch) => void; readonly restart: () => void }) {
  const beat = beats[state.at]!;
  const next = beats[state.at + 1];
  const ending = endingOf(beat);
  const branches = beat.flow.kind === 'fork' ? branchesAt(scenario, state.choices, beat.last) : [];
  const lastFork = beats.findLastIndex((candidate) => candidate.flow.kind === 'fork');
  let nav: ReactNode;
  if (ending !== undefined)
    nav = (
      <span className="nav-end">
        <button type="button" className="btn ghost" onClick={restart}>
          เริ่มใหม่
        </button>
        {lastFork === -1 ? null : (
          <button type="button" className="btn" onClick={() => go(lastFork)}>
            ลองทางอื่น
          </button>
        )}
      </span>
    );
  else if (next !== undefined)
    nav = (
      <button type="button" className="btn primary" onClick={() => go(state.at + 1)}>
        <span className="next-k">ถัดไป</span>
        <span className="next-t">
          <Code text={next.head.title} />
        </span>
        <span aria-hidden="true">→</span>
      </button>
    );
  return (
    <article className="read tour-card" aria-live="polite">
      <div className="bh">
        <span className={`who who-${beat.who}`}>{WHO_LABEL[beat.who]}</span>
        <span className="count">
          จังหวะที่ {state.at + 1} จาก {beats.length}
        </span>
      </div>
      <h2 className="bt">
        <Code text={beat.head.title} />
      </h2>
      <p className="hop">{hopText(beat)}</p>
      <p className="th">
        <Code text={beat.head.text} />
      </p>
      <Sees shown={beat.head.sees} />
      {branches.length === 0 ? null : (
        <div className="fork">
          <p className="fork-q">{beat.head.ask}</p>
          <div className="fork-options" role="group" aria-label={beat.head.ask}>
            {branches.map((branch) => (
              <button key={branch.option.id} type="button" className={`fork-option${branch.chosen ? ' chosen' : ''}`} aria-pressed={branch.chosen} onClick={() => pick(branch)}>
                <span className="fork-label">{branch.option.label}</span>
                <EndPill ending={branch.ending} />
              </button>
            ))}
          </div>
        </div>
      )}
      {ending === undefined ? null : (
        <p className="end-row">
          <EndPill ending={ending} />
          {ending.to?.href === undefined ? null : (
            <a href={ending.to.href} className="end-link">
              {ending.to.title}
            </a>
          )}
        </p>
      )}
      <Internals scenario={scenario} beat={beat} laneNames={laneNames} />
      <nav className="nav" aria-label="จังหวะ">
        <button type="button" className="btn ghost" onClick={() => go(state.at - 1)} disabled={state.at === 0}>
          <span aria-hidden="true">←</span> ย้อนกลับ
        </button>
        {nav}
      </nav>
    </article>
  );
}

/* ---------- The tour ---------- */

function initialView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'lanes' ? 'lanes' : 'sequence';
  } catch {
    return 'sequence';
  }
}

export default function Story({ scenario, laneNames }: StoryProps) {
  const [state, setState] = useState<StoryState>(() => (location.hash.startsWith('#at=') ? storyFromHash(scenario, location.hash) : storyStart(scenario)));
  const [view, setView] = useState<View>(initialView);
  const beats = useMemo(() => storyBeats(scenario, state.choices), [scenario, state.choices]);
  const root = useRef<HTMLDivElement>(null);

  const go = (i: number) => setState((current) => (i < 0 || i >= beats.length ? current : { ...current, at: i }));
  const pick = (branch: Branch) => setState((current) => choose(scenario, current, branch.fork, branch.option.id));
  const restart = () => setState(storyStart(scenario));
  const switchView = (next: View) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {}
  };

  useEffect(() => {
    root.current?.closest('.story-page')?.setAttribute('data-hydrated', '');
    const restore = () => location.hash.startsWith('#at=') && setState(storyFromHash(scenario, location.hash));
    addEventListener('hashchange', restore);
    return () => removeEventListener('hashchange', restore);
  }, [scenario]);

  useEffect(() => {
    const hash = storyHash(scenario, state);
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }, [scenario, state]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]') !== null;
      if (event.altKey || event.ctrlKey || event.metaKey || typing) return;
      if (event.key === 'ArrowRight') go(state.at + 1);
      else if (event.key === 'ArrowLeft') go(state.at - 1);
      else return;
      event.preventDefault();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  const props = { scenario, beats, state, go, pick };
  return (
    <div className={`story not-content view-${view}`} ref={root}>
      <div className="story-bar">
        <div className="view-switch" role="tablist" aria-label="มุมมอง">
          <button type="button" role="tab" aria-selected={view === 'sequence'} onClick={() => switchView('sequence')}>
            Sequence
          </button>
          <button type="button" role="tab" aria-selected={view === 'lanes'} onClick={() => switchView('lanes')}>
            Swim lane
          </button>
        </div>
        <p className="story-keys">
          <kbd>←</kbd> <kbd>→</kbd> เลื่อนทีละจังหวะ
        </p>
      </div>
      <div className="story-body">
        {view === 'sequence' ? <Sequence {...props} /> : <Lanes {...props} />}
        <Reading {...props} laneNames={laneNames} restart={restart} />
      </div>
    </div>
  );
}
