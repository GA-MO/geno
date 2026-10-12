import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Scenario } from '../scenario/model.js';
import {
  ACTOR_NAME,
  ACTORS,
  actorsOn,
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
  rowCenter,
  type LaneEdge,
  type LaneItem,
  type LaneLayout,
  type Point,
  type StoryState,
} from '../scenario/story.js';
import Sees, { Code, showsToolUse } from './Mock.js';

export interface StoryProps {
  readonly scenario: Scenario;
  /** English lane names for the internals, by lane id. */
  readonly laneNames: Readonly<Record<string, string>>;
}

type View = 'sequence' | 'lanes';
const VIEW_KEY = 'geno-docs:tour-view';
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
        {actorsOn(scenario.surface).map((actor) => (
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

type Tone = 'past' | 'current' | 'future' | 'other';
const TONES: readonly Tone[] = ['past', 'current', 'future', 'other'];

/** An orthogonal polyline with each corner rounded by up to `radius`, never more than half of either leg. */
function rounded(points: readonly Point[], radius = 8): string {
  const [first, ...rest] = points;
  let d = `M ${first!.x} ${first!.y}`;
  rest.forEach((corner, k) => {
    const next = rest[k + 1];
    if (next === undefined) {
      d += ` L ${corner.x} ${corner.y}`;
      return;
    }
    const prev = k === 0 ? first! : rest[k - 1]!;
    const r = Math.min(radius, Math.hypot(corner.x - prev.x, corner.y - prev.y) / 2, Math.hypot(next.x - corner.x, next.y - corner.y) / 2);
    const inX = Math.sign(corner.x - prev.x) * r;
    const inY = Math.sign(corner.y - prev.y) * r;
    const outX = Math.sign(next.x - corner.x) * r;
    const outY = Math.sign(next.y - corner.y) * r;
    d += ` L ${corner.x - inX} ${corner.y - inY} Q ${corner.x} ${corner.y} ${corner.x + outX} ${corner.y + outY}`;
  });
  return d;
}

function Overview({ layout, at, view, jump }: { readonly layout: LaneLayout; readonly at: number; readonly view: { readonly left: number; readonly width: number }; readonly jump: (x: number) => void }) {
  return (
    <div
      className="ln-overview"
      title="ภาพรวมทั้งทัวร์: คลิกเพื่อไปที่จังหวะนั้น"
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        jump(((event.clientX - box.left) / box.width) * layout.width);
      }}
    >
      <svg viewBox={`0 0 ${layout.width} ${layout.rows}`} preserveAspectRatio="none" aria-hidden="true">
        {layout.items.map((item, index) =>
          item.kind === 'receiver' ? null : (
            <rect key={index} className={`ov-${item.kind === 'beat' ? place(item.beat, at) : 'mark'}`} x={item.x} y={item.row + 0.22} width={item.w} height={0.56} />
          ),
        )}
        <rect className="ov-view" x={view.left} y={0} width={view.width} height={layout.rows} vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

/**
 * Mouse drag pans the lanes and a flick keeps them gliding with friction, like a trackpad. A drag past a few pixels
 * swallows the click it ends with, so it never opens a beat.
 */
function useDragScroll(ref: { readonly current: HTMLDivElement | null }): void {
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    let start: { readonly x: number; readonly left: number } | undefined;
    let samples: { readonly x: number; readonly t: number }[] = [];
    let dragged = false;
    let frame = 0;
    const stopGlide = () => cancelAnimationFrame(frame);
    const glide = (velocity: number) => {
      let v = velocity;
      let last = performance.now();
      const step = (now: number) => {
        const dt = Math.min(now - last, 32);
        last = now;
        element.scrollLeft -= v * dt;
        v *= Math.pow(GLIDE_FRICTION, dt / 16);
        const atEdge = element.scrollLeft <= 0 || element.scrollLeft >= element.scrollWidth - element.clientWidth;
        if (Math.abs(v) > GLIDE_STOP && !atEdge) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    };
    const down = (event: PointerEvent) => {
      stopGlide();
      if (event.pointerType !== 'mouse' || event.button !== 0) return;
      start = { x: event.clientX, left: element.scrollLeft };
      samples = [{ x: event.clientX, t: event.timeStamp }];
      dragged = false;
    };
    const move = (event: PointerEvent) => {
      if (start === undefined) return;
      const dx = event.clientX - start.x;
      if (!dragged && Math.abs(dx) < 4) return;
      if (!dragged) element.setPointerCapture(event.pointerId);
      dragged = true;
      element.classList.add('dragging');
      element.scrollLeft = start.left - dx;
      samples.push({ x: event.clientX, t: event.timeStamp });
      samples = samples.filter((sample) => event.timeStamp - sample.t <= VELOCITY_WINDOW_MS * 2);
    };
    const up = (event: PointerEvent) => {
      if (start === undefined) return;
      start = undefined;
      element.classList.remove('dragging');
      const last = samples.at(-1);
      if (!dragged || last === undefined || reduced() || event.timeStamp - last.t > HELD_BEFORE_RELEASE_MS) return;
      const recent = samples.filter((sample) => last.t - sample.t <= VELOCITY_WINDOW_MS);
      const first = recent[0]!;
      if (last.t > first.t) glide((last.x - first.x) / (last.t - first.t));
    };
    const click = (event: MouseEvent) => {
      if (!dragged) return;
      dragged = false;
      event.stopPropagation();
      event.preventDefault();
    };
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
    element.addEventListener('wheel', stopGlide, { passive: true });
    element.addEventListener('click', click, true);
    return () => {
      stopGlide();
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
      element.removeEventListener('wheel', stopGlide);
      element.removeEventListener('click', click, true);
    };
  }, [ref]);
}

const VELOCITY_WINDOW_MS = 100;
const HELD_BEFORE_RELEASE_MS = 60;
const GLIDE_FRICTION = 0.94;
const GLIDE_STOP = 0.02;

function Lanes({ scenario, beats, state, go, pick }: { readonly scenario: Scenario; readonly beats: readonly Beat[]; readonly state: StoryState; readonly go: (i: number) => void; readonly pick: (branch: Branch) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => layoutLanes(scenario, state.choices, beats), [scenario, state.choices, beats]);
  useDragScroll(scroller);
  const [view, setView] = useState({ left: 0, width: 0 });
  const track = () => {
    const element = scroller.current;
    if (element !== null) setView({ left: element.scrollLeft, width: element.clientWidth });
  };
  const centerOn = (x: number) => {
    const element = scroller.current;
    if (element !== null) element.scrollTo({ left: x - element.clientWidth / 2, behavior: reduced() ? 'auto' : 'smooth' });
  };
  const current = layout.items.find((item) => item.kind === 'beat' && item.beat === state.at);
  useLayoutEffect(() => {
    if (current !== undefined) centerOn(current.x + current.w / 2);
    track();
  }, [state.at, layout]);
  useEffect(() => {
    addEventListener('resize', track);
    return () => removeEventListener('resize', track);
  }, []);

  const toneOf = (item: LaneItem): Tone => (item.kind === 'branch' && !item.branch.chosen ? 'other' : place(item.beat, state.at));
  const edgeTone = (edge: LaneEdge): Tone => (edge.kind === 'branch' ? toneOf(layout.items[edge.to]!) : place(edge.beat, state.at));
  const order: Readonly<Record<Tone, number>> = { other: 0, future: 1, past: 2, current: 3 };
  const jump = (x: number) => {
    const nodes = layout.items.filter((item) => item.kind === 'beat');
    const nearest = nodes.reduce((best, item) => (Math.abs(item.x + item.w / 2 - x) < Math.abs(best.x + best.w / 2 - x) ? item : best));
    go(nearest.beat);
  };
  const rows = [...Array(layout.rows).keys()];
  const actors = actorsOn(scenario.surface);
  return (
    <section className="lanes tour-card" aria-label="Swim lanes">
      <div className="ln-frame">
        <div className="ln-labels" aria-hidden="true">
          {rows.map((row) => (
            <p key={row} className={`ln-caption${row % 2 === 1 ? ' alt' : ''}`} style={{ height: LANE.height }}>
              {actors[row] === undefined ? null : (
                <>
                  <strong>{actors[row].name}</strong>
                  <span>{actors[row].sub}</span>
                </>
              )}
            </p>
          ))}
        </div>
        <div className="ln-scroll" ref={scroller} onScroll={track}>
          <div className="ln-canvas" style={{ width: layout.width, height: layout.height }}>
            {rows.map((row) => (
              <div key={row} className={`ln-band${row % 2 === 1 ? ' alt' : ''}`} style={{ top: row * LANE.height, height: LANE.height }} />
            ))}
            <svg className="ln-svg" width={layout.width} height={layout.height} aria-hidden="true">
              <defs>
                {(['message', 'flow'] as const).flatMap((kind) =>
                  TONES.map((tone) => (
                    <marker key={`${kind}-${tone}`} id={`ah-${kind}-${tone}`} className={`ah ah-${kind} ah-${tone}`} viewBox="0 0 10 10" refX="10" refY="5" markerUnits="userSpaceOnUse" markerWidth={kind === 'flow' ? 7 : 9} markerHeight={kind === 'flow' ? 7 : 9} orient="auto">
                      <path d="M0 0.5 L10 5 L0 9.5 z" />
                    </marker>
                  )),
                )}
              </defs>
              {layout.edges
                .map((edge) => ({ edge, tone: edgeTone(edge) }))
                .sort((a, b) => order[a.tone] - order[b.tone])
                .map(({ edge, tone }) => (
                  <path key={`${edge.from}-${edge.to}`} className={`edge e-${edge.kind} e-${tone}`} d={rounded(edge.points)} markerEnd={`url(#ah-${edge.kind === 'flow' ? 'flow' : 'message'}-${tone})`} />
                ))}
            </svg>
            {layout.items.map((item, index) => {
              const style: CSSProperties = { left: item.x, top: rowCenter(item.row), width: item.w };
              if (item.kind === 'end')
                return (
                  <div key={index} className={`ln-end ${toneOf(item)}`} style={style}>
                    <EndPill ending={item.ending} />
                  </div>
                );
              if (item.kind === 'branch') {
                const { option, ending, chosen } = item.branch;
                return (
                  <button key={index} type="button" className={`ln-chip ${toneOf(item)}`} style={style} onClick={() => pick(item.branch)} aria-pressed={chosen} title={chosen ? option.label : `เดินทาง ${option.label}: ${ending.label}`}>
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
              const beat = beats[item.beat]!;
              const label = `จังหวะที่ ${item.beat + 1}: ${beat.head.title.replace(/`/g, '')}`;
              if (item.kind === 'decision')
                return (
                  <button key={index} type="button" className={`ln-diamond ${place(item.beat, state.at)}`} style={{ ...style, height: item.h }} onClick={() => go(item.beat)} aria-label={`${label}: ${beat.head.ask}`} title={beat.head.ask}>
                    <span className="dm-shape" aria-hidden="true" />
                    <span className="dm-t">{beat.head.ask}</span>
                  </button>
                );
              if (item.kind === 'receiver')
                return (
                  <button key={index} type="button" className={`ln-recv ${place(item.beat, state.at)}`} style={{ ...style, height: item.h }} onClick={() => go(item.beat)} aria-label={`${label}: ถึง ${ACTOR_NAME[beat.to]}`} title={`ถึง ${ACTOR_NAME[beat.to]}`} />
                );
              return (
                <button key={index} type="button" className={`ln-node ${place(item.beat, state.at)} w-${beat.who}`} style={style} onClick={() => go(item.beat)} aria-current={item.beat === state.at ? 'step' : undefined} title={label}>
                  <span className="ln-t">
                    <span className="ln-num">{item.beat + 1}</span>
                    <Code text={beat.head.title} />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <Overview layout={layout} at={state.at} view={view} jump={jump} />
      <p className="ln-legend">
        <span><i className="lg-node" /> จังหวะ อยู่ใน lane ของผู้ทำ</span>
        <span><i className="lg-recv" /> ผู้รับของจังหวะนั้น</span>
        <span><i className="lg-current" /> จังหวะที่กำลังอ่าน</span>
        <span>ลากที่แผนภาพเพื่อเลื่อน</span>
      </p>
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
      <Sees shown={beat.head.sees} legend={beats.findIndex((candidate) => showsToolUse(candidate.head.sees)) === state.at} />
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
    <div className={`story not-prose view-${view}`} ref={root}>
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
