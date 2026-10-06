import type { Verdict } from './approval.js';

/** Auto pauses after this many classifier blocks in a row, or this many since the total last tripped. */
export const AUTO_BLOCK_LIMITS = { row: 3, total: 20 } as const;

/**
 * Auto's state in one session. While classifying, an action the classifier will not allow is blocked and nobody is
 * asked. Once the blocks reach a limit Auto pauses, and those actions go to the user until the user allows one.
 */
export type AutoState =
  | { readonly phase: 'classifying'; readonly row: number; readonly total: number }
  | { readonly phase: 'paused'; readonly total: number };
export type AutoPhase = AutoState['phase'];

export const AUTO_START: AutoState = { phase: 'classifying', row: 0, total: 0 };

/** How a flagged action was settled: by the classifier's answer, or by the user's. */
export type AutoEvent = 'run' | 'refuse' | 'block' | 'user-allow' | 'user-reject';
type ClassifierEvent = Extract<AutoEvent, 'run' | 'refuse' | 'block'>;

/**
 * What a classifier verdict does in each phase. A classifier failure arrives as `ask`, so a dead classifier blocks,
 * counts, and reaches the user once a limit trips.
 */
export const CLASSIFIER_OUTCOMES: Readonly<Record<AutoPhase, Readonly<Record<Verdict, ClassifierEvent | 'ask-user'>>>> = {
  classifying: { allow: 'run', deny: 'refuse', ask: 'block' },
  paused: { allow: 'run', deny: 'refuse', ask: 'ask-user' },
};

export const OUTCOME_VERDICTS: Readonly<Record<ClassifierEvent, 'allow' | 'deny'>> = { run: 'allow', refuse: 'deny', block: 'deny' };

type Classifying = Extract<AutoState, { phase: 'classifying' }>;
type Paused = Extract<AutoState, { phase: 'paused' }>;

function blocked({ row, total }: Classifying): AutoState {
  // The total starts over when its own limit trips, so the next 20 blocks trip it again.
  if (total + 1 >= AUTO_BLOCK_LIMITS.total) return { phase: 'paused', total: 0 };
  if (row + 1 >= AUTO_BLOCK_LIMITS.row) return { phase: 'paused', total: total + 1 };
  return { phase: 'classifying', row: row + 1, total: total + 1 };
}

const TRANSITIONS: {
  readonly classifying: Readonly<Record<AutoEvent, (state: Classifying) => AutoState>>;
  readonly paused: Readonly<Record<AutoEvent, (state: Paused) => AutoState>>;
} = {
  classifying: {
    run: (state) => ({ ...state, row: 0 }),
    refuse: (state) => state,
    block: blocked,
    'user-allow': (state) => ({ ...state, row: 0 }),
    'user-reject': (state) => state,
  },
  paused: {
    run: (state) => state,
    refuse: (state) => state,
    // Paused sends the classifier's `ask` to the user, so nothing blocks.
    block: (state) => state,
    'user-allow': ({ total }) => ({ phase: 'classifying', row: 0, total }),
    'user-reject': (state) => state,
  },
};

export const nextAutoState = (state: AutoState, event: AutoEvent): AutoState =>
  state.phase === 'classifying' ? TRANSITIONS.classifying[event](state) : TRANSITIONS.paused[event](state);
