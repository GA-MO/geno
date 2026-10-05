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

const EYES = {
  open: [{ x: 17, y: 3, art: ['wk'] }],
  blink: [{ x: 17, y: 3, art: ['kk'] }],
  left: [{ x: 17, y: 3, art: ['kw'] }],
  down: [{ x: 17, y: 4, art: ['wk'] }],
  downLeft: [{ x: 17, y: 4, art: ['kw'] }],
  up: [{ x: 17, y: 2, art: ['wk'] }],
  upLeft: [{ x: 17, y: 2, art: ['kw'] }],
  happy: [{ x: 16, y: 3, art: ['.kk.', 'k..k'] }],
} as const satisfies Record<string, readonly Stamp[]>;
export type Eye = keyof typeof EYES;

const TAILS = {
  down: [{ x: 0, y: 14, art: ['ggg', 'ggg'] }],
  up: [{ x: 0, y: 11, art: ['g..', 'gg.', 'ggg'] }],
} as const satisfies Record<string, readonly Stamp[]>;
export type Tail = keyof typeof TAILS;

const LEGS = {
  stand: [{ x: 4, y: 19, art: ['ggg......ggg', 'ggg......ggg', 'ggg......ggg'] }],
  stepA: [{ x: 2, y: 19, art: ['..ggg......ggg', '.ggg........ggg', 'ggg..........ggg'] }],
  stepB: [{ x: 2, y: 19, art: ['..ggg......ggg', '...ggg....ggg', '....ggg..ggg'] }],
  tucked: [{ x: 4, y: 19, art: ['ggg......ggg', '.ggg......ggg'] }],
  /** Sitting: drawn under a body lowered two rows, the feet forward. */
  folded: [{ x: 4, y: 19, art: ['gggggg...gggggg'] }],
} as const satisfies Record<string, readonly Stamp[]>;
export type Legs = keyof typeof LEGS;

const ARMS = {
  none: [],
  half: [{ x: 18, y: 14, art: ['gg'] }],
  up: [{ x: 18, y: 11, art: ['.g', '.g', 'g.'] }],
  out: [{ x: 18, y: 12, art: ['..g', '.g.', 'g..'] }],
  flex: [
    { x: 10, y: 9, art: ['g..', 'g..', 'ggg'] },
    { x: 18, y: 10, art: ['..g', '..g', 'ggg'] },
  ],
  /** Typing: the hand down on the keys, then lifted. */
  tapA: [{ x: 18, y: 16, art: ['g', 'g'] }],
  tapB: [{ x: 18, y: 15, art: ['g', 'g'] }],
} as const satisfies Record<string, readonly Stamp[]>;
export type Arms = keyof typeof ARMS;

const MARKS = {
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
} as const satisfies Record<string, readonly Stamp[]>;
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
    { x: 17 + pencil * 2, y: 13, art: ['..y', '.y.', 'k..'] },
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
export type Pose = { readonly intro?: readonly Frame[]; readonly loop: readonly Frame[]; readonly once?: true };

export const STAND: Frame = { eye: 'open', tail: 'down', legs: 'stand', arms: 'none' };
const f = (over: Partial<Frame>): Frame => ({ ...STAND, ...over });

const laptop = (rise: number, lid: number, lines = 0): Prop => ({ kind: 'laptop', rise, lid, lines });

export const POSES = {
  idle: {
    loop: [f({ hold: 30 }), f({ eye: 'blink', hold: 2 }), f({ hold: 20 }), f({ tail: 'up', hold: 3 }), f({ hold: 4 }), f({ tail: 'up', hold: 3 }), f({ hold: 10 })],
  },
  thinking: {
    loop: [f({ eye: 'up', hold: 4 }), f({ eye: 'up', marks: ['dots1'], hold: 4 }), f({ eye: 'up', marks: ['dots2'], hold: 4 }), f({ eye: 'up', marks: ['dots3'], hold: 6 })],
  },
  reading: {
    loop: [
      f({ eye: 'down', prop: { kind: 'notebook', page: 0 }, hold: 6 }),
      f({ eye: 'downLeft', prop: { kind: 'notebook', page: 0 }, hold: 6 }),
      f({ eye: 'down', prop: { kind: 'notebook', page: 0 }, hold: 6 }),
      f({ eye: 'downLeft', prop: { kind: 'notebook', page: 0 }, hold: 6 }),
      f({ eye: 'down', prop: { kind: 'notebook', page: 1 }, hold: 3 }),
    ],
  },
  coding: {
    intro: [
      f({ eye: 'down', prop: laptop(3, 0), hold: 2 }),
      f({ eye: 'down', prop: laptop(2, 0), hold: 2 }),
      f({ eye: 'down', prop: laptop(1, 0), hold: 2 }),
      f({ eye: 'down', prop: laptop(0, 0), hold: 2 }),
      f({ eye: 'down', prop: laptop(0, 2) }),
      f({ eye: 'down', prop: laptop(0, 4) }),
      f({ eye: 'down', prop: laptop(0, 6), hold: 3 }),
      f({ eye: 'down', prop: laptop(0, 6), glasses: true, hold: 4 }),
    ],
    loop: [1, 2, 3, 4, 4, 4].flatMap((lines) => [
      f({ eye: 'down', glasses: true, arms: 'tapA', prop: laptop(0, 6, lines), hold: 2 }),
      f({ eye: 'down', glasses: true, arms: 'tapB', prop: laptop(0, 6, lines), hold: 2 }),
    ]),
  },
  writing: {
    loop: ([0, 1, 2, 1] as const).map((pencil) => f({ eye: 'down', prop: { kind: 'pad', pencil }, hold: 3 })),
  },
  running: {
    loop: [f({ legs: 'stepA', marks: ['dust'] }), f({ legs: 'stepB', dy: -1 }), f({ legs: 'stepA' }), f({ legs: 'stepB', dy: -1, marks: ['dust'] })],
  },
  planning: {
    loop: [0, 1, 2, 3].map((ticks) => f({ eye: 'down', prop: { kind: 'clipboard', ticks }, hold: ticks === 3 ? 10 : 6 })),
  },
  asking: {
    loop: [f({ eye: 'up', marks: ['question'], hold: 4 }), f({ eye: 'up', marks: ['question'], dy: -1, hold: 4 })],
  },
  hop: {
    once: true,
    loop: [f({ legs: 'tucked', dy: -1, hold: 2 }), f({ legs: 'tucked', dy: -1, marks: ['sparkle'], hold: 2 }), f({ marks: ['sparkle'], hold: 3 }), f({ hold: 1 })],
  },
  flex: {
    once: true,
    loop: [
      f({ arms: 'flex', eye: 'happy', hold: 2 }),
      f({ arms: 'flex', eye: 'happy', marks: ['sparkle'], hold: 3 }),
      f({ arms: 'flex', eye: 'happy', hold: 2 }),
      f({ arms: 'flex', eye: 'happy', marks: ['sparkle'], hold: 3 }),
      f({ hold: 1 }),
    ],
  },
  sweat: {
    loop: [f({ marks: ['sweat'], hold: 12 }), f({ eye: 'blink', marks: ['sweat'], hold: 2 })],
  },
  /** The user just sent a message: a little hop, then a happy look up at it. */
  face: {
    once: true,
    loop: [f({ legs: 'tucked', dy: -1, hold: 2 }), f({ eye: 'up', hold: 4 }), f({ eye: 'happy', hold: 6 }), f({ hold: 1 })],
  },
} as const satisfies Record<string, Pose>;
export type PoseName = keyof typeof POSES;
export const POSE_NAMES = Object.keys(POSES) as readonly PoseName[];

export const framesOf = (pose: Pose): readonly Frame[] => [...(pose.intro ?? []), ...pose.loop];

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
  const cells = BODY.map((row) => [...row]);
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
