import { POSES, SITTING, SIZE, STAND, type Frame } from './sprite.js';

/**
 * Noodle wandering the start page, as a pure scene a tick advances. Each move is a row of MOVES: how likely it is
 * picked, how fast it goes, how long it lasts on the ground or whether gravity ends it, and its frame at each tick.
 */

export const TICK_MS = 70;
/** The start page draws Noodle at 4×. */
export const SCALE = 4;
export const SPRITE_PX = SIZE * SCALE;
/** Pixels a tick, squared. */
const GRAVITY = 3;
/** The turn's 2-sprite-pixel hop, in page pixels, frame by frame; the sprite mirrors on the fourth. */
const TURN_HOP = [0, SCALE, 2 * SCALE, 2 * SCALE, SCALE, 0] as const;
const TURN_FLIP_AT = 3;

export type Scene = {
  /** Left edge of the sprite's box, in page pixels from the stage's left. */
  readonly x: number;
  /** Height above the ground, in page pixels. */
  readonly y: number;
  /** Upward speed, in page pixels a tick. */
  readonly vy: number;
  readonly facing: 1 | -1;
  readonly move: MoveName;
  /** Ticks into the move. */
  readonly t: number;
  /** A ground move's length in ticks; airborne moves end when they land. */
  readonly ticks: number;
};

export type Stage = { readonly width: number };

type Move = {
  readonly weight: number;
  /** Page pixels a tick, the way Noodle faces. */
  readonly speed: number;
  /** Ticks on the ground, shortest and longest; or the upward speed a leap starts with. */
  readonly length: { readonly ground: readonly [number, number] } | { readonly leap: number };
  readonly frame: (t: number, scene: Scene) => Frame;
};

/** The frame of a looping list at tick `t`, honoring each frame's hold. */
function looped(frames: readonly Frame[], t: number): Frame {
  const total = frames.reduce((sum, frame) => sum + (frame.hold ?? 1), 0);
  let at = t % total;
  for (const frame of frames) {
    at -= frame.hold ?? 1;
    if (at < 0) return frame;
  }
  return frames[0]!;
}

/** Sitting: two rows lower, legs folded, with a blink and two tail flicks early in the sit. */
const seated = (over: Partial<Frame>): Frame => ({ ...STAND, dy: 2, legs: 'folded', ...over });
const SIT: readonly Frame[] = [
  seated({ hold: 6 }),
  seated({ eye: 'blink', hold: 2 }),
  seated({ hold: 6 }),
  seated({ tail: 'up', hold: 3 }),
  seated({ hold: 8 }),
  seated({ tail: 'up', hold: 3 }),
  seated({ hold: 10 }),
];

const airborne = (scene: Scene): boolean => scene.y > 0 || scene.vy > 0;

export const MOVES = {
  walk: {
    weight: 5,
    speed: 2,
    length: { ground: [20, 50] },
    frame: (t) => ({ ...STAND, legs: Math.floor(t / 2) % 2 === 0 ? 'stepA' : 'stepB', eye: t % 40 === 39 ? 'blink' : 'open' }),
  },
  run: {
    weight: 2,
    speed: 5,
    length: { ground: [12, 24] },
    frame: (t) => looped(POSES.running.loop, t),
  },
  turn: {
    weight: 1,
    speed: 0,
    length: { ground: [TURN_HOP.length, TURN_HOP.length] },
    frame: (t) => ({ ...STAND, legs: TURN_HOP[t] === 0 ? 'stand' : 'tucked' }),
  },
  jump: {
    weight: 1,
    speed: 3,
    length: { leap: 15 },
    frame: (_t, scene) => ({ ...STAND, legs: airborne(scene) ? 'tucked' : 'stand' }),
  },
  somersault: {
    weight: 1,
    speed: 2,
    length: { leap: 18 },
    // A full turn over the time in the air: four quarters, a quarter each three ticks.
    frame: (t, scene) => ({ ...STAND, legs: 'tucked', quarter: airborne(scene) ? (Math.min(3, Math.floor(t / 3)) as 0 | 1 | 2 | 3) : 0 }),
  },
  sit: {
    weight: 2,
    speed: 0,
    length: { ground: [40, 70] },
    frame: (t) => looped(SIT, t),
  },
  wave: {
    weight: 1,
    speed: 0,
    length: { ground: [18, 24] },
    frame: (t) => ({ ...SITTING, arms: Math.floor(t / 3) % 2 === 0 ? 'up' : 'out' }),
  },
  flex: {
    weight: 1,
    speed: 0,
    length: { ground: [16, 22] },
    frame: (t) => looped(POSES.flex.loop.filter((frame) => frame.arms === 'flex'), t),
  },
} as const satisfies Record<string, Move>;
export type MoveName = keyof typeof MOVES;
export const MOVE_NAMES = Object.keys(MOVES) as readonly MoveName[];

const TOTAL_WEIGHT = MOVE_NAMES.reduce((sum, name) => sum + MOVES[name].weight, 0);

/** A weighted pick: `random()` in [0, 1) falls in one move's share of the total weight. */
export function pickMove(random: () => number): MoveName {
  let at = random() * TOTAL_WEIGHT;
  for (const name of MOVE_NAMES) {
    at -= MOVES[name].weight;
    if (at < 0) return name;
  }
  return 'walk';
}

/** Starts `move` where the scene stands. */
export function begin(scene: Scene, move: MoveName, random: () => number): Scene {
  const { length } = MOVES[move] as Move;
  if ('leap' in length) return { ...scene, move, t: 0, ticks: 0, vy: length.leap };
  const [shortest, longest] = length.ground;
  return { ...scene, move, t: 0, ticks: shortest + Math.floor(random() * (longest - shortest + 1)), vy: 0, y: 0 };
}

/** Where Noodle starts: standing in the middle, about to walk. */
export const start = (stage: Stage): Scene => ({ x: Math.max(0, Math.round((stage.width - SPRITE_PX) / 2)), y: 0, vy: 0, facing: 1, move: 'walk', t: 0, ticks: 30 });

/** One tick. A move that ends, or a walk into the stage's edge, hands over to the next move. */
export function next(scene: Scene, stage: Stage, random: () => number): Scene {
  const move = MOVES[scene.move] as Move;
  const right = Math.max(0, stage.width - SPRITE_PX);
  const t = scene.t + 1;

  if (scene.move === 'turn') {
    if (t >= TURN_HOP.length) return begin({ ...scene, y: 0 }, 'walk', random);
    return { ...scene, t, y: TURN_HOP[t]!, facing: t === TURN_FLIP_AT ? (-scene.facing as 1 | -1) : scene.facing };
  }

  const wanted = scene.x + scene.facing * move.speed;
  const x = Math.min(right, Math.max(0, wanted));
  const leaping = 'leap' in move.length;
  if (!leaping && wanted !== x) return begin({ ...scene, x }, 'turn', random);

  if (leaping) {
    const y = scene.y + scene.vy;
    if (y <= 0 && t > 1) return begin({ ...scene, x, y: 0, vy: 0 }, pickMove(random), random);
    return { ...scene, x, t, y: Math.max(0, y), vy: scene.vy - GRAVITY };
  }
  if (t >= scene.ticks) return begin({ ...scene, x }, pickMove(random), random);
  return { ...scene, x, t };
}

/** A click on Noodle: a somersault, unless it is already in the air. */
export const poke = (scene: Scene, random: () => number): Scene => (airborne(scene) || scene.move === 'turn' ? scene : begin(scene, 'somersault', random));

/** What to draw for the scene: the move's frame, mirrored while facing left. */
export function frameOf(scene: Scene): Frame {
  const frame = (MOVES[scene.move] as Move).frame(scene.t, scene);
  return scene.facing < 0 ? { ...frame, flip: true } : frame;
}
