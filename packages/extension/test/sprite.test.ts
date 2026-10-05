import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DINO_FILES } from '../src/dino.js';
import { compose, crop, flip, framesOf, PALETTE, POSE_NAMES, POSES, rotate, SIZE, svgOf, type Frame, type Grid } from '../src/chat/sprite.js';

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
    expect([...POSE_NAMES].sort()).toEqual(['asking', 'coding', 'face', 'flex', 'hop', 'idle', 'planning', 'reading', 'running', 'sweat', 'thinking', 'writing']);
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
