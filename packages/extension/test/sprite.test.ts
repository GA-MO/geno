import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DINO_FILES } from '../src/dino.js';
import { compose, composePeek, crop, flip, framesOf, PALETTE, PEEK_MOVES, POSE_NAMES, POSES, rotate, SIZE, svgOf, type Frame, type Grid, type PeekFrame } from '../src/chat/sprite.js';

const STAND: Frame = { eye: 'open', tail: 'down', legs: 'stand', arms: 'none' };

/** The avatar file's pixels as `x,y #hex`, from its whole-pixel rects. */
async function avatarPixels(): Promise<string[]> {
  const svg = await readFile(path.resolve('packages/extension', DINO_FILES.avatar), 'utf8');
  return [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="(#[0-9a-f]{6})"\/>/gi)].flatMap(([, x, y, w, h, fill]) =>
    Array.from({ length: Number(w) * Number(h) }, (_, i) => `${Number(x) + (i % Number(w))},${Number(y) + Math.floor(i / Number(w))} ${fill!.toLowerCase()}`),
  );
}

const pixelsOf = (grid: Grid): string[] =>
  grid.flatMap((row, y) => [...row].flatMap((ink, x) => (ink === '.' ? [] : [`${x},${y} ${PALETTE[ink as keyof typeof PALETTE]}`])));

const inks = (grid: Grid): Set<string> => new Set(grid.join('').replaceAll('.', ''));

describe('the sprite', () => {
  it('stands as the Box A avatar: the idle pose first frame is the avatar file, pixel for pixel', async () => {
    expect(pixelsOf(compose(POSES.idle.loop[0]!)).sort()).toEqual((await avatarPixels()).sort());
  });

  it('has every pose the brief names, each with frames', () => {
    expect([...POSE_NAMES].sort()).toEqual(['asking', 'coding', 'face', 'flex', 'hop', 'idle', 'planning', 'reading', 'running', 'somersault', 'sweat', 'thinking', 'writing']);
    for (const name of POSE_NAMES) expect(POSES[name].loop.length, name).toBeGreaterThan(0);
  });

  it('draws every frame of every pose inside the 24 by 24 grid, in the palette only', () => {
    for (const name of POSE_NAMES)
      for (const frame of framesOf(POSES[name])) {
        const grid = compose(frame);
        expect(grid).toHaveLength(SIZE);
        for (const row of grid) expect(row).toHaveLength(SIZE);
        for (const ink of inks(grid)) expect(Object.keys(PALETTE), `${name} uses ${ink}`).toContain(ink);
      }
  });

  it('refuses a frame shifted so far that pixels would leave the grid', () => {
    expect(() => compose({ ...STAND, dy: -2 })).toThrow(/outside/);
    expect(() => compose({ ...STAND, dy: 3 })).toThrow(/outside/);
  });

  it('closes the eye to a dark line for a blink, and only the eye changes', () => {
    const open = compose(STAND);
    const shut = compose({ ...STAND, eye: 'blink' });
    const changed = pixelsOf(shut).filter((p) => !pixelsOf(open).includes(p));
    expect(changed).toEqual(['17,3 #14231f']);
    expect(pixelsOf(shut).filter((p) => p.endsWith('#ffffff') && p.startsWith('17,3'))).toEqual([]);
  });

  it('pulls the laptop up, opens its lid, puts on glasses, then fills the screen with code while typing', () => {
    const { intro, loop } = POSES.coding;
    const laptopRows = (frame: Frame) => compose(frame).filter((row) => row.includes('s')).length;
    expect(intro!.length).toBeGreaterThan(4);
    const heights = intro!.map(laptopRows);
    // Rising from below, then the lid opening: the laptop only grows.
    for (let i = 1; i < heights.length; i++) expect(heights[i]!).toBeGreaterThanOrEqual(heights[i - 1]!);
    expect(heights.at(-1)!).toBeGreaterThan(heights[0]!);
    expect(intro!.at(-1)!.glasses).toBe(true);
    expect(intro!.slice(0, 2).every((f) => f.glasses !== true)).toBe(true);
    const code = loop.map((frame) => compose(frame).join('').match(/[rcy]/g)?.length ?? 0);
    expect(Math.max(...code)).toBeGreaterThan(Math.min(...code));
    expect(new Set(loop.map((f) => f.arms)).size).toBeGreaterThan(1);
  });

  it('reads with an open notebook whose pages turn, eyes scanning', () => {
    const { loop } = POSES.reading;
    expect(new Set(loop.map((f) => JSON.stringify(f.prop))).size).toBeGreaterThan(1);
    expect(new Set(loop.map((f) => f.eye)).size).toBeGreaterThan(1);
    expect(loop.every((f) => f.prop?.kind === 'notebook')).toBe(true);
  });

  it('writes with a pencil that moves, plans with ticks that appear, and runs with dust and a bob', () => {
    expect(new Set(POSES.writing.loop.map((f) => (f.prop?.kind === 'pad' ? f.prop.pencil : -1))).size).toBeGreaterThan(1);
    const ticks = POSES.planning.loop.map((f) => (f.prop?.kind === 'clipboard' ? f.prop.ticks : -1));
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
    expect(Math.max(...ticks)).toBeGreaterThan(0);
    expect(POSES.running.loop.some((f) => f.marks?.includes('dust'))).toBe(true);
    expect(new Set(POSES.running.loop.map((f) => f.dy ?? 0)).size).toBe(2);
  });

  it('marks thinking with dots, asking with a question mark, a failed step with sweat', () => {
    expect(POSES.thinking.loop.some((f) => f.marks?.includes('dots3'))).toBe(true);
    expect(POSES.asking.loop.every((f) => f.marks?.includes('question'))).toBe(true);
    expect(POSES.sweat.loop.every((f) => f.marks?.includes('sweat'))).toBe(true);
    expect(inks(compose(POSES.asking.loop[0]!)).has('a')).toBe(true);
    expect(inks(compose(POSES.sweat.loop[0]!)).has('b')).toBe(true);
  });

  it('flexes with both arms up, happy eyes and a sparkle; the hop sparkles too; both play once', () => {
    const flexed = POSES.flex.loop[0]!;
    expect([flexed.arms, flexed.eye]).toEqual(['flex', 'happy']);
    expect(POSES.flex.loop.some((f) => f.marks?.includes('sparkle'))).toBe(true);
    expect(POSES.hop.loop.some((f) => f.marks?.includes('sparkle'))).toBe(true);
    expect([POSES.flex.once, POSES.hop.once, POSES.face.once, POSES.idle.once]).toEqual([true, true, true, undefined]);
  });

  it('somersaults once, in the air, through every quarter turn, and lands upright', () => {
    const { loop, once } = POSES.somersault;
    expect(once).toBe(true);
    expect(new Set(loop.map((f) => f.quarter ?? 0))).toEqual(new Set([0, 1, 2, 3]));
    expect(loop.filter((f) => (f.quarter ?? 0) > 0).every((f) => f.dy === -1 && f.legs === 'tucked')).toBe(true);
    expect(loop.at(-1)!.quarter ?? 0).toBe(0);
    expect(compose(loop.at(-1)!)).toEqual(compose(STAND));
  });

  it('turns in whole quarter turns and mirrors without losing or blending a pixel', () => {
    const grid = compose(STAND);
    expect(rotate(rotate(rotate(rotate(grid))))).toEqual(grid);
    expect(rotate(grid)).not.toEqual(grid);
    expect(pixelsOf(rotate(grid)).length).toBe(pixelsOf(grid).length);
    expect(flip(flip(grid))).toEqual(grid);
    expect(flip(grid)[3]![23 - 18]).toBe('k');
    expect(compose({ ...STAND, flip: true })).toEqual(flip(grid));
    expect(compose({ ...STAND, quarter: 1 })).toEqual(rotate(grid));
  });

  it('crops the head for the peek: rows 0 to 11 only', () => {
    const head = crop(compose(STAND), { x: 12, y: 0, width: 12, height: 12 });
    expect(head).toHaveLength(12);
    expect(head.every((row) => row.length === 12)).toBe(true);
    expect(head[3]!.slice(5, 7)).toBe('wk');
  });

  it('writes an SVG of whole-pixel rects in the palette, which draws the avatar file again', async () => {
    const svg = svgOf(compose(STAND));
    expect(svg).toMatch(/^<svg [^>]*viewBox="0 0 24 24"[^>]*shape-rendering="crispEdges"/);
    const cells = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="1" fill="(#[0-9a-f]{6})"\/>/g)].flatMap(([, x, y, w, fill]) =>
      Array.from({ length: Number(w) }, (_, i) => `${Number(x) + i},${y} ${fill}`),
    );
    expect(cells.sort()).toEqual((await avatarPixels()).sort());
  });
});

const GRIP: PeekFrame = { eye: 'open', left: 'grip', right: 'grip' };

/** The grid's coloured pixels, grouped by touching sides: one group is one connected body. */
function bodies(grid: Grid): number {
  const seen = new Set<string>();
  let groups = 0;
  grid.forEach((row, y) =>
    [...row].forEach((ink, x) => {
      if (ink === '.' || seen.has(`${x},${y}`)) return;
      groups++;
      const stack = [[x, y]];
      while (stack.length > 0) {
        const [cx, cy] = stack.pop()!;
        const key = `${cx},${cy}`;
        if (seen.has(key) || grid[cy!]?.[cx!] === undefined || grid[cy!]![cx!] === '.') continue;
        seen.add(key);
        stack.push([cx! + 1, cy!], [cx! - 1, cy!], [cx!, cy! + 1], [cx!, cy! - 1]);
      }
    }),
  );
  return groups;
}

describe('the peek over the composer', () => {
  it('is one connected body: head, neck, chest with a white belly, arms, and two 3 by 2 hands with darker knuckles on the edge', () => {
    const grid = composePeek(GRIP);
    expect(grid).toHaveLength(SIZE);
    expect(bodies(grid)).toBe(1);
    expect(PALETTE.d).toBe('#4fae86');
    // The hands sit on the bottom two rows, the composer's edge, one each side of the chest.
    const hands = grid.slice(SIZE - 2).map((row) => [...row.matchAll(/[gd]{3}/g)].map((m) => `${m.index}:${m[0]}`));
    expect(hands).toEqual([
      ['6:dgd', '21:dgd'],
      ['6:ggg', '21:ggg'],
    ]);
    expect(grid[SIZE - 3]!.slice(10, 20)).toBe('ggwwwwwwgg');
    expect(grid[3]!.slice(17, 19)).toBe('wk');
    // Outside the chest, only the hands reach the edge.
    expect([grid[SIZE - 1]!.slice(0, 10), grid[SIZE - 1]!.slice(20)]).toEqual(['......ggg.', '.ggg']);
  });

  it('has the moves the brief keeps: climb, typing, look around, drum, wave and duck', () => {
    expect(Object.keys(PEEK_MOVES).sort()).toEqual(['climb', 'drum', 'duck', 'lookAround', 'typing', 'wave']);
    expect('once' in PEEK_MOVES.typing).toBe(false);
    for (const name of ['climb', 'drum', 'duck', 'lookAround', 'wave'] as const) expect(PEEK_MOVES[name].once, name).toBe(true);
  });

  it('draws every frame of every move inside the grid, in the palette, as one body', () => {
    for (const [name, move] of Object.entries(PEEK_MOVES))
      for (const frame of framesOf(move)) {
        const grid = composePeek(frame);
        expect(grid.every((row) => row.length === SIZE), name).toBe(true);
        for (const ink of inks(grid)) expect(Object.keys(PALETTE), `${name} uses ${ink}`).toContain(ink);
        expect(bodies(grid), `${name} ${JSON.stringify(frame)}`).toBe(1);
      }
  });

  it('climbs: the body rises from below the edge, the hands land on it, then it blinks', () => {
    const sinks = PEEK_MOVES.climb.loop.map((f) => f.sink ?? 0);
    expect(sinks[0]).toBeGreaterThanOrEqual(SIZE - 1);
    expect(sinks).toEqual([...sinks].sort((a, b) => b - a));
    const landed = PEEK_MOVES.climb.loop.findIndex((f) => f.left === 'grip' && f.right === 'grip');
    expect(PEEK_MOVES.climb.loop.slice(0, landed).every((f) => f.left === 'off' && f.right === 'off')).toBe(true);
    expect(PEEK_MOVES.climb.loop.slice(landed).every((f) => (f.sink ?? 0) === 0)).toBe(true);
    expect(PEEK_MOVES.climb.loop.slice(landed).some((f) => f.eye === 'blink')).toBe(true);
  });

  it('ducks: the hands let go first, then the whole body slides below the edge', () => {
    const { loop } = PEEK_MOVES.duck;
    expect([loop[0]!.left, loop[0]!.right, loop[0]!.sink ?? 0]).toEqual(['off', 'off', 0]);
    expect(loop.at(-1)!.sink).toBeGreaterThanOrEqual(SIZE);
    expect(loop.every((f) => f.left === 'off' && f.right === 'off')).toBe(true);
  });

  it('looks down toward the text while typing, with a blink; waves one hand with happy eyes; drums each hand in turn', () => {
    expect(new Set(PEEK_MOVES.typing.loop.map((f) => f.eye))).toEqual(new Set(['downLeft', 'blink']));
    const waving = PEEK_MOVES.wave.loop.filter((f) => f.right.startsWith('wave'));
    expect(new Set(waving.map((f) => f.right)).size).toBe(2);
    expect(waving.every((f) => f.eye === 'happy' && f.left === 'grip')).toBe(true);
    expect(PEEK_MOVES.drum.loop.some((f) => f.left === 'lift' && f.right === 'grip')).toBe(true);
    expect(PEEK_MOVES.drum.loop.some((f) => f.left === 'grip' && f.right === 'lift')).toBe(true);
    expect(PEEK_MOVES.lookAround.loop.map((f) => f.eye).slice(0, 2)).toEqual(['left', 'open']);
    expect(PEEK_MOVES.lookAround.loop.at(-1)!.toPointer).toBe(true);
    for (const name of ['wave', 'drum', 'lookAround'] as const) expect(PEEK_MOVES[name].loop.at(-1)!.sink ?? 0, name).toBe(0);
  });
});
