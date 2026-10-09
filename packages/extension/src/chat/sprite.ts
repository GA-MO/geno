/**
 * Noodle as data: a 24 by 24 grid of palette letters, built from the Box A body and overlays for its parts, and
 * a table of poses, each a list of frames. Nothing here draws; the renderer paints a grid to a canvas or to SVG.
 * A new pose is a new row in POSES, and a new eye, prop or mark a new row in its part table.
 */

export const SIZE = 24;

/** One letter per color, so a grid reads as pixel art. `.` is clear. */
export const PALETTE = {
  g: '#5fc79a',
  w: '#ffffff',
  k: '#14231f',
  y: '#ffd166',
  b: '#5cc8ff',
  a: '#f5a524',
  n: '#b9824f',
  s: '#9aa5b1',
  r: '#ff7eb6',
  c: '#6ad7ff',
  /** The peek's knuckles. */
  d: '#4fae86',
} as const;
export type Ink = keyof typeof PALETTE;

/** Rows of palette letters, top to bottom, SIZE by SIZE. */
export type Grid = readonly string[];

/** Pixel art placed with its top-left corner at (x, y); `.` leaves what is under it. */
type Stamp = { readonly x: number; readonly y: number; readonly art: readonly string[] };

/** Box A facing right, without the parts that move: no eye, tail or legs. */
const BODY: Grid = [
  '........................',
  '.............ggggggggg..',
  '.............ggggggggg..',
  '.............ggggggggg..',
  '.............ggggggggg..',
  '.............ggggggggg..',
  '.............ggggggggg..',
  '.............gggg.......',
  '.............gggg.......',
  '.............gggg.......',
  '.............gggg.......',
  '.............gggg.......',
  '...ggggggggggggggg......',
  '...ggggggggggggggg......',
  '...ggggggggggggggg......',
  '...ggggggggggggggg......',
  '...ggggggggggggggg......',
  '...ggwwwwwwwwwwwgg......',
  '...ggwwwwwwwwwwwgg......',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
];

/** Box A up on its haunches or hind legs, the same head and neck over an upright chest whose white belly faces front. */
const UPRIGHT: Grid = [
  ...BODY.slice(0, 12),
  '.........gggggggg.......',
  '........ggggggggg.......',
  '........ggggggwwg.......',
  '........ggggggwwg.......',
  '........ggggggwwg.......',
  '........ggggggwwg.......',
  '........ggggggwwg.......',
  '........................',
  '........................',
  '........................',
  '........................',
  '........................',
];

const BODIES = { four: BODY, upright: UPRIGHT } as const;
export type Body = keyof typeof BODIES;

/** A part table, its names taken from its keys. */
const parts = <K extends string>(table: Readonly<Record<K, readonly Stamp[]>>) => table;

const EYES = parts({
  open: [{ x: 17, y: 3, art: ['wk'] }],
  blink: [{ x: 17, y: 3, art: ['kk'] }],
  left: [{ x: 17, y: 3, art: ['kw'] }],
  down: [{ x: 17, y: 4, art: ['wk'] }],
  downLeft: [{ x: 17, y: 4, art: ['kw'] }],
  up: [{ x: 17, y: 2, art: ['wk'] }],
  upLeft: [{ x: 17, y: 2, art: ['kw'] }],
  happy: [{ x: 16, y: 3, art: ['.kk.', 'k..k'] }],
});
export type Eye = keyof typeof EYES;

const TAILS = parts({
  down: [{ x: 0, y: 14, art: ['ggg', 'ggg'] }],
  up: [{ x: 0, y: 11, art: ['g..', 'gg.', 'ggg'] }],
  /** Upright: laid along the ground behind, a counterweight; then its tip flicked up. */
  rest: [{ x: 0, y: 18, art: ['.....gggg', '..ggggggg', 'ggggg....'] }],
  restUp: [{ x: 0, y: 16, art: ['g........', 'g........', '.gg..gggg', '...gggggg'] }],
});
export type Tail = keyof typeof TAILS;

const LEGS = parts({
  stand: [{ x: 4, y: 19, art: ['ggg......ggg', 'ggg......ggg', 'ggg......ggg'] }],
  stepA: [{ x: 2, y: 19, art: ['..ggg......ggg', '.ggg........ggg', 'ggg..........ggg'] }],
  stepB: [{ x: 2, y: 19, art: ['..ggg......ggg', '...ggg....ggg', '....ggg..ggg'] }],
  tucked: [{ x: 4, y: 19, art: ['ggg......ggg', '.ggg......ggg'] }],
  /** Sitting: drawn under a body lowered two rows, the feet forward. */
  folded: [{ x: 4, y: 19, art: ['gggggg...gggggg'] }],
  /** Upright, sat on its haunches: the thigh's curve in a darker green, the foot forward along the ground. */
  haunch: [{ x: 6, y: 16, art: ['...dd', '.g...d', 'gg....d', 'ggggggdgwwg', 'gggggggggggggg', '.gggggggggggggg'] }],
  /** Upright, stood on its hind legs, the far one darker. */
  rear: [{ x: 8, y: 19, art: ['.ddd.ggg', '.ddd.ggg', '.ddd.ggggg'] }],
});
export type Legs = keyof typeof LEGS;

/** The forelegs of the upright body, from its shoulder; the far one, when it shows, is the darker green. */
const ARMS = parts({
  none: [],
  /** A wave: the near paw up, then out, from a foreleg that crosses the belly. */
  up: [{ x: 14, y: 8, art: ['....g.g', '....ggg', '.....g.', '.....g.', '....g..', '...g...', 'ggg....'] }],
  out: [{ x: 14, y: 9, art: ['.....g.g', '.....ggg', '......g.', '.....g..', '...gg...', 'ggg.....'] }],
  flex: [
    { x: 9, y: 8, art: ['d..', 'd..', 'ddd', '..d'] },
    { x: 17, y: 9, art: ['..g', '..g', 'ggg', 'g..'] },
  ],
  /**
   * The near foreleg crosses the white belly so it reads apart from the chest. Holding a notebook or clipboard: the
   * near paw at its lower left, the far one on its right edge.
   */
  hold: [
    { x: 14, y: 13, art: ['...gg', '..ggg', 'ggg..'] },
    { x: 23, y: 13, art: ['d', 'd'] },
  ],
  /** Typing: the paw down on the keys, then lifted. */
  tapA: [{ x: 14, y: 15, art: ['gggg', '...g', '...gg'] }],
  tapB: [{ x: 14, y: 14, art: ['gggg', '...g', '...gg'] }],
  /** Writing: the paw on the pencil, where the pad's `pencil` puts it. */
  pen0: [{ x: 14, y: 14, art: ['ggggg'] }],
  pen1: [{ x: 14, y: 14, art: ['gggggg'] }],
  pen2: [{ x: 14, y: 14, art: ['ggggggg'] }],
});
export type Arms = keyof typeof ARMS;

const MARKS = parts({
  dots1: [{ x: 11, y: 5, art: ['s'] }],
  dots2: [
    { x: 11, y: 5, art: ['s'] },
    { x: 8, y: 3, art: ['ss', 'ss'] },
  ],
  dots3: [
    { x: 11, y: 5, art: ['s'] },
    { x: 8, y: 3, art: ['ss', 'ss'] },
    { x: 4, y: 0, art: ['sss', 'sss'] },
  ],
  question: [{ x: 8, y: 2, art: ['aaa', '..a', '.a.', '...', '.a.'] }],
  sweat: [{ x: 11, y: 2, art: ['.b', 'bb', 'bb'] }],
  sparkle: [{ x: 20, y: 7, art: ['.y.', 'yyy', '.y.'] }],
  dust: [{ x: 0, y: 19, art: ['s..', '.s.', 's.s'] }],
});
export type Mark = keyof typeof MARKS;

const GLASSES: readonly Stamp[] = [{ x: 16, y: 2, art: ['kkkk', 'k..k', 'k..k', 'kkkk'] }];

export type Prop =
  | { readonly kind: 'notebook'; readonly page: 0 | 1 }
  | { readonly kind: 'pad'; readonly pencil: 0 | 1 | 2 }
  /** `rise` rows still below the lap, `lid` rows of open lid (0 is shut), `lines` of code on the screen. */
  | { readonly kind: 'laptop'; readonly rise: number; readonly lid: number; readonly lines: number }
  | { readonly kind: 'clipboard'; readonly ticks: number };

type PropOf<K extends Prop['kind']> = Extract<Prop, { kind: K }>;

const CODE: readonly { readonly ink: Ink; readonly length: number }[] = [
  { ink: 'c', length: 3 },
  { ink: 'r', length: 2 },
  { ink: 'y', length: 3 },
  { ink: 'c', length: 1 },
];

const NOTEBOOK_PAGES: Readonly<Record<0 | 1, readonly string[]>> = {
  0: ['.......', '.......', 'wwwkwww', 'wsskssw', 'wwwkwww', 'wsskssw', 'nnnnnnn'],
  1: ['....w..', '....ww.', 'wwwkwww', 'wsskwww', 'wwwkwww', 'wsskwww', 'nnnnnnn'],
};

const PROPS: { readonly [K in Prop['kind']]: (prop: PropOf<K>) => readonly Stamp[] } = {
  notebook: ({ page }) => [{ x: 17, y: 9, art: NOTEBOOK_PAGES[page] }],
  pad: ({ pencil }) => [
    { x: 17, y: 16, art: ['wwwwwww', 'nnnnnnn'] },
    { x: 18 + pencil, y: 13, art: ['..y', '.y.', 'k..'] },
  ],
  laptop: ({ rise, lid, lines }) => {
    const base = 18 + rise;
    if (lid === 0) return [{ x: 14, y: base - 1, art: ['ssssssssss', 'ssssssssss'] }];
    const screen = Array.from({ length: lid }, (_, row) => {
      if (row === 0 || (lid > 2 && row === lid - 1)) return 'sssss';
      const code = CODE[row - 1];
      const lit = code !== undefined && row - 1 < lines ? code.ink.repeat(code.length) : '';
      return `s${lit.padEnd(3, 'k')}s`;
    });
    return [
      { x: 19, y: base - lid, art: screen },
      { x: 14, y: base, art: ['ssssssssss'] },
    ];
  },
  clipboard: ({ ticks }) => [
    { x: 18, y: 9, art: ['..kk..', 'nnnnnn', 'nwwwwn', 'nwsssn', 'nwwwwn', 'nwsssn', 'nwwwwn', 'nwsssn', 'nnnnnn'] },
    ...[12, 14, 16].slice(0, ticks).map((y) => ({ x: 19, y, art: ['g'] })),
  ],
};

/** One picture of Noodle: its parts, then shifts and turns of the whole sprite. */
export type Frame = {
  readonly body?: Body;
  readonly eye: Eye;
  readonly tail: Tail;
  readonly legs: Legs;
  readonly arms: Arms;
  readonly prop?: Prop;
  readonly glasses?: boolean;
  readonly marks?: readonly Mark[];
  /** Rows the whole sprite moves down; negative moves it up. */
  readonly dy?: number;
  /** Clockwise quarter turns, drawn before the mirror, so a mirrored somersault still rolls forward. */
  readonly quarter?: 0 | 1 | 2 | 3;
  /** Faces left. */
  readonly flip?: boolean;
  /** Ticks this frame stays on screen; one by default. */
  readonly hold?: number;
};

/** A pose plays its intro once, then its loop; a `once` pose stops on its last frame. */
export type Pose<F = Frame> = { readonly intro?: readonly F[]; readonly loop: readonly F[]; readonly once?: true };

export const STAND: Frame = { eye: 'open', tail: 'down', legs: 'stand', arms: 'none' };
const f = (over: Partial<Frame>): Frame => ({ ...STAND, ...over });

const poseTable = <K extends string>(table: Readonly<Record<K, Pose>>) => table;

/** On its haunches, forelegs free for what it holds. */
export const SITTING: Frame = { ...STAND, body: 'upright', legs: 'haunch', tail: 'rest' };
const sat = (over: Partial<Frame>): Frame => ({ ...SITTING, ...over });

const reared = (over: Partial<Frame>): Frame => f({ body: 'upright', legs: 'rear', tail: 'rest', arms: 'flex', eye: 'happy', ...over });

const laptop = (rise: number, lid: number, lines = 0): Prop => ({ kind: 'laptop', rise, lid, lines });

export const POSES = poseTable({
  idle: {
    loop: [f({ hold: 30 }), f({ eye: 'blink', hold: 2 }), f({ hold: 20 }), f({ tail: 'up', hold: 3 }), f({ hold: 4 }), f({ tail: 'up', hold: 3 }), f({ hold: 10 })],
  },
  thinking: {
    loop: [f({ eye: 'up', hold: 4 }), f({ eye: 'up', marks: ['dots1'], hold: 4 }), f({ eye: 'up', marks: ['dots2'], hold: 4 }), f({ eye: 'up', marks: ['dots3'], hold: 6 })],
  },
  reading: {
    loop: [
      sat({ eye: 'down', arms: 'hold', prop: { kind: 'notebook', page: 0 }, hold: 6 }),
      sat({ eye: 'downLeft', arms: 'hold', prop: { kind: 'notebook', page: 0 }, hold: 6 }),
      sat({ eye: 'down', arms: 'hold', prop: { kind: 'notebook', page: 0 }, tail: 'restUp', hold: 6 }),
      sat({ eye: 'downLeft', arms: 'hold', prop: { kind: 'notebook', page: 0 }, hold: 6 }),
      sat({ eye: 'down', arms: 'hold', prop: { kind: 'notebook', page: 1 }, hold: 3 }),
    ],
  },
  coding: {
    intro: [
      sat({ eye: 'down', prop: laptop(3, 0), hold: 2 }),
      sat({ eye: 'down', prop: laptop(2, 0), hold: 2 }),
      sat({ eye: 'down', prop: laptop(1, 0), hold: 2 }),
      sat({ eye: 'down', prop: laptop(0, 0), hold: 2 }),
      sat({ eye: 'down', prop: laptop(0, 2) }),
      sat({ eye: 'down', prop: laptop(0, 4) }),
      sat({ eye: 'down', prop: laptop(0, 6), hold: 3 }),
      sat({ eye: 'down', prop: laptop(0, 6), glasses: true, hold: 4 }),
    ],
    loop: [1, 2, 3, 4, 4, 4].flatMap((lines) => [
      sat({ eye: 'down', glasses: true, arms: 'tapA', prop: laptop(0, 6, lines), hold: 2 }),
      sat({ eye: 'down', glasses: true, arms: 'tapB', prop: laptop(0, 6, lines), hold: 2 }),
    ]),
  },
  writing: {
    loop: ([0, 1, 2, 1] as const).map((pencil) => sat({ eye: 'down', arms: `pen${pencil}`, prop: { kind: 'pad', pencil }, hold: 3 })),
  },
  running: {
    loop: [f({ legs: 'stepA', marks: ['dust'] }), f({ legs: 'stepB', dy: -1 }), f({ legs: 'stepA' }), f({ legs: 'stepB', dy: -1, marks: ['dust'] })],
  },
  planning: {
    loop: [0, 1, 2, 3].map((ticks) => sat({ eye: 'down', arms: 'hold', prop: { kind: 'clipboard', ticks }, hold: ticks === 3 ? 10 : 6 })),
  },
  asking: {
    loop: [f({ eye: 'up', marks: ['question'], hold: 4 }), f({ eye: 'up', marks: ['question'], dy: -1, hold: 4 })],
  },
  hop: {
    once: true,
    loop: [f({ legs: 'tucked', dy: -1, hold: 2 }), f({ legs: 'tucked', dy: -1, marks: ['sparkle'], hold: 2 }), f({ marks: ['sparkle'], hold: 3 }), f({ hold: 1 })],
  },
  /** Up on its hind legs, both forelegs raised. */
  flex: {
    once: true,
    loop: [
      reared({ hold: 2 }),
      reared({ marks: ['sparkle'], hold: 3 }),
      reared({ hold: 2 }),
      reared({ marks: ['sparkle'], hold: 3 }),
      f({ hold: 1 }),
    ],
  },
  sweat: {
    loop: [f({ marks: ['sweat'], hold: 12 }), f({ eye: 'blink', marks: ['sweat'], hold: 2 })],
  },
  /** A roll in the air, a quarter turn at a time, so the pixels stay whole; it lands upright with a sparkle. */
  somersault: {
    once: true,
    loop: [
      f({ legs: 'tucked', dy: -1, hold: 2 }),
      f({ legs: 'tucked', dy: -1, quarter: 1, hold: 2 }),
      f({ legs: 'tucked', dy: -1, quarter: 2, hold: 2 }),
      f({ legs: 'tucked', dy: -1, quarter: 3, hold: 2 }),
      f({ legs: 'tucked', hold: 1 }),
      f({ marks: ['sparkle'], hold: 3 }),
      f({ hold: 1 }),
    ],
  },
  /** The user just sent a message: a little hop, then a happy look up at it. */
  face: {
    once: true,
    loop: [f({ legs: 'tucked', dy: -1, hold: 2 }), f({ eye: 'up', hold: 4 }), f({ eye: 'happy', hold: 6 }), f({ hold: 1 })],
  },
});
export type PoseName = keyof typeof POSES;
export const POSE_NAMES = Object.keys(POSES) as readonly PoseName[];

export const framesOf = <F>(pose: Pose<F>): readonly F[] => [...(pose.intro ?? []), ...pose.loop];

const ticksOf = (frames: readonly { readonly hold?: number }[]): number => frames.reduce((sum, frame) => sum + (frame.hold ?? 1), 0);

/**
 * The frame `t` ticks into a pose: its intro once when `intro`, then its loop, which a `once` pose plays once and
 * then holds on its last frame. `cycled` says the pose has played through once; `ended`, that a `once` pose is over.
 */
export function playhead<F extends { readonly hold?: number }>(pose: Pose<F>, t: number, intro: boolean): { readonly frame: F; readonly cycled: boolean; readonly ended: boolean } {
  const opening = intro ? (pose.intro ?? []) : [];
  const loop = ticksOf(pose.loop);
  const cycled = t >= ticksOf(opening) + loop;
  if (pose.once === true && cycled) return { frame: pose.loop.at(-1)!, cycled, ended: true };
  let at = t < ticksOf(opening) ? t : (t - ticksOf(opening)) % loop;
  for (const frame of t < ticksOf(opening) ? opening : pose.loop) {
    at -= frame.hold ?? 1;
    if (at < 0) return { frame, cycled, ended: false };
  }
  return { frame: pose.loop[0]!, cycled, ended: false };
}

const blank = (): string[][] => Array.from({ length: SIZE }, () => Array<string>(SIZE).fill('.'));

function paint(cells: string[][], stamps: readonly Stamp[]): void {
  for (const { x, y, art } of stamps)
    art.forEach((line, row) =>
      [...line].forEach((ink, col) => {
        if (ink === '.') return;
        const target = cells[y + row];
        if (target === undefined || x + col < 0 || x + col >= SIZE) throw new Error(`a stamp at ${x},${y} reaches outside the grid`);
        target[x + col] = ink;
      }),
    );
}

function shift(grid: Grid, dy: number): Grid {
  if (dy === 0) return grid;
  const leaving = dy > 0 ? grid.slice(SIZE - dy) : grid.slice(0, -dy);
  if (leaving.some((row) => row !== '.'.repeat(SIZE))) throw new Error(`shifting by ${dy} moves pixels outside the grid`);
  const empty = Array<string>(Math.abs(dy)).fill('.'.repeat(SIZE));
  return dy > 0 ? [...empty, ...grid.slice(0, SIZE - dy)] : [...grid.slice(-dy), ...empty];
}

/** A quarter turn clockwise. Pixels move whole, so the sprite stays crisp at any angle. */
export const rotate = (grid: Grid): Grid => grid.map((_, y) => grid.map((_, x) => grid[SIZE - 1 - x]![y]!).join(''));

export const flip = (grid: Grid): Grid => grid.map((row) => [...row].reverse().join(''));

export const crop = (grid: Grid, area: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): Grid =>
  grid.slice(area.y, area.y + area.height).map((row) => row.slice(area.x, area.x + area.width));

export function compose(frame: Frame): Grid {
  const cells = BODIES[frame.body ?? 'four'].map((row) => [...row]);
  const prop = frame.prop === undefined ? [] : (PROPS[frame.prop.kind] as (p: Prop) => readonly Stamp[])(frame.prop);
  paint(cells, [
    ...TAILS[frame.tail],
    ...LEGS[frame.legs],
    ...(frame.glasses === true ? GLASSES : []),
    ...EYES[frame.eye],
    ...prop,
    ...ARMS[frame.arms],
    ...(frame.marks ?? []).flatMap((mark) => MARKS[mark]),
  ]);
  let grid: Grid = shift(
    cells.map((row) => row.join('')),
    frame.dy ?? 0,
  );
  for (let i = 0; i < (frame.quarter ?? 0); i++) grid = rotate(grid);
  return frame.flip === true ? flip(grid) : grid;
}

/** The grid as SVG, one rect per run of a color in a row: the still avatar the build bakes into the panel. */
export function svgOf(grid: Grid): string {
  const rects = grid.flatMap((row, y) =>
    [...row.matchAll(/([^.])\1*/g)].map(
      (run) => `<rect x="${run.index}" y="${y}" width="${run[0].length}" height="1" fill="${PALETTE[run[1] as Ink]}"/>`,
    ),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${grid[0]!.length}" height="${grid.length}" viewBox="0 0 ${grid[0]!.length} ${grid.length}" shape-rendering="crispEdges">${rects.join('')}</svg>`;
}

/**
 * The peek: Noodle leaning on the composer's top edge, the grid's last row. One body, from the head down the neck
 * to the shoulders and the chest with its white belly, cut off by the edge; the forelegs and paws are drawn per frame.
 */
const PEEK_BODY: Grid = [
  ...BODY.slice(0, 12),
  '...........gggggggg.....',
  '..........gggggggggg....',
  ...Array<string>(10).fill('............gwwwwg......'),
];

/** The foreleg from the right shoulder, three pixels thick, braced outward, apart from the chest. */
const FORELEG = ['ggg.', 'ggg.', 'gggg', '.ggg', '.ggg', '.ggg', '.ggg'];
/** A wide forepaw seen from the front, its toes hooked over the edge, a darker green between them. */
const PAW = ['ggggg', 'ggggg', 'gdgdg'];
/** The paw turned up to wave, its toes spread. */
const PALM = ['g.g.g', 'ggggg', 'ggggg'];

/**
 * Where a paw is: hooked over the edge, lifted a row off it, let go (the leg hangs past the edge), or waving above
 * the shoulder in one of two places. Drawn for the right side; the left side is its mirror about the chest.
 */
const HANDS = parts({
  grip: [
    { x: 19, y: 13, art: [...FORELEG, '.ggg'] },
    { x: 19, y: 21, art: PAW },
  ],
  lift: [
    { x: 19, y: 13, art: FORELEG },
    { x: 19, y: 20, art: PAW },
  ],
  off: [{ x: 19, y: 13, art: [...FORELEG, '.ggg', '.ggg', '.ggg', '.ggg'] }],
  waveA: [
    { x: 19, y: 8, art: PALM },
    { x: 19, y: 11, art: ['ggg', 'ggg', 'ggg'] },
  ],
  waveB: [
    { x: 18, y: 9, art: PALM },
    { x: 19, y: 12, art: ['gg.', 'ggg'] },
  ],
});
export type Hand = keyof typeof HANDS;

/** The chest's middle column, doubled: the left paw is the right one mirrored about it. */
const CHEST_MIRROR = 29;
const mirrored = (stamps: readonly Stamp[]): Stamp[] =>
  stamps.map(({ x, y, art }) => ({ x: CHEST_MIRROR - (x + art[0]!.length - 1), y, art: art.map((line) => [...line].reverse().join('')) }));

/** One picture of the peek. `sink` is how many rows the whole body sits below its full climb; the composer hides what passes its edge. */
export type PeekFrame = {
  readonly eye: Eye;
  readonly left: Hand;
  readonly right: Hand;
  readonly sink?: number;
  /** The eye looks toward the pointer, which the view knows, instead of `eye`. */
  readonly toPointer?: true;
  readonly hold?: number;
};

export function composePeek(frame: PeekFrame): Grid {
  const cells = PEEK_BODY.map((row) => [...row]);
  paint(cells, [...mirrored(HANDS[frame.left]), ...HANDS[frame.right], ...EYES[frame.eye]]);
  return cells.map((row) => row.join(''));
}

const GRIPPING: PeekFrame = { eye: 'open', left: 'grip', right: 'grip' };
const p = (over: Partial<PeekFrame>): PeekFrame => ({ ...GRIPPING, ...over });
const LET_GO: PeekFrame = { ...GRIPPING, left: 'off', right: 'off' };

/** The peek's moves, each a row; the view picks which plays and when. */
export const PEEK_MOVES = {
  climb: {
    once: true,
    loop: [
      ...[24, 20, 16, 12, 8, 5, 3, 1].map((sink) => ({ ...LET_GO, sink })),
      p({ hold: 3 }),
      p({ eye: 'blink', hold: 2 }),
      p({ hold: 3 }),
    ],
  },
  /** While the user types: eyes down toward the text, with a blink now and then. */
  typing: { loop: [p({ eye: 'downLeft', hold: 40 }), p({ eye: 'blink', hold: 2 })] },
  lookAround: { once: true, loop: [p({ eye: 'left', hold: 8 }), p({ eye: 'open', hold: 8 }), p({ toPointer: true, hold: 12 })] },
  drum: {
    once: true,
    loop: [1, 2, 3].flatMap(() => [p({ eye: 'downLeft', left: 'lift', hold: 2 }), p({ eye: 'downLeft', hold: 1 }), p({ eye: 'downLeft', right: 'lift', hold: 2 }), p({ eye: 'downLeft', hold: 1 })]),
  },
  wave: {
    once: true,
    loop: [...[1, 2, 3].flatMap(() => [p({ eye: 'happy', right: 'waveA', hold: 3 }), p({ eye: 'happy', right: 'waveB', hold: 3 })]), p({ hold: 2 })],
  },
  /** The hands let go, then the whole body slides down behind the composer. */
  duck: { once: true, loop: [{ ...LET_GO, hold: 2 }, ...[4, 10, 16, 24].map((sink) => ({ ...LET_GO, sink }))] },
} as const satisfies Record<string, Pose<PeekFrame>>;
export type PeekMove = keyof typeof PEEK_MOVES;
