import type { StepId } from '../scenario/model.js';
import type { Beat, StoryState } from '../scenario/story.js';

/**
 * Motion on the tour diagram. The views tag the current beat's elements with a role (`data-mo`); a fork's chips and
 * branch arrows also carry the fork they belong to (`data-mo-fork`) and move only when the reader picks at that fork.
 * Every animation is a Web Animation with no forward fill, so cancelling one leaves the element in its resting CSS
 * state: a new beat cancels the last beat's motion and nothing ever lags behind the reader.
 */
export type Role = 'draw-x' | 'draw-y' | 'draw-path' | 'ride' | 'land' | 'label' | 'recede' | 'end';

/** What changed between two story states: a step to another beat and the forks whose choice changed. */
export interface Cue {
  readonly forks: readonly StepId[];
}

export function cueOf(prev: StoryState, next: StoryState): Cue | undefined {
  const keys = new Set([...Object.keys(prev.choices), ...Object.keys(next.choices)] as StepId[]);
  const forks = [...keys].filter((fork) => prev.choices[fork] !== next.choices[fork]);
  return prev.at === next.at && forks.length === 0 ? undefined : { forks };
}

/** What the play button does next on the current beat: wait for the reader at a fork, stop at the end. */
export type AutoStep = { readonly kind: 'advance'; readonly after: number } | { readonly kind: 'wait' } | { readonly kind: 'stop' };

export function autoStep(beats: readonly Beat[], at: number): AutoStep {
  const beat = beats[at];
  if (beat === undefined || at === beats.length - 1) return { kind: 'stop' };
  if (beat.flow.kind === 'fork') return { kind: 'wait' };
  return { kind: 'advance', after: dwell(beat) };
}

/** Time to read a beat's title and text, about 25 Thai characters a second, between 2.5 and 10 seconds. */
export function dwell(beat: Beat): number {
  const chars = [...`${beat.head.title}${beat.head.text}`.replace(/`/g, '')].length;
  return Math.round(Math.min(10_000, Math.max(2_500, 1_200 + chars * 40)));
}

const TRAVEL = 520;
const EASE = 'cubic-bezier(0.45, 0, 0.2, 1)';

interface Plan {
  readonly keyframes: Keyframe[];
  readonly delay?: number;
  readonly duration: number;
  readonly easing?: string;
  readonly pseudoElement?: string;
  /** The element that moves, when it is not the tagged one. */
  readonly target?: Element;
}

/** Samples a path into translate keyframes at even lengths, so the rider keeps one speed through the corners. */
function along(path: SVGGeometryElement): Keyframe[] {
  const length = path.getTotalLength();
  const samples = Math.max(2, Math.ceil(length / 12));
  return Array.from({ length: samples + 1 }, (_, k) => {
    const point = path.getPointAtLength((length * k) / samples);
    return { transform: `translate(${point.x}px, ${point.y}px)`, opacity: k === samples ? 0.4 : 1 };
  });
}

const PLANS: Readonly<Record<Role, (element: Element, root: Element) => Plan | undefined>> = {
  'draw-x': () => ({ keyframes: [{ scale: '0 1' }, { scale: '1 1' }], duration: TRAVEL }),
  'draw-y': () => ({ keyframes: [{ scale: '1 0' }, { scale: '1 1' }], duration: TRAVEL * 0.8 }),
  // The arrowhead is a marker on the path's end; it stays off until the line reaches it, then the path's own
  // marker-end returns as the animation ends.
  'draw-path': (element) => {
    const length = (element as SVGGeometryElement).getTotalLength();
    const dash = `${length} ${length}`;
    return { keyframes: [{ strokeDasharray: dash, strokeDashoffset: length, markerEnd: 'none' }, { strokeDasharray: dash, strokeDashoffset: 0, markerEnd: 'none' }], duration: TRAVEL };
  },
  ride: (element, root) => {
    const rail = (element as HTMLElement).dataset['rail'];
    if (rail !== undefined) {
      const path = root.querySelector(`[id="${rail}"]`);
      return path instanceof SVGGeometryElement ? { keyframes: along(path), duration: TRAVEL } : undefined;
    }
    const end = (element as HTMLElement).dataset['dir'] === 'left' ? '-100%' : '100%';
    return { keyframes: [{ transform: 'translateX(0)', opacity: 1 }, { transform: `translateX(${end})`, opacity: 1, offset: 0.92 }, { transform: `translateX(${end})`, opacity: 0 }], duration: TRAVEL + 60 };
  },
  land: () => ({ keyframes: [{ opacity: 0.25, scale: '0.7' }, { opacity: 1, scale: '1.12', offset: 0.55 }, { opacity: 1, scale: '1' }], delay: TRAVEL * 0.85, duration: 340, easing: 'ease-out' }),
  label: () => ({ keyframes: [{ opacity: 0.2 }, { opacity: 1 }], delay: TRAVEL * 0.55, duration: 260, easing: 'ease-out' }),
  recede: () => ({ keyframes: [{ opacity: 1 }], duration: 360, easing: 'ease-out' }),
  end: (element) => {
    const pill = element.querySelector('.end');
    return pill === null ? undefined : { target: pill, pseudoElement: '::after', keyframes: [{ opacity: 0.6, scale: '1' }, { opacity: 0, scale: '1.45 1.9' }], delay: TRAVEL, duration: 900, easing: 'ease-out' };
  },
};

/** Starts the cue's motion under `root` and returns the running animations so the next cue can cancel them. */
export function perform(root: Element, cue: Cue): Animation[] {
  const animations: Animation[] = [];
  for (const element of root.querySelectorAll<HTMLElement | SVGElement>('[data-mo]')) {
    const fork = element.dataset['moFork'];
    if (fork !== undefined && !cue.forks.includes(fork as StepId)) continue;
    const plan = PLANS[element.dataset['mo'] as Role](element, root);
    if (plan === undefined) continue;
    const target = plan.target ?? element;
    animations.push(target.animate(plan.keyframes, { duration: plan.duration, delay: plan.delay ?? 0, easing: plan.easing ?? EASE, fill: 'backwards', ...(plan.pseudoElement === undefined ? {} : { pseudoElement: plan.pseudoElement }) }));
  }
  return animations;
}
