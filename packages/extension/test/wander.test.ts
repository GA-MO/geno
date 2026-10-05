import { describe, expect, it } from 'vitest';
import { compose } from '../src/chat/sprite.js';
import { begin, frameOf, MOVE_NAMES, MOVES, next, pickMove, poke, SPRITE_PX, TICK_MS, type Scene } from '../src/chat/wander.js';

const STAGE = { width: 400 };
/** A random source that always says the same, so a move runs its shortest length and the next pick is the first. */
const fixed = (value: number) => () => value;

const scene = (over: Partial<Scene>): Scene => ({ x: 100, y: 0, vy: 0, facing: 1, move: 'walk', t: 0, ticks: 40, ...over });

/** Runs `n` ticks and returns every scene along the way. */
function run(from: Scene, n: number, random = fixed(0)): Scene[] {
  const seen = [from];
  for (let i = 0; i < n; i++) seen.push(next(seen.at(-1)!, STAGE, random));
  return seen;
}

describe('the start page dino', () => {
  it('ticks at about 70 ms', () => {
    expect(TICK_MS).toBe(70);
  });

  it('picks its next move by weight: walk 5, run 2, sit 2, and jump, somersault, wave, flex and turn 1 each', () => {
    const counts: Record<string, number> = {};
    const total = Object.values(MOVES).reduce((sum, move) => sum + move.weight, 0);
    expect(total).toBe(14);
    for (let i = 0; i < total; i++) {
      const name = pickMove(fixed((i + 0.5) / total));
      counts[name] = (counts[name] ?? 0) + 1;
    }
    expect(counts).toEqual({ walk: 5, run: 2, jump: 1, somersault: 1, sit: 2, wave: 1, flex: 1, turn: 1 });
    expect([...MOVE_NAMES].sort()).toEqual(Object.keys(counts).sort());
  });

  it('walks 2 px a tick and runs 5, the way it faces', () => {
    const walk = run(scene({ move: 'walk' }), 3);
    expect(walk.map((s) => s.x)).toEqual([100, 102, 104, 106]);
    const back = run(scene({ move: 'walk', facing: -1 }), 2);
    expect(back.map((s) => s.x)).toEqual([100, 98, 96]);
    const dash = run(scene({ move: 'run', ticks: 20 }), 2);
    expect(dash.map((s) => s.x)).toEqual([100, 105, 110]);
  });

  it('turns at the panel edge: a 2-pixel hop, mirrored from the fourth frame, then walks back', () => {
    const edge = STAGE.width - SPRITE_PX;
    const seen = run(scene({ move: 'run', x: edge - 3, ticks: 20 }), 12);
    const turnAt = seen.findIndex((s) => s.move === 'turn');
    expect(turnAt).toBeGreaterThan(0);
    expect(Math.max(...seen.map((s) => s.x))).toBeLessThanOrEqual(edge);
    const turn = seen.filter((s) => s.move === 'turn');
    expect(turn.map((s) => s.t)).toEqual(turn.map((_, i) => i));
    expect(turn.map((s) => s.facing)).toEqual(turn.map((s) => (s.t < 3 ? 1 : -1)));
    expect(Math.max(...turn.map((s) => s.y))).toBe(8);
    expect(frameOf(turn[3]!).flip).toBe(true);
    expect(frameOf(turn[2]!).flip).not.toBe(true);
    const after = seen.slice(turnAt + turn.length);
    expect(after[0]!.move).toBe('walk');
    expect(after.at(-1)!.x).toBeLessThan(after[0]!.x);
  });

  it('jumps under gravity: up, down, and lands, legs tucked in the air, then picks another move', () => {
    const seen = run(begin(scene({}), 'jump', fixed(0)), 40);
    const air = seen.filter((s) => s.move === 'jump' && s.y > 0);
    expect(air.length).toBeGreaterThan(4);
    const peak = air.reduce((top, s) => Math.max(top, s.y), 0);
    expect(peak).toBeGreaterThan(20);
    expect(air.every((s) => frameOf(s).legs === 'tucked')).toBe(true);
    const landed = seen.findIndex((s, i) => i > 0 && s.move !== 'jump');
    expect(landed).toBeGreaterThan(0);
    expect(seen[landed]!.y).toBe(0);
  });

  it('somersaults through all four quarter turns in the air and lands upright', () => {
    const seen = run(begin(scene({}), 'somersault', fixed(0)), 40);
    const air = seen.filter((s) => s.move === 'somersault');
    expect(new Set(air.map((s) => frameOf(s).quarter ?? 0))).toEqual(new Set([0, 1, 2, 3]));
    const quarters = air.map((s) => frameOf(s).quarter ?? 0);
    expect(quarters).toEqual([...quarters].sort());
    const after = seen.find((s, i) => i > 0 && s.move !== 'somersault')!;
    expect(after.y).toBe(0);
    expect(frameOf(after).quarter ?? 0).toBe(0);
    for (const s of air) expect(() => compose(frameOf(s))).not.toThrow();
  });

  it('sits two rows lower with its legs folded, blinking and flicking its tail', () => {
    const seen = run(begin(scene({}), 'sit', fixed(0)), 60).filter((s) => s.move === 'sit');
    const frames = seen.map(frameOf);
    expect(frames.every((f) => f.dy === 2 && f.legs === 'folded')).toBe(true);
    expect(frames.some((f) => f.eye === 'blink')).toBe(true);
    expect(frames.some((f) => f.tail === 'up')).toBe(true);
    expect(seen.every((s) => s.x === 100)).toBe(true);
  });

  it('waves one arm, alternating, and flexes both arms with happy eyes and a sparkle', () => {
    const wave = run(begin(scene({}), 'wave', fixed(0)), 12).filter((s) => s.move === 'wave').map(frameOf);
    expect(new Set(wave.map((f) => f.arms))).toEqual(new Set(['up', 'out']));
    const flex = run(begin(scene({}), 'flex', fixed(0)), 12).filter((s) => s.move === 'flex').map(frameOf);
    expect(flex.every((f) => f.arms === 'flex' && f.eye === 'happy')).toBe(true);
    expect(flex.some((f) => f.marks?.includes('sparkle'))).toBe(true);
  });

  it('somersaults when poked on the ground, and ignores a poke in the air', () => {
    expect(poke(scene({ move: 'walk' }), fixed(0)).move).toBe('somersault');
    const flying = scene({ move: 'jump', y: 20, vy: 4 });
    expect(poke(flying, fixed(0))).toBe(flying);
  });

  it('mirrors the whole sprite while it faces left', () => {
    expect(frameOf(scene({ facing: -1 })).flip).toBe(true);
    expect(frameOf(scene({ facing: 1 })).flip).not.toBe(true);
  });
});
